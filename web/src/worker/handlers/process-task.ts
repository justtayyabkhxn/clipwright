// process_task: port of TaskService.process_task + VideoService.process_video_complete (DESIGN §6.2).
// The progress messages are a UI contract.

import { createHash } from "node:crypto";
import path from "node:path";
import { parseSelectClipsResult, selectClips, type SelectClipsResult, type TranscriptSegment } from "../../server/ai";
import { collections } from "../../server/db";
import { EngineError } from "../../server/engine";
import { env } from "../../server/env";
import type { JobOutcome } from "../../server/jobs";
import { getRuntimeSettings } from "../../server/settings";
import { getStorage, uploadKeys } from "../../server/storage";
import {
  casStatus,
  CLIP_DURATIONS,
  clearClips,
  getTask,
  normalizeClipLength,
  pushClip,
  secondsToMmss,
} from "../../server/tasks";
import type { ClipLength, TaskDoc } from "../../server/types";
import { getAccount } from "../../server/youtube/accounts";
import { channelNotesFor } from "../../server/youtube/insights";
import { createPostsForTask } from "../../server/youtube/posts";
import {
  cancelledOutcome,
  clipDocFrom,
  errorMessage,
  fetchYoutube,
  renderOptions,
  TaskCancelled,
  UserError,
  type ClipScores,
  type EngineClip,
  type JobContext,
} from "../context";

export const CACHE_VERSION = "clipwright-v1";
const FAST_MODE_MAX_CLIPS = 10;
const YOUTUBE_PLACEHOLDER_TITLE = "YouTube Video";

export const MISSING_ANTHROPIC_KEY = "Add your Anthropic API key in Settings → AI before generating clips.";
export const MISSING_ASSEMBLYAI_KEY = "Add your AssemblyAI API key in Settings → AI before generating clips.";
export const NO_CLIPS_RENDERED = "No clips could be rendered. Please try again.";
export const FALLBACK_REASONING =
  "AI analysis did not identify a strong standalone segment, so Clipwright generated the first available portion of the video.";

/** `processing_cache._id` (DESIGN §5). */
export function processingCacheKey(sourceType: string, url: string): string {
  return createHash("sha256").update(`${sourceType}|fast|${CACHE_VERSION}|${url.trim()}`, "utf8").digest("hex");
}

/** `run.errorCode` from the task error message (task_service.py rules). */
export function errorCodeFor(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("download") || lower.includes("youtube")) return "download_error";
  if (lower.includes("analysis")) return "analysis_error";
  if (lower.includes("transcript")) return "transcription_error";
  if (lower.includes("cancelled")) return "cancelled";
  return "task_error";
}

/** Engine and user-facing messages pass through; anything else is wrapped. */
function taskErrorMessage(error: unknown): string {
  if (error instanceof UserError || error instanceof EngineError) return errorMessage(error);
  return `Processing failed: ${errorMessage(error)}`;
}

function cachedAnalysis(json: string | undefined): SelectClipsResult | null {
  if (!json) return null;
  try {
    const result = parseSelectClipsResult(JSON.parse(json));
    // Like the original, an analysis without segments is not worth reusing.
    return result.segments.length ? result : null;
  } catch {
    return null;
  }
}

type RenderPlan = { segment: Record<string, unknown>; scores: ClipScores };

function planFromSegment(segment: TranscriptSegment): RenderPlan {
  const v = segment.virality;
  return {
    segment: {
      start_time: segment.start_time,
      end_time: segment.end_time,
      text: segment.text,
      hook_title: segment.hook_title,
      hook_start_time: segment.hook_start_time,
      hook_end_time: segment.hook_end_time,
    },
    scores: {
      relevanceScore: segment.relevance_score,
      reasoning: segment.reasoning,
      viralityScore: v.total_score,
      hookScore: v.hook_score,
      engagementScore: v.engagement_score,
      valueScore: v.value_score,
      shareabilityScore: v.shareability_score,
      hookType: v.hook_type,
      hookTitle: segment.hook_title,
      viralityReasoning: v.virality_reasoning,
    },
  };
}

/** `_build_fallback_segment`: the opening of the video when the analysis picked nothing. */
function fallbackPlan(videoDuration: number, transcript: string, clipLength: ClipLength): RenderPlan {
  const target = clipLength === "auto" ? env.CLIP_DURATION : CLIP_DURATIONS[clipLength].idealMinimum;
  let seconds = Math.max(1, target || 30);
  if (videoDuration > 0) seconds = Math.min(seconds, Math.max(1, videoDuration));
  let preview = transcript.split(/\s+/).filter(Boolean).join(" ");
  if (preview.length > 240) preview = `${preview.slice(0, 237)}...`;
  return {
    segment: { start_time: "00:00", end_time: secondsToMmss(seconds), text: preview, hook_title: null },
    scores: {
      relevanceScore: 0.25,
      reasoning: FALLBACK_REASONING,
      viralityScore: 0,
      hookScore: 0,
      engagementScore: 0,
      valueScore: 0,
      shareabilityScore: 0,
      hookType: "fallback",
      hookTitle: null,
    },
  };
}

async function saveCache(key: string, task: TaskDoc, set: Record<string, string>) {
  const now = new Date();
  await collections().processingCache.updateOne(
    { _id: key },
    {
      $set: { sourceUrl: task.source.url.trim(), sourceType: task.source.type, ...set, updatedAt: now },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}

export async function processTask(ctx: JobContext): Promise<JobOutcome> {
  const { job } = ctx;
  const taskId = job.taskId;
  const runFilter = { "run.jobId": job._id };
  const started = await casStatus(
    taskId,
    ["queued", "processing"],
    { status: "processing", progress: 0, progressMessage: "Starting...", "run.startedAt": new Date() },
    runFilter,
  );
  // Not this run's task any more (cancelled, deleted, or a newer job owns it).
  if (!started) return cancelledOutcome;

  const step = async (progress: number, message: string, extra: Record<string, unknown> = {}) => {
    ctx.throwIfStopped();
    if (!(await casStatus(taskId, ["processing"], { progress, progressMessage: message, ...extra }, runFilter))) {
      throw new TaskCancelled();
    }
    await ctx.progress(progress, message);
  };

  try {
    const task = await getTask(taskId);
    if (!task) throw new TaskCancelled();
    const settings = await getRuntimeSettings();
    if (!settings.anthropicApiKey) throw new UserError(MISSING_ANTHROPIC_KEY);
    if (!settings.assemblyAiApiKey) throw new UserError(MISSING_ASSEMBLYAI_KEY);

    const clipLength = normalizeClipLength(task.settings.clipLength);
    const cacheKey = processingCacheKey(task.source.type, task.source.url);
    const cache = await collections().processingCache.findOne({ _id: cacheKey });
    let analysis = cachedAnalysis(cache?.analyses?.[clipLength]);

    await step(10, "Downloading video...", { "run.cacheHit": Boolean(cache?.transcriptText && analysis) });
    const storage = getStorage();
    let videoPath: string;
    if (task.source.type === "youtube") {
      const info = await ctx.engine<{ video_id: string; title?: string | null; duration?: number | null }>(
        "youtube-info",
        { url: task.source.url },
      );
      const duration = Number(info.duration) || 0;
      if (duration > env.MAX_VIDEO_DURATION) {
        throw new UserError(
          `Video is too long (${Math.floor(duration / 60)} min). ` +
            `Maximum allowed duration is ${Math.floor(env.MAX_VIDEO_DURATION / 60)} minutes.`,
        );
      }
      const source: Record<string, unknown> = { "source.videoId": info.video_id };
      if (duration) source["source.durationSeconds"] = duration;
      if (task.source.title === YOUTUBE_PLACEHOLDER_TITLE && info.title?.trim()) source["source.title"] = info.title.trim();
      if (!(await casStatus(taskId, ["processing"], source, runFilter))) throw new TaskCancelled();
      videoPath = await fetchYoutube(ctx, task.source.url, info.video_id);
    } else {
      const keys = uploadKeys(task.source.url);
      if (!keys || !(await storage.stat(keys.video))) throw new UserError("Video file not found");
      videoPath = await storage.localPath(keys.video);
    }

    await step(15, "Preparing video...");
    const prepared = await ctx.engine<{ duration: number }>("prepare-source", {
      video_path: videoPath,
      max_duration_seconds: env.MAX_VIDEO_DURATION,
    });

    await step(30, "Generating transcript...");
    const { transcript_text: transcript } = await ctx.engine<{ transcript_text: string }>("transcribe", {
      video_path: videoPath,
      assemblyai_api_key: settings.assemblyAiApiKey,
    });
    await saveCache(cacheKey, task, { transcriptText: transcript });

    await step(50, "Analyzing content with AI...");
    if (!analysis) {
      const { clip_signals: clipSignals } = await ctx.engine<{ clip_signals: string | null }>("signals", {
        video_path: videoPath,
        transcript_text: transcript,
      });
      // What performs on the user's channel nudges selection; never worth failing a task over.
      const channelNotes = await channelNotesFor(task.userId).catch((error) => {
        console.warn(`[worker] Task ${taskId}: channel notes unavailable: ${errorMessage(error)}`);
        return null;
      });
      try {
        analysis = await selectClips({
          transcript,
          clipSignals,
          channelNotes,
          clipLength,
          apiKey: settings.anthropicApiKey,
          model: settings.claudeModel,
          rerankModel: settings.claudeRerankModel,
          maxClips: env.MAX_CLIPS,
          signal: ctx.signal,
          fetch: ctx.deps.fetch,
        });
      } catch (error) {
        if (ctx.stopReason) throw error;
        throw new UserError(errorMessage(error));
      }
      await saveCache(cacheKey, task, { [`analyses.${clipLength}`]: JSON.stringify(analysis) });
    }

    await step(70, "Creating video clips...");
    let plans = analysis.segments.slice(0, Math.max(1, Math.min(env.MAX_CLIPS, FAST_MODE_MAX_CLIPS))).map(planFromSegment);
    if (!plans.length) plans = [fallbackPlan(prepared.duration, transcript, clipLength)];

    if (!(await clearClips(taskId, job._id))) throw new TaskCancelled();
    let pushed = 0;
    await ctx.engine(
      "render-clips",
      {
        video_path: videoPath,
        output_dir: path.join(ctx.workDir, "clips"),
        segments: plans.map((plan) => plan.segment),
        options: renderOptions(task.settings, CLIP_DURATIONS[clipLength].maximum),
      },
      async (event) => {
        if (event.type === "clip_start") {
          await step(70 + Math.floor(((event.index + 1) / plans.length) * 25), `Creating clip ${event.index + 1}/${plans.length}...`);
        } else if (event.type === "clip") {
          const rendered = event.clip as EngineClip;
          const clip = clipDocFrom(taskId, rendered, plans[event.index].scores);
          ctx.throwIfStopped();
          await storage.putFile(clip.storageKey, rendered.path);
          if (!(await pushClip(taskId, job._id, clip))) {
            await storage.delete(clip.storageKey);
            throw new TaskCancelled();
          }
          pushed++;
        } else if (event.type === "clip_failed") {
          console.warn(`[worker] Task ${taskId}: clip ${event.index + 1} failed: ${event.message}`);
        }
      },
    );

    if (!pushed) throw new UserError(NO_CLIPS_RENDERED);
    ctx.throwIfStopped();
    // §4.4: the auto-post flag rides on the completion CAS itself, so a crash before the posts exist
    // leaves the task "pending" for the cron. Any status counts: a reconnect or resume releases the posts.
    const autopost = (await getAccount(job.userId))?.autoPost === true;
    const completed = await casStatus(
      taskId,
      ["processing"],
      {
        status: "completed",
        progress: 100,
        progressMessage: "Complete!",
        "run.completedAt": new Date(),
        analysis: { summary: analysis.summary, keyTopics: analysis.keyTopics },
        ...(autopost && { autopost: "pending" as const }),
      },
      runFilter,
    );
    if (completed && autopost) {
      try {
        await createPostsForTask(taskId);
      } catch (error) {
        // The task is complete either way; the cron re-runs a task left "pending".
        console.error(`[worker] Task ${taskId}: could not create the YouTube posts`, error);
      }
    }
    return completed ? { status: "succeeded", result: { clips: pushed } } : cancelledOutcome;
  } catch (error) {
    if (ctx.stopReason) throw error;
    if (error instanceof TaskCancelled) return cancelledOutcome;
    const message = taskErrorMessage(error);
    console.error(`[worker] Task ${taskId} failed: ${message}`, error instanceof UserError ? "" : error);
    const failed = await casStatus(
      taskId,
      ["queued", "processing"],
      {
        status: "error",
        progress: 0,
        progressMessage: message,
        "run.errorCode": errorCodeFor(message),
        "run.completedAt": new Date(),
      },
      runFilter,
    );
    return failed ? { status: "failed", error: message } : cancelledOutcome;
  }
}
