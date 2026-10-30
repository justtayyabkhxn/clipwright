// prepare_editor: port of editor_service.prepare_editor. The engine renders the
// uncaptioned clean.mp4, its thumbnail strip and the first draft; the draft lives in clip_drafts.

import path from "node:path";
import { CLIP_CHANGED_MESSAGE, completePrepare, failPrepare } from "../../server/drafts";
import type { JobOutcome } from "../../server/jobs";
import { getStorage, storageKeys } from "../../server/storage";
import { getTask } from "../../server/tasks";
import { EditDocumentSchema, type EditorAsset } from "../../server/types";
import { clipSourceRanges, errorMessage, sourceVideoPath, UserError, type JobContext } from "../context";

export const SOURCE_UNAVAILABLE_MESSAGE =
  "The original source is unavailable. Restore the source file to edit this clip.";

type PrepareResult = { asset: EditorAsset; clean_path: string; thumbnails_path: string; initial_document: unknown };

export async function prepareEditor(ctx: JobContext): Promise<JobOutcome> {
  const { job } = ctx;
  const clipId = job.clipId!;
  try {
    const task = await getTask(job.taskId);
    const clip = task?.clips.find((candidate) => candidate.id === clipId);
    if (!task || !clip || clip.filename !== job.payload.filename) throw new UserError(CLIP_CHANGED_MESSAGE);

    const source = await sourceVideoPath(ctx, task, SOURCE_UNAVAILABLE_MESSAGE);
    const { settings } = task;
    const result = await ctx.engine<PrepareResult>("editor-prepare", {
      source_video_path: source,
      source_ranges: clipSourceRanges(clip),
      output_dir: path.join(ctx.workDir, "editor"),
      output_format: settings.outputFormat,
      clip_text: clip.text,
      hook_title: clip.hookTitle,
      add_subtitles: settings.addSubtitles,
      caption_settings: clip.captionSettings ?? {},
      task_style: {
        caption_template: settings.captionTemplate,
        font_family: settings.fontFamily,
        font_size: settings.fontSize,
        font_color: settings.fontColor,
      },
    });
    const document = EditDocumentSchema.parse(result.initial_document);

    ctx.throwIfStopped();
    const storage = getStorage();
    const media = storageKeys.editorMedia(clipId, clip.filename);
    await storage.putFile(media.cleanKey, result.clean_path);
    await storage.putFile(media.thumbnailsKey, result.thumbnails_path);
    if (!(await completePrepare(clipId, clip.filename, { asset: result.asset, document }))) {
      // The clip was re-rendered or deleted meanwhile: nothing points at this media.
      await storage.deletePrefix(media.cleanKey.slice(0, media.cleanKey.lastIndexOf("/") + 1));
      throw new UserError(CLIP_CHANGED_MESSAGE);
    }
    return { status: "succeeded" };
  } catch (error) {
    // A requeued job (shutdown, lost lease) prepares again; anything else leaves a retryable failure.
    if (ctx.stopReason !== "shutdown" && ctx.stopReason !== "lost") await failPrepare(clipId, job._id);
    if (ctx.stopReason) throw error;
    console.error(`[worker] Editor prepare of clip ${clipId} failed`, error instanceof UserError ? errorMessage(error) : error);
    return { status: "failed", error: errorMessage(error) };
  }
}
