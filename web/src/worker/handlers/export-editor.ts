// export_editor: port of editor_service.export_editor (map-editor.md §5.2, §7.1). The route validated
// the document against the draft; the engine renders it over the clip's clean.mp4.

import path from "node:path";
import { getCurrentDraft } from "../../server/drafts";
import type { JobOutcome } from "../../server/jobs";
import { getStorage, storageKeys } from "../../server/storage";
import { EXPORT_TTL_MS, getTask } from "../../server/tasks";
import { UserError, type JobContext } from "../context";

export const EDITOR_EXPORT_FAILED_MESSAGE = "Export failed. Your draft is safe; retry the export.";

export async function exportEditor(ctx: JobContext): Promise<JobOutcome> {
  const { job } = ctx;
  try {
    const clip = (await getTask(job.taskId))?.clips.find((candidate) => candidate.id === job.clipId);
    if (!clip || clip.filename !== job.payload.basis) throw new UserError("Clip no longer exists");
    const draft = await getCurrentDraft(clip);
    if (draft?.status !== "ready" || !draft.media) throw new UserError("The editor preview is not prepared");

    const storage = getStorage();
    const output = path.join(ctx.workDir, "export.mp4");
    await ctx.engine(
      "editor-render",
      {
        clean_path: await storage.localPath(draft.media.cleanKey),
        document: job.payload.document,
        preset: job.payload.preset ?? "tiktok",
        output,
      },
      (event) => (event.type === "progress" ? ctx.progress(event.pct) : undefined),
    );
    const fileKey = storageKeys.editorExport(job._id);
    await storage.putFile(fileKey, output);
    return { status: "succeeded", result: { fileKey }, expiresAt: new Date(Date.now() + EXPORT_TTL_MS) };
  } catch (error) {
    if (ctx.stopReason) throw error;
    console.error(`[worker] Editor export ${job._id} failed`, error);
    return { status: "failed", error: EDITOR_EXPORT_FAILED_MESSAGE };
  }
}
