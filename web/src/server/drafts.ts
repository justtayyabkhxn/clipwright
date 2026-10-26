import { captionLooks, upgradeDocument } from "./caption-templates";
import { collections } from "./db";
import { ApiError, zodDetail } from "./http";
import { EDITOR_JOB_TYPES, enqueueJob, newJobId } from "./jobs";
import { storageKeys } from "./storage";
import {
  documentDurationError,
  EditDocumentSchema,
  type ClipDoc,
  type DraftDoc,
  type EditDocument,
  type EditorAsset,
  type JobDoc,
  type TaskDoc,
} from "./types";

export const CLIP_CHANGED_MESSAGE = "The original clip changed. Reopen the editor.";
export const NOT_READY_MESSAGE = "Wait for the editor preview to finish preparing";
export const REVISION_CONFLICT_MESSAGE =
  "This clip was edited in another tab. Reload the saved draft before continuing.";
export const PREPARE_FAILED_MESSAGE =
  "Could not prepare the source video. Check that the source is available, then retry.";

export async function getDraft(clipId: string): Promise<DraftDoc | null> {
  return collections().clipDrafts.findOne({ _id: clipId });
}

/** A draft counts only while it was prepared from the clip's current file. */
export async function getCurrentDraft(clip: Pick<ClipDoc, "id" | "filename">): Promise<DraftDoc | null> {
  const draft = await getDraft(clip.id);
  return draft && draft.basis === clip.filename ? draft : null;
}

/**
 * Mark the clip's draft as preparing and queue `prepare_editor`, unless a same-basis draft is
 * already ready or preparing. A draft with a stale basis is reset (its document is dropped).
 */
export async function startPrepare(task: TaskDoc, clip: ClipDoc): Promise<{ status: "ready" | "preparing" }> {
  const { clipDrafts } = collections();
  const current = await getCurrentDraft(clip);
  if (current && (current.status === "ready" || current.status === "preparing")) return { status: current.status };

  const now = new Date();
  const jobId = newJobId();
  // Draft first, so a fast worker always finds it.
  await clipDrafts.updateOne(
    { _id: clip.id },
    {
      $set: {
        taskId: task._id,
        userId: task.userId,
        basis: clip.filename,
        status: "preparing",
        jobId,
        revision: 0,
        updatedAt: now,
      },
      $unset: { error: "", asset: "", media: "", document: "", original: "" },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  const { job, created } = await enqueueJob({
    id: jobId,
    type: "prepare_editor",
    taskId: task._id,
    clipId: clip.id,
    userId: task.userId,
    payload: { filename: clip.filename },
    activeKey: `prepare:${clip.id}`,
  });
  // A prepare is already queued or running: follow that job instead.
  if (!created) await clipDrafts.updateOne({ _id: clip.id, jobId }, { $set: { jobId: job._id } });
  return { status: "preparing" };
}

/**
 * Worker: record the prepared media. The initial document seeds revision 0 and `original` only
 * when no draft exists yet for this basis; an existing one is never overwritten.
 */
export async function completePrepare(
  clipId: string,
  basis: string,
  result: { asset: EditorAsset; document: EditDocument },
): Promise<boolean> {
  const { clipDrafts } = collections();
  const now = new Date();
  const media = storageKeys.editorMedia(clipId, basis);
  const ready = { status: "ready" as const, asset: result.asset, media, updatedAt: now };
  const seeded = await clipDrafts.updateOne(
    { _id: clipId, basis, document: { $exists: false } },
    { $set: { ...ready, document: result.document, original: result.document, revision: 0 }, $unset: { error: "" } },
  );
  if (seeded.matchedCount) return true;
  const updated = await clipDrafts.updateOne({ _id: clipId, basis }, { $set: ready, $unset: { error: "" } });
  return updated.matchedCount > 0;
}

/** Worker or reaper: a prepare that did not finish. Only touches the draft that job was preparing. */
export async function failPrepare(clipId: string, jobId: string, error = PREPARE_FAILED_MESSAGE): Promise<void> {
  await collections().clipDrafts.updateOne(
    { _id: clipId, jobId, status: "preparing" },
    { $set: { status: "failed", error, updatedAt: new Date() } },
  );
}

/** Autosave with a revision compare-and-set (`PATCH .../editor`). */
export async function saveDraft(
  clip: ClipDoc,
  payload: Record<string, unknown>,
): Promise<{ revision: number; document: EditDocument }> {
  if (payload.basis !== clip.filename) throw new ApiError(409, CLIP_CHANGED_MESSAGE);
  const draft = await getCurrentDraft(clip);
  if (!draft || draft.status !== "ready" || !draft.asset) throw new ApiError(409, NOT_READY_MESSAGE);
  const revision = payload.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) {
    throw new ApiError(400, "Invalid draft revision");
  }
  const parsed = EditDocumentSchema.safeParse(payload.document);
  if (!parsed.success) throw new ApiError(400, zodDetail(parsed.error));
  const durationError = documentDurationError(parsed.data, draft.asset.duration);
  if (durationError) throw new ApiError(400, durationError);

  const result = await collections().clipDrafts.updateOne(
    { _id: clip.id, basis: clip.filename, status: "ready", revision },
    { $set: { document: parsed.data, updatedAt: new Date() }, $inc: { revision: 1 } },
  );
  if (!result.matchedCount) throw new ApiError(409, REVISION_CONFLICT_MESSAGE);
  return { revision: revision + 1, document: parsed.data };
}

const EDITOR_STATUS: Record<JobDoc["status"], EditorJob["status"]> = {
  queued: "queued",
  running: "rendering",
  succeeded: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

export type EditorJob = {
  id: string;
  status: "queued" | "rendering" | "completed" | "failed" | "cancelled";
  progress: number;
  error?: string;
  clip_id?: string;
};

/** An export/combine job in the editor's status vocabulary. */
export function editorJobView(job: Pick<JobDoc, "_id" | "status" | "progress" | "error" | "result">): EditorJob {
  const view: EditorJob = { id: job._id, status: EDITOR_STATUS[job.status], progress: job.progress };
  if (job.error && (job.status === "failed" || job.status === "cancelled")) view.error = job.error;
  if (typeof job.result?.clip_id === "string") view.clip_id = job.result.clip_id;
  return view;
}

/** The latest 20 export and combine jobs anchored on this clip. */
export async function editorJobsForClip(clipId: string): Promise<EditorJob[]> {
  const jobs = await collections()
    .jobs.find(
      { clipId, type: { $in: EDITOR_JOB_TYPES } },
      { sort: { createdAt: -1 }, limit: 20, projection: { status: 1, progress: 1, error: 1, result: 1 } },
    )
    .toArray();
  return jobs.map(editorJobView);
}

/** `GET .../editor`: the EditorState the client reads. */
export async function readEditorState(task: TaskDoc, clip: ClipDoc) {
  const [draft, jobs] = await Promise.all([getCurrentDraft(clip), editorJobsForClip(clip.id)]);
  const common = { basis: clip.filename, jobs };
  if (!draft) return { status: "unprepared" as const, ...common };
  if (draft.status === "preparing") return { status: "preparing" as const, ...common };
  if (draft.status === "failed" || !draft.asset || !draft.document) {
    return { status: "failed" as const, error: draft.error ?? PREPARE_FAILED_MESSAGE, ...common };
  }
  return {
    status: "ready" as const,
    ...draft.asset,
    draft: { revision: draft.revision, document: upgradeDocument(draft.document, clip, task) },
    original: upgradeDocument(draft.original ?? draft.document, clip, task),
    captionLooks: captionLooks(),
    ...common,
  };
}
