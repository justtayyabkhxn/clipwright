import { captionLooks, upgradeDocument } from "./caption-templates";
import { collections } from "./db";
import { ApiError, zodDetail } from "./http";
import { EDITOR_JOB_TYPES, enqueueJob, newJobId, requestCancel } from "./jobs";
import { getStorage, storageKeys } from "./storage";
import { findClip, getTaskForUser } from "./tasks";
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

// startPrepare writes the draft just before its job, so a missing job only counts as dead after this.
const PREPARE_JOB_GRACE_MS = 60_000;

/**
 * A `preparing` draft whose job has finished (or never appeared) will never become ready. A retry
 * that lands between the handler's failPrepare and its finishJob follows that dying job.
 */
async function prepareStalled(draft: DraftDoc): Promise<boolean> {
  if (draft.status !== "preparing") return false;
  const job = draft.jobId
    ? await collections().jobs.findOne({ _id: draft.jobId }, { projection: { status: 1 } })
    : null;
  if (job) return job.status !== "queued" && job.status !== "running";
  return Date.now() - draft.updatedAt.getTime() > PREPARE_JOB_GRACE_MS;
}

/**
 * Mark the clip's draft as preparing and queue `prepare_editor`, unless a same-basis draft is
 * already ready, or preparing under a live job. A draft with a stale basis is reset (its document is dropped).
 */
export async function startPrepare(task: TaskDoc, clip: ClipDoc): Promise<{ status: "ready" | "preparing" }> {
  const { clipDrafts } = collections();
  const current = await getCurrentDraft(clip);
  if (current?.status === "ready") return { status: "ready" };
  if (current?.status === "preparing" && !(await prepareStalled(current))) return { status: "preparing" };

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
  const document = parseDocument(payload.document, draft.asset.duration);

  const result = await collections().clipDrafts.updateOne(
    { _id: clip.id, basis: clip.filename, status: "ready", revision },
    { $set: { document, updatedAt: new Date() }, $inc: { revision: 1 } },
  );
  if (!result.matchedCount) throw new ApiError(409, REVISION_CONFLICT_MESSAGE);
  return { revision: revision + 1, document };
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
  // A stalled prepare reads as failed, so the editor stops polling and offers a retry.
  if (draft.status === "preparing" && !(await prepareStalled(draft))) return { status: "preparing" as const, ...common };
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

// --- Editor routes (port of api/routes/editor.py) ---

export const EXPORT_NOT_FOUND_MESSAGE = "Export not found";
export const EXPORT_NOT_READY_MESSAGE = "Export is not ready";
export const EDITOR_PRESETS = ["tiktok", "reels", "shorts"] as const;
export const MAX_ACTIVE_EDITOR_JOBS = 3;
const JOB_ID = /^[a-f0-9]{32}$/;

/**
 * The owned task and its clip (404/403). As in editor.py there is no processing lock: drafts have
 * their own revision check, "renders must not block autosave", and combine's worker only appends
 * its clip to an idle task (appendClip).
 */
export async function editorClip(taskId: string, clipId: string, userId: string) {
  const task = await getTaskForUser(taskId, userId);
  return { task, clip: findClip(task, clipId) };
}

/** `EditDocument.model_validate(...).validate_duration(duration)`, as a 400. */
function parseDocument(raw: unknown, duration: number): EditDocument {
  const parsed = EditDocumentSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, zodDetail(parsed.error));
  const durationError = documentDurationError(parsed.data, duration);
  if (durationError) throw new ApiError(400, durationError);
  return parsed.data;
}

// ponytail: soft limit, races can admit a 4th; add a counter doc if it matters.
async function assertExportSlot(clipId: string, message: string): Promise<void> {
  const active = await collections().jobs.countDocuments({
    clipId,
    type: { $in: EDITOR_JOB_TYPES },
    status: { $in: ["queued", "running"] },
  });
  if (active >= MAX_ACTIVE_EDITOR_JOBS) throw new ApiError(429, message);
}

/** `POST .../editor/exports`: queue `export_editor` with `{document, preset, basis}`. */
export async function startEditorExport(task: TaskDoc, clip: ClipDoc, payload: Record<string, unknown>) {
  const draft = await getCurrentDraft(clip);
  if (draft?.status !== "ready" || !draft.asset) throw new ApiError(409, "Prepare the editor preview before exporting");
  if (payload.basis !== clip.filename) throw new ApiError(409, CLIP_CHANGED_MESSAGE);
  const preset = Object.hasOwn(payload, "preset") ? payload.preset : "tiktok";
  if (!EDITOR_PRESETS.includes(preset as (typeof EDITOR_PRESETS)[number])) throw new ApiError(400, "Unknown export preset");
  const document = parseDocument(payload.document, draft.asset.duration);
  await assertExportSlot(clip.id, "Three exports are already running for this clip");
  const { job } = await enqueueJob({
    type: "export_editor",
    taskId: task._id,
    clipId: clip.id,
    userId: task.userId,
    // basis: the clip file whose clean.mp4 the document was validated against.
    payload: { document, preset, basis: clip.filename },
  });
  return { id: job._id, status: "queued" as const, progress: 0 };
}

/** An export or combine job anchored on this clip; 404 for a malformed or unknown id. */
export async function getEditorJob(task: Pick<TaskDoc, "_id">, clip: Pick<ClipDoc, "id">, jobId: string): Promise<JobDoc> {
  const job = JOB_ID.test(jobId)
    ? await collections().jobs.findOne({ _id: jobId, taskId: task._id, clipId: clip.id, type: { $in: EDITOR_JOB_TYPES } })
    : null;
  if (!job) throw new ApiError(404, EXPORT_NOT_FOUND_MESSAGE);
  return job;
}

/** `DELETE .../editor/exports/{job}`: a queued job is cancelled at once, a running one is told to stop. */
export async function cancelEditorJob(job: JobDoc): Promise<{ status: EditorJob["status"] | "cancelling" }> {
  const { cancelled, cancelling } = await requestCancel({ _id: job._id });
  if (cancelled) return { status: "cancelled" };
  if (cancelling) return { status: "cancelling" };
  const current = await collections().jobs.findOne({ _id: job._id }, { projection: { status: 1 } });
  return { status: EDITOR_STATUS[(current ?? job).status] };
}

/** Storage key of a finished export; 409 while it is not ready (or its file is gone). */
export async function editorExportKey(job: JobDoc): Promise<string> {
  if (job.status !== "succeeded") throw new ApiError(409, EXPORT_NOT_READY_MESSAGE);
  const key = typeof job.result?.fileKey === "string" ? job.result.fileKey : storageKeys.editorExport(job._id);
  if (!(await getStorage().stat(key))) throw new ApiError(409, EXPORT_NOT_READY_MESSAGE);
  return key;
}

export type CombineInput = {
  id: string;
  filename: string;
  document: EditDocument;
  state: Pick<EditorAsset, "width" | "height" | "hasAudio">;
  ranges: ClipDoc["sourceRanges"];
};

/**
 * `POST /tasks/{t}/editor/combine`: snapshot each selected clip's draft (like editor.py's request
 * file) and queue `combine_editor` on the first clip with payload `{inputs: CombineInput[]}`.
 */
export async function startCombine(task: TaskDoc, payload: Record<string, unknown>) {
  const ids = payload.clip_ids;
  if (
    !Array.isArray(ids) ||
    ids.length < 2 ||
    ids.length > 20 ||
    !ids.every((id) => typeof id === "string") ||
    new Set(ids).size !== ids.length
  ) {
    throw new ApiError(400, "Select between 2 and 20 distinct clips");
  }
  const clips = (ids as string[]).map((id) => findClip(task, id));
  const drafts = await collections().clipDrafts.find({ _id: { $in: ids as string[] } }).toArray();
  const inputs: CombineInput[] = clips.map((clip) => {
    const draft = drafts.find((candidate) => candidate._id === clip.id);
    if (!draft || draft.basis !== clip.filename || draft.status !== "ready" || !draft.asset || !draft.document) {
      throw new ApiError(409, "Prepare each selected clip before combining");
    }
    const { width, height, hasAudio } = draft.asset;
    return {
      id: clip.id,
      filename: clip.filename,
      document: upgradeDocument(draft.document, clip, task),
      state: { width, height, hasAudio },
      ranges: clip.sourceRanges,
    };
  });
  const anchor = inputs[0];
  await assertExportSlot(anchor.id, "Wait for an existing export to finish before combining");
  const { job } = await enqueueJob({
    type: "combine_editor",
    taskId: task._id,
    clipId: anchor.id,
    userId: task.userId,
    payload: { inputs },
  });
  return { id: job._id, anchor_clip_id: anchor.id };
}
