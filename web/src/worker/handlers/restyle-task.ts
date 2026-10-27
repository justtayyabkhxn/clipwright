// restyle_task: port of regenerate_all_clips_for_task (clip_service.py:99-286). The route already
// saved the new settings and set "Applying new style..."; the old clips stay until one swap.

import path from "node:path";
import type { JobOutcome } from "../../server/jobs";
import { getStorage } from "../../server/storage";
import {
  casStatus,
  CLIP_DURATIONS,
  getTask,
  normalizeClipLength,
  replaceClips,
  RESTYLE_FAILED_MESSAGE,
  restyleRollback,
  secondsToMmss,
} from "../../server/tasks";
import type { ClipDoc } from "../../server/types";
import { lineageOf } from "../../server/youtube/posts";
import {
  cancelledOutcome,
  clipDocFrom,
  clipSourceRanges,
  errorMessage,
  renderOptions,
  sourceVideoPath,
  TaskCancelled,
  type EngineClip,
  type JobContext,
} from "../context";

/** Merged and trimmed clips can run past a short preset; never cap them below a minute. */
const MAX_RENDERED_CLIP_SECONDS = 60;
export const SOURCE_MISSING_MESSAGE = "Source video file no longer exists";

function segmentFor(clip: ClipDoc, keepRanges: boolean) {
  const ranges = clipSourceRanges(clip);
  const bounds = ranges.length
    ? [Math.min(...ranges.map((r) => r.start)), Math.max(...ranges.map((r) => r.end))]
    : null;
  return {
    start_time: bounds ? secondsToMmss(bounds[0]) : clip.startTime,
    end_time: bounds ? secondsToMmss(bounds[1]) : clip.endTime,
    text: clip.text,
    hook_title: clip.hookTitle,
    // Unchanged cleanup: render exactly what was rendered before. Changed: clean the source again.
    ...(keepRanges
      ? { keep_ranges: clip.keepRanges?.length ? clip.keepRanges : ranges.map((r) => [r.start, r.end]) }
      : { source_ranges: ranges }),
  };
}

export async function restyleTask(ctx: JobContext): Promise<JobOutcome> {
  const { job } = ctx;
  const taskId = job.taskId;
  const runFilter = { "run.jobId": job._id };
  // The task must still be in this run: a cancel or a newer run means this job is stale.
  if (!(await casStatus(taskId, ["processing"], { "run.startedAt": new Date() }, runFilter))) return cancelledOutcome;

  const storage = getStorage();
  const stored: string[] = [];
  const discardStored = () => Promise.all(stored.map((key) => storage.delete(key).catch(() => {})));
  // The old clips stay, so the task goes back to the settings they were rendered with.
  const restore = async () =>
    casStatus(taskId, ["processing"], { ...restyleRollback(job, RESTYLE_FAILED_MESSAGE), "run.completedAt": new Date() }, runFilter);

  try {
    const task = await getTask(taskId);
    if (!task) return cancelledOutcome;
    const done = () => ({ status: "completed" as const, progress: 100, progressMessage: "Complete!", "run.completedAt": new Date() });
    if (!task.clips.length) return (await casStatus(taskId, ["processing"], done(), runFilter)) ? { status: "succeeded" } : cancelledOutcome;

    const videoPath = await sourceVideoPath(ctx, task, SOURCE_MISSING_MESSAGE);
    const keepRanges = job.payload.cleanupChanged === false;
    const clipLength = normalizeClipLength(task.settings.clipLength);
    const total = task.clips.length;
    const rendered: { clip: ClipDoc; file: string }[] = [];
    let finished = 0;

    await ctx.engine(
      "render-clips",
      {
        video_path: videoPath,
        output_dir: path.join(ctx.workDir, "clips"),
        segments: task.clips.map((clip) => segmentFor(clip, keepRanges)),
        options: renderOptions(task.settings, Math.max(CLIP_DURATIONS[clipLength].maximum, MAX_RENDERED_CLIP_SECONDS)),
      },
      async (event) => {
        if (event.type !== "clip" && event.type !== "clip_failed") return;
        if (event.type === "clip") {
          const old = task.clips[event.index];
          const file = event.clip as EngineClip;
          rendered.push({
            file: file.path,
            clip: {
              ...clipDocFrom(taskId, file, {
                relevanceScore: old.relevanceScore ?? 0.5,
                reasoning: old.reasoning || "Regenerated with updated settings",
                viralityScore: old.viralityScore ?? 0,
                hookScore: old.hookScore ?? 0,
                engagementScore: old.engagementScore ?? 0,
                valueScore: old.valueScore ?? 0,
                shareabilityScore: old.shareabilityScore ?? 0,
                hookType: old.hookType ?? null,
                hookTitle: old.hookTitle ?? null,
              }),
              lineageId: lineageOf(old),
            },
          });
        } else {
          console.warn(`[worker] Restyle of task ${taskId}: clip ${event.index + 1} failed: ${event.message}`);
        }
        // Only the number moves: the UI keys on "Applying new style..." for the whole run.
        const progress = Math.floor((++finished / total) * 95);
        if (!(await casStatus(taskId, ["processing"], { progress }, runFilter))) throw new TaskCancelled();
        await ctx.progress(progress);
      },
    );

    if (!rendered.length) {
      // Replacing the clips with nothing would delete every clip.
      return (await restore()) ? { status: "failed", error: RESTYLE_FAILED_MESSAGE } : cancelledOutcome;
    }
    for (const { clip, file } of rendered) {
      ctx.throwIfStopped();
      await storage.putFile(clip.storageKey, file);
      stored.push(clip.storageKey);
    }
    ctx.throwIfStopped();
    let swapped: boolean;
    try {
      swapped = await replaceClips(taskId, job._id, rendered.map(({ clip }) => clip), done());
    } catch (error) {
      // The swap can commit and then throw from its old-clip cleanup: the new files are the task's then.
      const used = new Set((await getTask(taskId))?.clips.map((clip) => clip.storageKey));
      if (!stored.every((key) => used.has(key))) throw error;
      console.warn(`[worker] Restyle of task ${taskId}: old clip cleanup failed`, error);
      swapped = true;
    }
    if (!swapped) {
      await discardStored();
      return cancelledOutcome;
    }
    return { status: "succeeded", result: { clips: rendered.length } };
  } catch (error) {
    await discardStored();
    // Cancelled restyles leave the task to the cancel route: the old clips were never touched.
    if (ctx.stopReason) throw error;
    if (error instanceof TaskCancelled) return cancelledOutcome;
    const message = errorMessage(error);
    console.error(`[worker] Restyle of task ${taskId} failed: ${message}`);
    return (await restore()) ? { status: "failed", error: message } : cancelledOutcome;
  }
}
