import { createHash, randomUUID } from "node:crypto";
import type { Filter, MatchKeysAndValues } from "mongodb";
import { collections } from "./db";
import { ApiError } from "./http";
import { enqueueJob, newJobId, requestCancel } from "./jobs";
import { getStorage, storageKeys, uploadKeys } from "./storage";
import type { ClipDoc, ClipLength, JobDoc, OutputFormat, SourceRange, TaskDoc, TaskSettings, TaskStatus } from "./types";
import { disconnectAccount } from "./youtube/accounts";

// --- Normalisers (ports of tasks.py:186-207, clip_cleanup.py, clip_duration.py) ---

export const OUTPUT_FORMATS: readonly OutputFormat[] = [
  "vertical",
  "vertical_fit",
  "vertical_pan",
  "vertical_split",
  "original",
];

export type ClipDuration = { minimum: number; maximum: number; idealMinimum: number; idealMaximum: number };

export const CLIP_DURATIONS: Record<ClipLength, ClipDuration> = {
  auto: { minimum: 15, maximum: 60, idealMinimum: 25, idealMaximum: 50 },
  short: { minimum: 15, maximum: 30, idealMinimum: 18, idealMaximum: 25 },
  medium: { minimum: 30, maximum: 60, idealMinimum: 35, idealMaximum: 55 },
  long: { minimum: 60, maximum: 120, idealMinimum: 75, idealMaximum: 110 },
};

export function isClipLength(value: unknown): value is ClipLength {
  return typeof value === "string" && Object.hasOwn(CLIP_DURATIONS, value);
}

export function validateClipLength(value: unknown): ClipLength {
  if (!isClipLength(value)) throw new ApiError(422, "clip_length must be auto, short, medium, or long");
  return value;
}

/** Stored settings fall back to Auto instead of failing a job. */
export function normalizeClipLength(value: unknown): ClipLength {
  return isClipLength(value) ? value : "auto";
}

export function clipDuration(length: ClipLength = "auto"): ClipDuration {
  return CLIP_DURATIONS[validateClipLength(length)];
}

export function normalizeOutputFormat(value: unknown): OutputFormat {
  return OUTPUT_FORMATS.includes(value as OutputFormat) ? (value as OutputFormat) : "vertical";
}

// Python's int(): None/garbage fails, floats truncate, bools are 0/1.
function pyInt(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

// Python's bool(): empty strings, 0, null and empty lists are false.
export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

const blank = (value: unknown) => value === null || value === undefined || (typeof value === "string" && !value.trim());

export function normalizeFontSize(value: unknown, fallback = 24): number | null {
  if (blank(value)) return null;
  return Math.max(12, Math.min(72, pyInt(value) ?? fallback));
}

export function normalizeFontColor(value: unknown, fallback = "#FFFFFF"): string | null {
  if (blank(value)) return null;
  return typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value) ? value.toUpperCase() : fallback;
}

export function normalizeFontFamily(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const DEFAULT_PAUSE_THRESHOLD_MS = 1200;

export function normalizePauseThresholdMs(value: unknown, fallback = DEFAULT_PAUSE_THRESHOLD_MS): number {
  return Math.max(250, Math.min(3000, pyInt(value) ?? fallback));
}

export function normalizeFilteredWords(value: unknown): string[] {
  const items = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  const words: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    const cleaned = item.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
    if (cleaned && !words.includes(cleaned)) words.push(cleaned);
  }
  return words;
}

export type CleanupSettings = Pick<TaskSettings, "cutLongPauses" | "pauseThresholdMs" | "removeFillerWords" | "filteredWords">;

export function normalizeCleanupSettings(
  cutLongPauses: unknown = false,
  pauseThresholdMs: unknown = DEFAULT_PAUSE_THRESHOLD_MS,
  removeFillerWords: unknown = false,
  filteredWords: unknown = undefined,
): CleanupSettings {
  return {
    cutLongPauses: truthy(cutLongPauses),
    pauseThresholdMs: normalizePauseThresholdMs(pauseThresholdMs),
    removeFillerWords: truthy(removeFillerWords),
    filteredWords: normalizeFilteredWords(filteredWords),
  };
}

type Payload = Record<string, unknown>;
const pick = (data: Payload, key: string, fallback: unknown) => (Object.hasOwn(data, key) ? data[key] : fallback);

/** New tasks clean up pacing unless the request explicitly opts out. */
export function newTaskCleanupSettings(data: Payload): CleanupSettings {
  return normalizeCleanupSettings(
    pick(data, "cut_long_pauses", true),
    data.pause_threshold_ms,
    pick(data, "remove_filler_words", true),
    data.filtered_words,
  );
}

/** Fields the payload omits keep their stored values. */
export function updatedCleanupSettings(payload: Payload, stored: CleanupSettings): CleanupSettings {
  return normalizeCleanupSettings(
    pick(payload, "cut_long_pauses", stored.cutLongPauses),
    pick(payload, "pause_threshold_ms", stored.pauseThresholdMs),
    pick(payload, "remove_filler_words", stored.removeFillerWords),
    pick(payload, "filtered_words", stored.filteredWords),
  );
}

const isPlainObject = (value: unknown): value is Payload =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const captionTemplateOf = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : "default");

/** Task settings from a `POST /api/tasks/create` body (tasks.py:441-470). */
export function settingsFromCreateRequest(data: Payload): TaskSettings {
  const fontOptions = pick(data, "font_options", {});
  if (!isPlainObject(fontOptions)) throw new ApiError(400, "font_options must be an object");
  const addSubtitles = pick(data, "add_subtitles", true);
  return {
    fontFamily: normalizeFontFamily(fontOptions.font_family),
    fontSize: normalizeFontSize(fontOptions.font_size),
    fontColor: normalizeFontColor(fontOptions.font_color),
    captionTemplate: captionTemplateOf(data.caption_template),
    outputFormat: normalizeOutputFormat(pick(data, "output_format", "vertical")),
    addSubtitles: typeof addSubtitles === "boolean" ? addSubtitles : true,
    clipLength: validateClipLength(pick(data, "clip_length", "auto")),
    ...newTaskCleanupSettings(data),
  };
}

/** Task settings after a `POST /api/tasks/:id/settings` body; framing and length are kept. */
export function settingsFromUpdateRequest(data: Payload, current: TaskSettings): TaskSettings {
  return {
    ...current,
    fontFamily: normalizeFontFamily(data.font_family),
    fontSize: normalizeFontSize(data.font_size),
    fontColor: normalizeFontColor(data.font_color),
    captionTemplate: captionTemplateOf(data.caption_template),
    ...updatedCleanupSettings(data, current),
  };
}

// --- Sources ---

const YOUTUBE_ID = /(?:youtube\.com\/(?:.*v=|v\/|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i;

const YOUTUBE_HOSTS = ["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"];

/**
 * `get_youtube_video_id` limited to YouTube hosts (as the client's validateVideoSourceUrl): the id
 * from any URL shape the regex knows, else a `v` query parameter. A scheme-less URL counts as https.
 */
export function youtubeVideoId(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  const input = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!["http:", "https:"].includes(parsed.protocol) || !YOUTUBE_HOSTS.includes(host)) return null;
  const match = YOUTUBE_ID.exec(input);
  if (match) return match[1];
  const id = parsed.searchParams.get("v");
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/** The only URL a YouTube source is stored and fetched as. */
export const youtubeWatchUrl = (videoId: string) => `https://www.youtube.com/watch?v=${videoId}`;

// --- Time and source ranges ---

/** `_seconds_to_mmss`: rounded to whole seconds, minutes are not wrapped into hours. */
export function secondsToMmss(seconds: number): string {
  const total = Math.max(0, pyRound(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// Python's round() rounds halves to even.
function pyRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

const MIN_RANGE_SECONDS = 0.05;

export function normalizeSourceRanges(ranges: SourceRange[] | null | undefined): SourceRange[] {
  return (ranges ?? []).filter(
    (range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end - range.start > MIN_RANGE_SECONDS,
  );
}

export function totalSourceDuration(ranges: SourceRange[] | null | undefined): number {
  return normalizeSourceRanges(ranges).reduce((sum, range) => sum + range.end - range.start, 0);
}

/** Source ranges covering output time [outputStart, outputEnd] of a clip (`slice_source_ranges`). */
export function sliceSourceRanges(
  ranges: SourceRange[] | null | undefined,
  outputStart: number,
  outputEnd: number,
): SourceRange[] {
  const normalized = normalizeSourceRanges(ranges);
  if (!normalized.length) return [];
  const total = totalSourceDuration(normalized);
  const windowStart = Math.max(0, Math.min(outputStart, total));
  const windowEnd = Math.max(windowStart, Math.min(outputEnd, total));
  const sliced: SourceRange[] = [];
  let cursor = 0;
  for (const range of normalized) {
    const timelineEnd = cursor + range.end - range.start;
    const overlapStart = Math.max(windowStart, cursor);
    const overlapEnd = Math.min(windowEnd, timelineEnd);
    if (overlapEnd - overlapStart > MIN_RANGE_SECONDS) {
      sliced.push({ start: range.start + overlapStart - cursor, end: range.start + overlapEnd - cursor });
    }
    cursor = timelineEnd;
  }
  return normalizeSourceRanges(sliced);
}

// --- Repository ---

export const ACTIVE_STATUSES: TaskStatus[] = ["queued", "processing"];
export const IDLE_STATUSES: TaskStatus[] = ["completed", "error", "cancelled"];
export const EDIT_LOCKED_MESSAGE = "Wait for processing to finish before editing this task";
export const RESTYLE_RUNNING_MESSAGE = "Applying new style...";
export const RESTYLE_CANCELLED_MESSAGE = "Restyle cancelled. Your existing clips are unchanged.";

export type TaskRun = NonNullable<TaskDoc["run"]>;
export type TaskRunType = NonNullable<TaskRun["type"]>;

/** The active run's job type while the task is queued or processing, else null. */
export function runType(task: Pick<TaskDoc, "status" | "run">): TaskRunType | null {
  return ACTIVE_STATUSES.includes(task.status) ? (task.run?.type ?? null) : null;
}

export const taskActiveKey = (taskId: string) => `task:${taskId}`;

export async function createTask(input: {
  userId: string;
  source: TaskDoc["source"];
  settings: TaskSettings;
  run?: TaskRun;
}): Promise<TaskDoc> {
  const now = new Date();
  const title = input.source.title?.trim() || (input.source.type === "youtube" ? "YouTube Video" : "Uploaded Video");
  const task: TaskDoc = {
    _id: randomUUID(),
    userId: input.userId,
    status: "queued",
    progress: 0,
    progressMessage: "",
    source: { ...input.source, title },
    settings: input.settings,
    clips: [],
    ...(input.run && { run: input.run }),
    createdAt: now,
    updatedAt: now,
  };
  await collections().tasks.insertOne(task);
  return task;
}

/** Create a queued task and its `process_task` job (`POST /api/tasks/create`). */
export async function createQueuedTask(input: {
  userId: string;
  source: TaskDoc["source"];
  settings: TaskSettings;
}): Promise<{ task: TaskDoc; job: JobDoc }> {
  // The task names its job before the job exists, so the worker never claims a job its task does not point at.
  const run: TaskRun = { jobId: newJobId(), type: "process_task" };
  const task = await createTask({ ...input, run });
  try {
    const { job } = await enqueueJob({
      id: run.jobId,
      type: "process_task",
      taskId: task._id,
      userId: task.userId,
      activeKey: taskActiveKey(task._id),
    });
    return { task, job };
  } catch (error) {
    await casStatus(task._id, ["queued"], {
      status: "error",
      progress: 0,
      progressMessage: "Unable to queue processing. Please retry this generation.",
    });
    throw error;
  }
}

/**
 * Move a task to `status` with `run = {jobId, type}`, then insert that job. Null when the task left
 * `expected` first. When `task:{id}` is still held (an earlier run is stopping) the task is restored
 * and the call throws 409 `busyMessage`.
 */
export async function startTaskRun(input: {
  task: TaskDoc;
  type: TaskRunType;
  expected: TaskStatus[];
  status: TaskStatus;
  set?: MatchKeysAndValues<TaskDoc>;
  payload?: Record<string, unknown>;
  busyMessage: string;
}): Promise<JobDoc | null> {
  const { task, type } = input;
  const run: TaskRun = { jobId: newJobId(), type };
  if (!(await casStatus(task._id, input.expected, { ...input.set, status: input.status, run }))) return null;
  const restore = () =>
    casStatus(
      task._id,
      [input.status],
      { status: task.status, progress: task.progress, progressMessage: task.progressMessage, settings: task.settings },
      { "run.jobId": run.jobId },
    );
  let enqueued: Awaited<ReturnType<typeof enqueueJob>>;
  try {
    enqueued = await enqueueJob({
      id: run.jobId,
      type,
      taskId: task._id,
      userId: task.userId,
      activeKey: taskActiveKey(task._id),
      payload: input.payload,
    });
  } catch (error) {
    await restore();
    throw error;
  }
  if (!enqueued.created) {
    await restore();
    throw new ApiError(409, input.busyMessage);
  }
  return enqueued.job;
}

export async function getTask(taskId: string): Promise<TaskDoc | null> {
  return collections().tasks.findOne({ _id: taskId });
}

/** Owner-only: 404 when missing, 403 for anyone else. */
export async function getTaskForUser(taskId: string, userId: string): Promise<TaskDoc> {
  const task = await getTask(taskId);
  if (!task) throw new ApiError(404, "Task not found");
  if (task.userId !== userId) throw new ApiError(403, "Not authorized for this task");
  return task;
}

export function findClip(task: TaskDoc, clipId: string): ClipDoc {
  const clip = task.clips.find((candidate) => candidate.id === clipId);
  if (!clip) throw new ApiError(404, "Clip not found");
  return clip;
}

export type TaskSummaryDoc = Pick<TaskDoc, "_id" | "userId" | "status" | "source" | "run" | "createdAt" | "updatedAt"> & {
  clips: Pick<ClipDoc, "id" | "viralityScore">[];
};

export async function listTasks(userId: string, limit = 50): Promise<TaskSummaryDoc[]> {
  return collections()
    .tasks.find(
      { userId },
      {
        sort: { createdAt: -1 },
        limit,
        projection: {
          userId: 1,
          status: 1,
          source: 1,
          "run.type": 1,
          createdAt: 1,
          updatedAt: 1,
          "clips.id": 1,
          "clips.viralityScore": 1,
        },
      },
    )
    .toArray() as Promise<TaskSummaryDoc[]>;
}

/** Compare-and-set: writes only while the status is one of `expected`. */
export async function casStatus(
  taskId: string,
  expected: TaskStatus[],
  set: MatchKeysAndValues<TaskDoc>,
  filter: Filter<TaskDoc> = {},
): Promise<boolean> {
  const result = await collections().tasks.updateOne(
    { ...filter, _id: taskId, status: { $in: expected } },
    { $set: { ...set, updatedAt: new Date() } },
  );
  return result.matchedCount > 0;
}

const runFilter = (taskId: string, jobId: string): Filter<TaskDoc> => ({
  _id: taskId,
  status: "processing",
  "run.jobId": jobId,
});

/** Worker: append a rendered clip. False means the run was cancelled or superseded. */
export async function pushClip(taskId: string, jobId: string, clip: ClipDoc): Promise<boolean> {
  const result = await collections().tasks.updateOne(runFilter(taskId, jobId), {
    $push: { clips: clip },
    $set: { updatedAt: new Date() },
  });
  return result.matchedCount > 0;
}

/** Worker, at render start: drop the previous clips and their files and drafts. Null on a CAS miss. */
export async function clearClips(taskId: string, jobId: string): Promise<ClipDoc[] | null> {
  const before = await collections().tasks.findOneAndUpdate(
    runFilter(taskId, jobId),
    { $set: { clips: [], updatedAt: new Date() } },
    { returnDocument: "before", projection: { clips: 1 } },
  );
  if (!before) return null;
  await deleteClipArtifacts(before.clips);
  return before.clips;
}

/**
 * Restyle commit: swap every clip at once (new ids), then delete the old files and drafts.
 * The restyle route sets `run.jobId` to the job's id (`newJobId()`) when it moves the task to processing.
 */
export async function replaceClips(
  taskId: string,
  jobId: string,
  clips: ClipDoc[],
  set: MatchKeysAndValues<TaskDoc> = {},
): Promise<boolean> {
  const before = await collections().tasks.findOneAndUpdate(
    runFilter(taskId, jobId),
    { $set: { ...set, clips, updatedAt: new Date() } },
    { returnDocument: "before", projection: { clips: 1 } },
  );
  if (!before) return false;
  const kept = new Set(clips.map((clip) => clip.storageKey));
  await deleteClipArtifacts(before.clips.filter((clip) => !kept.has(clip.storageKey)));
  return true;
}

/** Delete one clip of an idle task, with its file, draft and editor media. */
export async function removeClip(taskId: string, clipId: string): Promise<ClipDoc> {
  const before = await collections().tasks.findOneAndUpdate(
    { _id: taskId, status: { $nin: ACTIVE_STATUSES }, "clips.id": clipId },
    { $pull: { clips: { id: clipId } }, $set: { updatedAt: new Date() } },
    { returnDocument: "before", projection: { clips: 1 } },
  );
  if (!before) {
    const task = await getTask(taskId);
    if (!task) throw new ApiError(404, "Task not found");
    if (ACTIVE_STATUSES.includes(task.status)) throw new ApiError(400, EDIT_LOCKED_MESSAGE);
    throw new ApiError(404, "Clip not found");
  }
  const clip = before.clips.find((candidate) => candidate.id === clipId)!;
  await deleteClipArtifacts([clip]);
  return clip;
}

/**
 * Combine: append a clip to an idle task. `expect` lists {id, filename} pairs that must still be
 * present unchanged. False when the task is busy or an input clip changed.
 */
export async function appendClip(
  taskId: string,
  clip: ClipDoc,
  expect: Pick<ClipDoc, "id" | "filename">[] = [],
): Promise<boolean> {
  const filter: Filter<TaskDoc> = { _id: taskId, status: { $nin: ACTIVE_STATUSES } };
  if (expect.length) {
    filter.clips = { $all: expect.map(({ id, filename }) => ({ $elemMatch: { id, filename } })) };
  }
  const result = await collections().tasks.updateOne(filter, {
    $push: { clips: clip },
    $set: { updatedAt: new Date() },
  });
  return result.matchedCount > 0;
}

// ponytail: no deletion outbox; a crash between the DB write and an unlink leaves an orphan for the sweep.
// Runs after the clip write committed, so it never throws: leftovers belong to clips that no longer
// exist, and deleteTaskCompletely removes them with the task.
async function deleteClipArtifacts(clips: ClipDoc[]) {
  if (!clips.length) return;
  const storage = getStorage();
  await collections()
    .clipDrafts.deleteMany({ _id: { $in: clips.map((clip) => clip.id) } })
    .catch((error) => console.warn("[tasks] Could not delete clip drafts", error));
  await Promise.all(
    clips.flatMap((clip) => [
      storage.delete(clip.storageKey),
      storage.deletePrefix(storageKeys.editorDir(clip.id)),
    ]),
  ).catch((error) => console.warn("[tasks] Could not delete clip files", error));
}

export function jobFileKey(job: Pick<JobDoc, "_id" | "type" | "result">): string | null {
  if (typeof job.result?.fileKey === "string") return job.result.fileKey;
  if (job.type === "export_clip") return storageKeys.presetExport(job._id);
  if (job.type === "export_editor" || job.type === "combine_editor") return storageKeys.editorExport(job._id);
  return null;
}

/**
 * Delete a task whatever its status: running jobs are told to stop, then the task, its drafts, its
 * jobs and every file (clips, editor media, exports, and an upload source nothing else uses).
 * Running jobs stay as `cancelRequested` docs until their worker stops, so an output written in the
 * meantime still has a job doc for the cron to expire. YouTube sources are left for the cron sweep.
 */
export async function deleteTaskCompletely(taskId: string): Promise<void> {
  const { tasks, clipDrafts, jobs } = collections();
  await requestCancel({ taskId });
  const task = await tasks.findOne({ _id: taskId });
  const drafts = await clipDrafts.find({ taskId }, { projection: { _id: 1 } }).toArray();
  const taskJobs = await jobs.find({ taskId }, { projection: { _id: 1, type: 1, result: 1 } }).toArray();

  await tasks.deleteOne({ _id: taskId });
  await clipDrafts.deleteMany({ taskId });
  await jobs.deleteMany({ taskId, status: { $ne: "running" } });

  const storage = getStorage();
  const clipIds = new Set([...(task?.clips ?? []).map((clip) => clip.id), ...drafts.map((draft) => draft._id)]);
  const deletions: Promise<void>[] = [
    storage.deletePrefix(storageKeys.taskClipsDir(taskId)),
    ...[...clipIds].map((clipId) => storage.deletePrefix(storageKeys.editorDir(clipId))),
    ...taskJobs.flatMap((job) => {
      const key = jobFileKey(job);
      return key ? [storage.delete(key)] : [];
    }),
  ];
  const upload = task?.source.type === "upload" ? uploadKeys(task.source.url) : null;
  if (task && upload && !(await tasks.countDocuments({ userId: task.userId, "source.url": task.source.url }))) {
    deletions.push(storage.delete(upload.video), storage.delete(upload.transcript));
  }
  const results = await Promise.allSettled(deletions);
  for (const result of results) {
    if (result.status === "rejected") console.warn(`[tasks] Could not delete a file of task ${taskId}`, result.reason);
  }
}

/**
 * Account deletion (Better Auth `beforeDelete`): every task, job, draft and font of the user, plus
 * their YouTube account doc, posts and OAuth states, with the token best-effort revoked last
 * (design §4.3; same delete-before-revoke order as `disconnectAccount`'s callers).
 */
export async function deleteAllUserData(userId: string): Promise<void> {
  const { tasks, clipDrafts, jobs, youtubePosts, oauthStates } = collections();
  for (const task of await tasks.find({ userId }, { projection: { _id: 1 } }).toArray()) {
    await deleteTaskCompletely(task._id);
  }
  await requestCancel({ userId });
  await jobs.deleteMany({ userId, status: { $ne: "running" } });
  await clipDrafts.deleteMany({ userId });
  await getStorage().deletePrefix(storageKeys.userFontsDir(userId));
  const revoke = await disconnectAccount(userId);
  await youtubePosts.deleteMany({ userId });
  await oauthStates.deleteMany({ userId });
  if (revoke) await revoke();
}

export const WORKER_STOPPED_TASK_MESSAGE = "The worker stopped while processing this video. Resume to try again.";
export const RESTYLE_FAILED_MESSAGE = "Restyle failed. Your existing clips are unchanged.";

/**
 * The `$set` for a restyle that ends without replacing the clips (cancel, failure, worker died): the
 * task is completed again with the settings the old clips were rendered with (the settings route put
 * them in `payload.previousSettings`), as SupoClip's edit transaction rolled them back.
 */
export function restyleRollback(job: Pick<JobDoc, "payload">, message: string) {
  const previous = job.payload?.previousSettings as TaskSettings | undefined;
  return { status: "completed" as const, progress: 100, progressMessage: message, ...(previous && { settings: previous }) };
}

// --- Preset exports (port of clip_export_service.py) ---

export const EXPORT_PRESETS = ["tiktok", "reels", "shorts"] as const;
export type ExportPreset = (typeof EXPORT_PRESETS)[number];
export const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const EXPORT_FAILED_MESSAGE = "Export failed. Try again.";
export const EXPORT_FILE_MISSING_MESSAGE = "Export file is no longer available.";
export const EXPORT_EXPIRED_MESSAGE = "Export expired.";

export function exportPreset(value: unknown): ExportPreset {
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!EXPORT_PRESETS.includes(name as ExportPreset)) {
    throw new ApiError(400, `Invalid preset. Use one of: ${EXPORT_PRESETS.join(", ")}`);
  }
  return name as ExportPreset;
}

/** One export per clip file and preset: a re-rendered clip has a new filename, so a new key. */
export function exportLiveKey(clip: Pick<ClipDoc, "id" | "filename">, preset: ExportPreset): string {
  const hash = createHash("sha256").update(JSON.stringify({ filename: clip.filename, preset })).digest("hex");
  return `${clip.id}:${hash}`;
}

/** `export_download_filename`: `{clip stem}_{preset}.mp4`, at most 255 characters. */
export function exportDownloadFilename(clipFilename: string, preset: string): string {
  const suffix = `_${preset}.mp4`;
  let stem = clipFilename.split("/").pop() ?? "";
  if (stem.toLowerCase().endsWith(".mp4")) stem = stem.slice(0, -4);
  stem = stem.replace(/["\r\n/\\]/g, "").trim() || "clip";
  return `${stem.slice(0, 255 - suffix.length)}${suffix}`;
}

/** A succeeded export whose file is gone or expired becomes failed, which frees its liveKey. */
export async function checkExportFile(job: JobDoc): Promise<JobDoc> {
  if (job.status !== "succeeded") return job;
  const key = jobFileKey(job)!;
  const expired = Boolean(job.expiresAt && job.expiresAt.getTime() <= Date.now());
  if (!expired && (await getStorage().stat(key))) return job;
  const error = expired ? EXPORT_EXPIRED_MESSAGE : EXPORT_FILE_MISSING_MESSAGE;
  await collections().jobs.updateOne(
    { _id: job._id, status: "succeeded" },
    { $set: { status: "failed", error, updatedAt: new Date() }, $unset: { liveKey: "" } },
  );
  await getStorage().delete(key).catch((cause) => console.warn(`[tasks] Could not delete export ${job._id}`, cause));
  return { ...job, status: "failed", error };
}

/** Queue an `export_clip` job, or reuse the live one for the same clip file and preset. */
export async function startPresetExport(task: TaskDoc, clip: ClipDoc, preset: ExportPreset): Promise<JobDoc> {
  const enqueue = () =>
    enqueueJob({
      type: "export_clip",
      taskId: task._id,
      clipId: clip.id,
      userId: task.userId,
      liveKey: exportLiveKey(clip, preset),
      payload: { preset, filename: clip.filename },
    });
  const { job, created } = await enqueue();
  if (created) return job;
  const holder = await checkExportFile(job);
  return holder.status === "failed" ? (await enqueue()).job : holder;
}

export async function getPresetExport(task: TaskDoc, clip: ClipDoc, exportId: string): Promise<JobDoc> {
  const job = await collections().jobs.findOne({ _id: exportId, type: "export_clip", taskId: task._id, clipId: clip.id });
  if (!job) throw new ApiError(404, "Export not found");
  return checkExportFile(job);
}

/** The preset-export status vocabulary (DESIGN §6.3). The client builds the file URL itself. */
export function serializePresetExport(job: JobDoc) {
  const status = job.status === "cancelled" ? "failed" : job.status;
  return {
    id: job._id,
    status,
    progress: Math.trunc(job.progress || 0),
    preset: typeof job.payload.preset === "string" ? job.payload.preset : "",
    error: status === "failed" ? (job.error ?? EXPORT_FAILED_MESSAGE) : null,
    download_url: null,
  };
}

// --- Serializers (the JSON shapes the client reads) ---

const sourceType = (task: Pick<TaskDoc, "source">) => (task.source.type === "youtube" ? "youtube" : "video_url");

export function serializeTaskSummary(task: TaskSummaryDoc) {
  let cover: Pick<ClipDoc, "id" | "viralityScore"> | null = null;
  for (const clip of task.clips ?? []) {
    if (!cover || clip.viralityScore > cover.viralityScore) cover = clip;
  }
  return {
    id: task._id,
    user_id: task.userId,
    source_id: task._id,
    source_title: task.source.title,
    source_type: sourceType(task),
    source_url: task.source.url,
    status: task.status,
    run_type: runType(task),
    clips_count: task.clips?.length ?? 0,
    top_virality_score: cover?.viralityScore ?? null,
    cover_clip_id: cover?.id ?? null,
    created_at: task.createdAt.toISOString(),
    updated_at: task.updatedAt.toISOString(),
  };
}

export function serializeTask(task: TaskDoc) {
  const { settings } = task;
  return {
    id: task._id,
    user_id: task.userId,
    source_id: task._id,
    source_title: task.source.title,
    source_type: sourceType(task),
    source_url: task.source.url,
    status: task.status,
    run_type: runType(task),
    progress: task.progress,
    progress_message: task.progressMessage,
    font_family: settings.fontFamily,
    font_size: settings.fontSize,
    font_color: settings.fontColor,
    caption_template: settings.captionTemplate,
    output_format: settings.outputFormat,
    add_subtitles: settings.addSubtitles,
    clip_length: settings.clipLength,
    cut_long_pauses: settings.cutLongPauses,
    pause_threshold_ms: settings.pauseThresholdMs,
    remove_filler_words: settings.removeFillerWords,
    filtered_words: settings.filteredWords,
    clips_count: task.clips.length,
    created_at: task.createdAt.toISOString(),
    updated_at: task.updatedAt.toISOString(),
  };
}

export function serializeClip(taskId: string, clip: ClipDoc, index: number) {
  return {
    id: clip.id,
    filename: clip.filename,
    start_time: clip.startTime,
    end_time: clip.endTime,
    duration: clip.duration,
    text: clip.text,
    relevance_score: clip.relevanceScore,
    reasoning: clip.reasoning,
    clip_order: index + 1,
    created_at: clip.createdAt.toISOString(),
    video_url: `/api/tasks/${taskId}/clips/${clip.id}/file`,
    virality_score: clip.viralityScore,
    hook_score: clip.hookScore,
    engagement_score: clip.engagementScore,
    value_score: clip.valueScore,
    shareability_score: clip.shareabilityScore,
    hook_type: clip.hookType,
    hook_title: clip.hookTitle,
  };
}

export function serializeClips(task: TaskDoc) {
  return task.clips.map((clip, index) => serializeClip(task._id, clip, index));
}
