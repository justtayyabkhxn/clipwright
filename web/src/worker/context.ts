// What every job handler gets: its work dir, a stop signal fed by the lease heartbeat, throttled
// progress, and an engine runner that fills in the common request fields.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runEngine, type EngineEvent } from "../server/engine";
import { env, paths } from "../server/env";
import { fontDirs } from "../server/fonts";
import { HEARTBEAT_MS, heartbeatJob, LEASE_MS, type JobOutcome } from "../server/jobs";
import { getStorage, storageKeys, uploadKeys } from "../server/storage";
import { youtubeVideoId } from "../server/tasks";
import type { ClipDoc, JobDoc, TaskDoc, TaskSettings } from "../server/types";

export type EngineRunner = typeof runEngine;

/** Seams the tests replace: the engine process and the Anthropic transport. */
export type WorkerDeps = { runEngine: EngineRunner; fetch?: typeof globalThis.fetch; heartbeatMs?: number };

export const defaultDeps: WorkerDeps = { runEngine };

/** Why a job stops before its handler finished: the user cancelled, the lease was lost, or shutdown. */
export type StopReason = "cancelled" | "lost" | "shutdown";

/** A compare-and-set on the task missed: it was cancelled, deleted or taken over by a newer run. */
export class TaskCancelled extends Error {
  constructor() {
    super("Task cancelled");
  }
}

/** A failure whose message is meant for the user as it is. */
export class UserError extends Error {}

export type JobContext = {
  job: JobDoc;
  deps: WorkerDeps;
  /** DATA_DIR/work/{jobId}/{claim token}: this attempt's own temp dir, removed when the job ends. */
  workDir: string;
  /** Aborted (reason = StopReason) when the job must stop; it also cancels the running engine. */
  signal: AbortSignal;
  readonly stopReason: StopReason | null;
  /** Throws the stop reason when the job must stop, a lapsed lease included. Call it before task writes. */
  throwIfStopped(): void;
  /** Job progress, written with the lease heartbeat at most once a second. */
  progress(pct: number, message?: string): Promise<void>;
  /** An engine command with work_dir, its own cancel_file, fonts_dirs and config filled in. */
  engine<T = Record<string, unknown>>(
    command: string,
    request: Record<string, unknown>,
    onEvent?: (event: EngineEvent) => void | Promise<void>,
  ): Promise<T>;
  dispose(): void;
};

const PROGRESS_THROTTLE_MS = 1000;

export function engineConfig() {
  return {
    speaker_framing: env.SPEAKER_FRAMING,
    hook_first_teaser: env.HOOK_FIRST_TEASER,
    transcription_language: env.TRANSCRIPTION_LANGUAGE,
    max_video_duration: env.MAX_VIDEO_DURATION,
    youtube_max_height: env.YOUTUBE_MAX_HEIGHT,
    assembly_ai_http_timeout_seconds: env.ASSEMBLY_AI_HTTP_TIMEOUT_SECONDS,
    assemblyai_base_url: env.ASSEMBLYAI_BASE_URL ?? null,
  };
}

export async function createJobContext(
  job: JobDoc,
  deps: WorkerDeps = defaultDeps,
  shutdown?: AbortSignal,
): Promise<JobContext> {
  // One dir per claim (lockedBy is "{workerId}:{token}"): an attempt whose lease was re-claimed never
  // deletes the new attempt's files, and its cancel files never stop the new attempt's engine.
  const claim = job.lockedBy?.split(":").pop() || randomUUID().slice(0, 8);
  const workDir = path.join(paths.workRoot, job._id, claim);
  await fs.mkdir(workDir, { recursive: true });
  const fontsDirs = await fontDirs(job.userId);
  const controller = new AbortController();
  let stopReason: StopReason | null = null;
  const stop = (reason: StopReason) => {
    if (stopReason) return;
    stopReason = reason;
    controller.abort(reason);
  };
  const onShutdown = () => stop("shutdown");
  if (shutdown?.aborted) onShutdown();
  shutdown?.addEventListener("abort", onShutdown, { once: true });

  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  let leaseUntil = job.lockedUntil?.getTime() ?? Date.now() + LEASE_MS;
  // No beat got through for most of the lease (a Mongo outage, a stalled event loop, a sleeping
  // laptop): another worker may re-claim the job at any moment, so stop before the next write.
  // ponytail: task writes are fenced by this clock and run.jobId; a claim token in the task filter would also fence a write already in flight.
  const checkLease = () => {
    if (Date.now() >= leaseUntil - heartbeatMs) stop("lost");
  };
  const beat = async (update: { progress?: number; message?: string } = {}) => {
    if (stopReason === "lost") return;
    const sentAt = Date.now();
    try {
      const live = await heartbeatJob(job, update);
      if (!live) return stop("lost");
      leaseUntil = Math.max(leaseUntil, sentAt + LEASE_MS);
      if (live.cancelRequested) stop("cancelled");
    } catch (error) {
      // A Mongo blip: keep going, the next beat retries well inside the lease.
      console.warn(`[worker] Heartbeat for job ${job._id} failed`, error);
    }
  };
  const ticker = setInterval(() => {
    checkLease();
    void beat();
  }, heartbeatMs);
  let lastProgressAt = 0;
  let engineRuns = 0;

  return {
    job,
    deps,
    workDir,
    signal: controller.signal,
    get stopReason() {
      return stopReason;
    },
    throwIfStopped() {
      checkLease();
      controller.signal.throwIfAborted();
    },
    async progress(pct, message) {
      const now = Date.now();
      if (now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
      lastProgressAt = now;
      await beat({ progress: Math.max(0, Math.min(100, Math.round(pct))), ...(message !== undefined && { message }) });
    },
    engine(command, request, onEvent) {
      const cancelFile = path.join(workDir, `cancel-${++engineRuns}`);
      return deps.runEngine(
        command,
        { work_dir: workDir, cancel_file: cancelFile, fonts_dirs: fontsDirs, config: engineConfig(), ...request },
        { onEvent, signal: controller.signal, cancelFile },
      );
    },
    dispose() {
      clearInterval(ticker);
      shutdown?.removeEventListener("abort", onShutdown);
    },
  };
}

// --- Sources ---

/** The local file of a task's source. YouTube: the shared cached download, fetched again when gone. */
export async function sourceVideoPath(ctx: JobContext, task: TaskDoc, missingMessage: string): Promise<string> {
  const storage = getStorage();
  if (task.source.type === "upload") {
    const keys = uploadKeys(task.source.url);
    if (!keys || !(await storage.stat(keys.video))) throw new UserError(missingMessage);
    return storage.localPath(keys.video);
  }
  let videoId = task.source.videoId ?? youtubeVideoId(task.source.url);
  if (!videoId) videoId = (await ctx.engine<{ video_id: string }>("youtube-info", { url: task.source.url })).video_id;
  return fetchYoutube(ctx, task.source.url, videoId);
}

/** `fetch-youtube` into the durable source key; the engine reuses the file when it exists. */
export async function fetchYoutube(ctx: JobContext, url: string, videoId: string): Promise<string> {
  const output = await getStorage().localPath(storageKeys.youtubeSource(videoId));
  const result = await ctx.engine<{ video_path: string }>("fetch-youtube", {
    url,
    video_id: videoId,
    output_path: output,
    max_height: env.YOUTUBE_MAX_HEIGHT,
  });
  return result.video_path;
}

/** A clip's source ranges, falling back to its MM:SS labels like `_get_clip_source_ranges`. */
export function clipSourceRanges(clip: { sourceRanges?: { start: number; end: number }[]; startTime: string; endTime: string }) {
  if (clip.sourceRanges?.length) return clip.sourceRanges;
  const seconds = (label: string) => label.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  const start = seconds(clip.startTime);
  const end = seconds(clip.endTime);
  return Number.isFinite(start) && end > start ? [{ start, end }] : [];
}

// --- render-clips ---

/** One `clip` event of `render-clips`. */
export type EngineClip = {
  index: number;
  filename: string;
  path: string;
  start_time: string;
  end_time: string;
  duration: number;
  text: string;
  keep_ranges: [number, number][];
  source_ranges: { start: number; end: number }[];
  caption_settings?: ClipDoc["captionSettings"];
};

export type ClipScores = Pick<
  ClipDoc,
  | "relevanceScore"
  | "reasoning"
  | "viralityScore"
  | "hookScore"
  | "engagementScore"
  | "valueScore"
  | "shareabilityScore"
  | "hookType"
  | "hookTitle"
>;

export function renderOptions(settings: TaskSettings, maxClipSeconds: number) {
  return {
    output_format: settings.outputFormat,
    add_subtitles: settings.addSubtitles,
    caption_template: settings.captionTemplate,
    font_family: settings.fontFamily,
    font_size: settings.fontSize,
    font_color: settings.fontColor,
    cleanup: {
      cut_long_pauses: settings.cutLongPauses,
      pause_threshold_ms: settings.pauseThresholdMs,
      remove_filler_words: settings.removeFillerWords,
      filtered_words: settings.filteredWords,
    },
    max_clip_seconds: maxClipSeconds,
  };
}

export function clipDocFrom(taskId: string, rendered: EngineClip, scores: ClipScores): ClipDoc {
  const now = new Date();
  const id = randomUUID();
  return {
    id,
    filename: rendered.filename,
    storageKey: storageKeys.clip(taskId, rendered.filename),
    startTime: rendered.start_time,
    endTime: rendered.end_time,
    duration: rendered.duration,
    text: rendered.text,
    ...scores,
    sourceRanges: rendered.source_ranges,
    keepRanges: rendered.keep_ranges,
    ...(rendered.caption_settings && { captionSettings: rendered.caption_settings }),
    lineageId: id,
    createdAt: now,
    updatedAt: now,
  };
}

export const cancelledOutcome: JobOutcome = { status: "cancelled" };

/** First line of an error, for messages shown in the UI (engine errors can carry a stderr tail). */
export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0].trim();
}
