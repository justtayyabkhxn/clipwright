// combine_editor: port of editor_service.combine_editor. The route snapshotted
// each selected draft into `payload.inputs`; the new clip is appended with its own ready draft.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { collections } from "../../server/db";
import type { CombineInput } from "../../server/drafts";
import type { JobOutcome } from "../../server/jobs";
import { getStorage, storageKeys } from "../../server/storage";
import { appendClip, EXPORT_TTL_MS, getTask, secondsToMmss } from "../../server/tasks";
import { EditDocumentSchema, type ClipDoc, type EditorAsset } from "../../server/types";
import { UserError, type JobContext } from "../context";

export const COMBINE_FAILED_MESSAGE = "Could not combine drafts. The original clips are unchanged.";

type CombineResult = {
  clean_path: string;
  export_path: string;
  thumbnails_path: string;
  document: unknown;
  asset: EditorAsset;
  source_ranges: { start: number; end: number }[];
};

export async function combineEditor(ctx: JobContext): Promise<JobOutcome> {
  const { job } = ctx;
  const storage = getStorage();
  const { clipDrafts } = collections();
  const staged: string[] = [];
  let newId: string | null = null;
  try {
    const inputs = (job.payload.inputs ?? []) as CombineInput[];
    if (inputs.length < 2) throw new UserError("Combine needs at least two clips");
    const outputDir = path.join(ctx.workDir, "combine");
    const result = await ctx.engine<CombineResult>(
      "editor-combine",
      {
        inputs: await Promise.all(
          inputs.map(async (input) => ({
            clean_path: await storage.localPath(storageKeys.editorMedia(input.id, input.filename).cleanKey),
            document: input.document,
            has_audio: input.state.hasAudio,
            width: input.state.width,
            height: input.state.height,
            source_ranges: input.ranges,
          })),
        ),
        output_dir: outputDir,
      },
      (event) => (event.type === "progress" ? ctx.progress(event.pct) : undefined),
    );
    const document = EditDocumentSchema.parse(result.document);
    const duration = document.segments.reduce((total, segment) => total + segment.end - segment.start, 0);

    newId = randomUUID();
    const filename = `combined_${randomUUID().replace(/-/g, "")}.mp4`;
    const clipKey = storageKeys.clip(job.taskId, filename);
    const exportKey = storageKeys.editorExport(job._id);
    const media = storageKeys.editorMedia(newId, filename);
    // The captioned export is both this job's download and the new clip's file.
    const clipFile = path.join(outputDir, "clip.mp4");
    await fs.copyFile(result.export_path, clipFile);
    for (const [key, file] of [
      [exportKey, result.export_path],
      [clipKey, clipFile],
      [media.cleanKey, result.clean_path],
      [media.thumbnailsKey, result.thumbnails_path],
    ]) {
      await storage.putFile(key, file);
      staged.push(key);
    }
    ctx.throwIfStopped();

    const now = new Date();
    // Draft first: the clip must never be visible without its prepared draft.
    await clipDrafts.insertOne({
      _id: newId,
      taskId: job.taskId,
      userId: job.userId,
      basis: filename,
      status: "ready",
      asset: result.asset,
      media,
      revision: 0,
      document,
      original: document,
      createdAt: now,
      updatedAt: now,
    });
    const clip: ClipDoc = {
      id: newId,
      filename,
      storageKey: clipKey,
      startTime: "00:00",
      endTime: secondsToMmss(duration),
      duration,
      text: document.words.map((word) => word.text).join(" "),
      relevanceScore: 0,
      reasoning: "Combined in the clip editor",
      viralityScore: 0,
      hookScore: 0,
      engagementScore: 0,
      valueScore: 0,
      shareabilityScore: 0,
      hookType: null,
      hookTitle: null,
      sourceRanges: result.source_ranges,
      lineageId: newId,
      createdAt: now,
      updatedAt: now,
    };
    let appended: boolean;
    try {
      appended = await appendClip(job.taskId, clip, inputs.map(({ id, filename }) => ({ id, filename })));
    } catch (error) {
      // A lost reply: the push may have committed, and then the clip, draft and files are the task's.
      appended = Boolean((await getTask(job.taskId))?.clips.some((candidate) => candidate.id === newId));
      if (!appended) throw error;
    }
    if (!appended) throw new UserError("An input clip changed while combining");
    return {
      status: "succeeded",
      result: { clip_id: newId, fileKey: exportKey },
      expiresAt: new Date(Date.now() + EXPORT_TTL_MS),
    };
  } catch (error) {
    if (newId) {
      await clipDrafts.deleteOne({ _id: newId }).catch(() => {});
      await storage.deletePrefix(storageKeys.editorDir(newId)).catch(() => {});
    }
    await Promise.all(staged.map((key) => storage.delete(key).catch(() => {})));
    if (ctx.stopReason) throw error;
    console.error(`[worker] Combine ${job._id} failed`, error);
    return { status: "failed", error: COMBINE_FAILED_MESSAGE };
  }
}
