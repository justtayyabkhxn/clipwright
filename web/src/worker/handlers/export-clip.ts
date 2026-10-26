// export_clip: port of clip_export_service.export_clip_preset. Re-encodes the rendered clip to a
// platform preset; the result expires after 7 days (the cron deletes it).

import path from "node:path";
import type { JobOutcome } from "../../server/jobs";
import { getStorage, storageKeys } from "../../server/storage";
import { EXPORT_FAILED_MESSAGE, EXPORT_TTL_MS, getTask } from "../../server/tasks";
import { UserError, type JobContext } from "../context";

export const CLIP_CHANGED_EXPORT_MESSAGE = "The clip changed before the export finished.";
/** Shown for an export whose worker stopped (the reaper's failure hook). */
export const EXPORT_STOPPED_MESSAGE = "Export timed out before it finished.";

export async function exportClip(ctx: JobContext): Promise<JobOutcome> {
  const { job } = ctx;
  const currentClip = async () => {
    const clip = (await getTask(job.taskId))?.clips.find((candidate) => candidate.id === job.clipId);
    if (!clip || clip.filename !== job.payload.filename) throw new UserError(CLIP_CHANGED_EXPORT_MESSAGE);
    return clip;
  };
  try {
    const clip = await currentClip();
    const storage = getStorage();
    const output = path.join(ctx.workDir, "export.mp4");
    await ctx.engine(
      "export-preset",
      { input: await storage.localPath(clip.storageKey), output, preset: job.payload.preset },
      (event) => (event.type === "progress" ? ctx.progress(event.pct) : undefined),
    );
    await currentClip();
    const fileKey = storageKeys.presetExport(job._id);
    await storage.putFile(fileKey, output);
    return { status: "succeeded", result: { fileKey }, expiresAt: new Date(Date.now() + EXPORT_TTL_MS) };
  } catch (error) {
    if (ctx.stopReason) throw error;
    if (error instanceof UserError) return { status: "failed", error: error.message };
    console.error(`[worker] Preset export ${job._id} failed`, error);
    return { status: "failed", error: EXPORT_FAILED_MESSAGE };
  }
}
