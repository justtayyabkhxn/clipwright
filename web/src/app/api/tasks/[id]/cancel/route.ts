import { collections } from "@/server/db";
import { handle, json } from "@/server/http";
import { requestCancel } from "@/server/jobs";
import { requireUser } from "@/server/session";
import {
  casStatus,
  getTaskForUser,
  IDLE_STATUSES,
  RESTYLE_CANCELLED_MESSAGE,
  restyleRollback,
  runType,
} from "@/server/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * A pipeline run ends `cancelled`. A restyle keeps the old clips, so the task goes straight back to
 * `completed`; the restyle job then discards its own files without touching the task.
 */
export const POST = handle(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser(request);
  const task = await getTaskForUser(id, user.id);
  if (IDLE_STATUSES.includes(task.status)) {
    return json({ message: `Task already in terminal state: ${task.status}` });
  }
  // The run's job is authoritative: run.jobId always survives the worker's writes to `run`.
  const runJob = task.run?.jobId
    ? await collections().jobs.findOne({ _id: task.run.jobId }, { projection: { type: 1, payload: 1 } })
    : null;
  if ((runJob?.type ?? runType(task)) === "restyle_task") {
    // The old clips stay, and so do the settings they were rendered with.
    await casStatus(
      id,
      ["processing"],
      restyleRollback({ payload: runJob?.payload ?? {} }, RESTYLE_CANCELLED_MESSAGE),
      runJob ? { "run.jobId": runJob._id } : {},
    );
    await requestCancel({ taskId: id, type: "restyle_task" });
  } else {
    await casStatus(id, ["queued", "processing"], { status: "cancelled", progress: 0, progressMessage: "Cancelled by user" });
    await requestCancel({ taskId: id, type: "process_task" });
  }
  return json({ message: "Task cancellation requested" });
});
