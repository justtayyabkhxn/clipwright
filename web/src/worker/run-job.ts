// Dispatch one claimed job to its handler and finish it, plus the failure hooks the reaper runs
// when a job's worker died (DESIGN §6.1).

import fs from "node:fs/promises";
import path from "node:path";
import { collections } from "../server/db";
import { failPrepare } from "../server/drafts";
import { finishJob, onJobFailure, releaseJob, type FailureHook, type JobOutcome } from "../server/jobs";
import { casStatus, RESTYLE_FAILED_MESSAGE, restyleRollback, WORKER_STOPPED_TASK_MESSAGE } from "../server/tasks";
import type { JobDoc, JobType } from "../server/types";
import { cancelledOutcome, createJobContext, defaultDeps, errorMessage, type JobContext, type WorkerDeps } from "./context";
import { COMBINE_FAILED_MESSAGE, combineEditor } from "./handlers/combine-editor";
import { EXPORT_STOPPED_MESSAGE, exportClip } from "./handlers/export-clip";
import { EDITOR_EXPORT_FAILED_MESSAGE, exportEditor } from "./handlers/export-editor";
import { prepareEditor } from "./handlers/prepare-editor";
import { errorCodeFor, processTask } from "./handlers/process-task";
import { restyleTask } from "./handlers/restyle-task";

export type Handler = (ctx: JobContext) => Promise<JobOutcome>;

export const HANDLERS: Record<JobType, Handler> = {
  process_task: processTask,
  restyle_task: restyleTask,
  prepare_editor: prepareEditor,
  export_editor: exportEditor,
  combine_editor: combineEditor,
  export_clip: exportClip,
  // ponytail: placeholder until Task 8 implements the YouTube upload handler.
  publish_youtube: async () => {
    throw new Error("not implemented");
  },
};

/** The job is already failed by the reaper; give it the message its UI shows. */
const jobError =
  (error: string): FailureHook =>
  async (job) => {
    await collections().jobs.updateOne({ _id: job._id, status: "failed" }, { $set: { error } });
  };

// Every task write is guarded by run.jobId, so a dead job never clobbers a newer run of the task.
export const FAILURE_HOOKS: Record<JobType, FailureHook> = {
  process_task: async (job) => {
    await casStatus(
      job.taskId,
      ["queued", "processing"],
      {
        status: "error",
        progress: 0,
        progressMessage: WORKER_STOPPED_TASK_MESSAGE,
        "run.errorCode": errorCodeFor(WORKER_STOPPED_TASK_MESSAGE),
        "run.completedAt": new Date(),
      },
      { "run.jobId": job._id },
    );
  },
  restyle_task: async (job) => {
    await casStatus(job.taskId, ["processing"], restyleRollback(job, RESTYLE_FAILED_MESSAGE), { "run.jobId": job._id });
  },
  prepare_editor: (job) => failPrepare(job.clipId!, job._id),
  export_editor: jobError(EDITOR_EXPORT_FAILED_MESSAGE),
  combine_editor: jobError(COMBINE_FAILED_MESSAGE),
  export_clip: jobError(EXPORT_STOPPED_MESSAGE),
  // ponytail: placeholder until Task 8 implements the real failure hook.
  publish_youtube: async () => {
    throw new Error("not implemented");
  },
};

export function registerFailureHooks() {
  for (const [type, hook] of Object.entries(FAILURE_HOOKS)) onJobFailure(type as JobType, hook);
}

/**
 * Run a claimed job and record its outcome. A cancelled job is finished as cancelled, a job whose
 * lease was lost is left to its new holder, and on shutdown the job goes back to the queue.
 */
export async function runJob(job: JobDoc, deps: WorkerDeps = defaultDeps, shutdown?: AbortSignal): Promise<JobOutcome | null> {
  const ctx = await createJobContext(job, deps, shutdown);
  let outcome: JobOutcome | null = null;
  try {
    outcome = await HANDLERS[job.type](ctx);
  } catch (error) {
    if (!ctx.stopReason) {
      // Handlers map their own failures; this is a bug or an outage. Never leave the task busy.
      console.error(`[worker] ${job.type} job ${job._id} failed`, error);
      outcome = { status: "failed", error: errorMessage(error) };
      await FAILURE_HOOKS[job.type](job).catch((hookError) => console.error("[worker] Failure hook failed", hookError));
    }
  } finally {
    ctx.dispose();
    await fs
      .rm(ctx.workDir, { recursive: true, force: true, maxRetries: 3 })
      .catch((error) => console.warn(`[worker] Could not remove ${ctx.workDir} (the cron sweeps it)`, error));
    // The job's dir goes too unless another attempt of the job is using it (rmdir needs it empty).
    await fs.rmdir(path.dirname(ctx.workDir)).catch(() => {});
  }
  if (!outcome) {
    if (ctx.stopReason === "lost") return null;
    if (ctx.stopReason === "shutdown" && (await releaseJob(job))) return null;
    outcome = cancelledOutcome;
  }
  await finishJob(job, outcome);
  return outcome;
}
