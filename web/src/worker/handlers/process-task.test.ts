/** @vitest-environment node */
import path from "node:path";
import type { Timestamp } from "mongodb";
import { describe, expect, it } from "vitest";
import { errorResponse, fakeFetch, messageResponse } from "../../server/ai/__fixtures__/fake-anthropic";
import { collections, getDb } from "../../server/db";
import { EngineError } from "../../server/engine";
import { paths, resetEnv } from "../../server/env";
import { requestCancel } from "../../server/jobs";
import { getStorage, storageKeys } from "../../server/storage";
import { casStatus } from "../../server/tasks";
import { runJob } from "../run-job";
import {
  claimed,
  clipFixture,
  exists,
  fakeEngine,
  fakeRender,
  seedTask,
  untilAborted,
  setupWorkerTestEnv,
  writeFile,
  type FakeCommand,
} from "../test-utils";
import {
  FALLBACK_REASONING,
  MISSING_ANTHROPIC_KEY,
  MISSING_ASSEMBLYAI_KEY,
  NO_CLIPS_RENDERED,
  processingCacheKey,
} from "./process-task";

setupWorkerTestEnv("process", {
  replSet: true,
  env: { ANTHROPIC_API_KEY: "sk-ant-test-key-1234", ASSEMBLY_AI_API_KEY: "aai-test-key", CLAUDE_MODEL: "claude-sonnet-5" },
});

const UPLOAD = "upload://00000000-0000-4000-8000-000000000001.mp4";
const TRANSCRIPT = [
  "[00:00 - 00:20] Speaker A: Here is the one habit that doubled my output in a single month of work.",
  "[00:20 - 00:45] Speaker A: Most people never try it because it sounds far too simple to matter at all.",
  "[00:45 - 01:10] Speaker B: Then the results show up and everyone asks what changed so quickly for me.",
].join("\n");

const virality = (hook: number) => ({ hook_score: hook, engagement_score: 18, value_score: 17, shareability_score: 15 });
const ANALYSIS = {
  most_relevant_segments: [
    {
      start_time: "00:00",
      end_time: "00:20",
      text: "Here is the one habit that doubled my output in a single month of work.",
      relevance_score: 0.9,
      reasoning: "Strong opening claim",
      virality: { ...virality(20), hook_type: "statement", virality_reasoning: "Bold" },
      hook_title: "The habit that doubled my output",
    },
    {
      start_time: "00:45",
      end_time: "01:10",
      text: "Then the results show up and everyone asks what changed so quickly for me.",
      relevance_score: 0.7,
      reasoning: "Payoff",
      virality: { ...virality(10), hook_type: "story", virality_reasoning: "Payoff" },
      hook_title: "Everyone asks what changed",
    },
  ],
  summary: "Productivity",
  key_topics: ["habits"],
};

const claude = (analysis: unknown = ANALYSIS) => fakeFetch(() => messageResponse(analysis));

function uploadEngine(overrides: Record<string, FakeCommand> = {}) {
  return fakeEngine({
    "prepare-source": () => ({ duration: 70, width: 1920, height: 1080, normalized: false }),
    transcribe: () => ({ transcript_text: TRANSCRIPT, language_code: "en", word_count: 40 }),
    signals: () => ({ clip_signals: null }),
    "render-clips": fakeRender(),
    ...overrides,
  });
}

async function queuedTask(overrides: Parameters<typeof seedTask>[0] = {}) {
  const jobId = "a".repeat(31) + String(Math.floor(Math.random() * 10));
  const task = await seedTask({ source: { type: "upload", url: UPLOAD, title: "Talk" }, run: { jobId }, ...overrides });
  const keys = { video: "uploads/00000000-0000-4000-8000-000000000001.mp4" };
  await writeFile(await getStorage().localPath(keys.video), "video");
  const job = await claimed({ id: jobId, type: "process_task", taskId: task._id, userId: task.userId, activeKey: `task:${task._id}` });
  return { task, job };
}

const task = (id: string) => collections().tasks.findOne({ _id: id });
const jobDoc = (id: string) => collections().jobs.findOne({ _id: id });

async function clusterTime(): Promise<Timestamp> {
  return (await getDb().command({ ping: 1 })).operationTime as Timestamp;
}

/** Every progress message written to the task since `since`, in order (read from the oplog). */
async function messagesSince(since: Timestamp, taskId: string, last: string): Promise<string[]> {
  const stream = collections().tasks.watch([{ $match: { "documentKey._id": taskId } }], { startAtOperationTime: since });
  const messages: string[] = [];
  const deadline = Date.now() + 10_000;
  try {
    while (messages.at(-1) !== last && Date.now() < deadline) {
      const change = await stream.tryNext();
      const fields = change && "updateDescription" in change ? change.updateDescription?.updatedFields : undefined;
      // An unchanged value is not reported: "Starting..." keeps the seeded progress 0.
      if (typeof fields?.progressMessage === "string") messages.push(`${fields.progress ?? 0} ${fields.progressMessage}`);
    }
  } finally {
    await stream.close();
  }
  return messages;
}

describe("process_task", () => {
  it("runs the pipeline with the exact progress messages and stores the clips", async () => {
    const { task: seeded, job } = await queuedTask();
    const engine = uploadEngine();
    const fetch = claude();
    const since = await clusterTime();

    expect(await runJob(job, { runEngine: engine.runEngine, fetch: fetch.fetch })).toEqual({
      status: "succeeded",
      result: { clips: 2 },
    });

    expect(await messagesSince(since, seeded._id, "100 Complete!")).toEqual([
      "0 Starting...",
      "10 Downloading video...",
      "15 Preparing video...",
      "30 Generating transcript...",
      "50 Analyzing content with AI...",
      "70 Creating video clips...",
      "82 Creating clip 1/2...",
      "95 Creating clip 2/2...",
      "100 Complete!",
    ]);
    expect(engine.commands()).toEqual(["prepare-source", "transcribe", "signals", "render-clips"]);
    const [prepare, transcribe, , render] = engine.calls;
    const videoPath = await getStorage().localPath("uploads/00000000-0000-4000-8000-000000000001.mp4");
    expect(prepare.request).toMatchObject({ video_path: videoPath, max_duration_seconds: 5400 });
    expect(transcribe.request.assemblyai_api_key).toBe("aai-test-key");
    expect(render.request).toMatchObject({
      work_dir: path.join(paths.workRoot, job._id, job.lockedBy!.split(":").pop()!),
      fonts_dirs: [paths.bundledFontsDir, expect.stringContaining(path.join("storage", "fonts", "user-1"))],
      config: { speaker_framing: true, hook_first_teaser: false, max_video_duration: 5400, youtube_max_height: 1080 },
      segments: [
        { start_time: "00:00", end_time: "00:20", hook_title: "The habit that doubled my output" },
        { start_time: "00:45", end_time: "01:10", hook_title: "Everyone asks what changed" },
      ],
      options: {
        output_format: "vertical",
        add_subtitles: true,
        caption_template: "default",
        cleanup: { cut_long_pauses: true, pause_threshold_ms: 1200, remove_filler_words: true, filtered_words: [] },
        max_clip_seconds: 60,
      },
    });
    expect(String(render.request.cancel_file)).toMatch(/cancel-\d+$/);
    expect(fetch.requests[0].body.model).toBe("claude-sonnet-5");

    const done = (await task(seeded._id))!;
    expect(done).toMatchObject({ status: "completed", progress: 100, progressMessage: "Complete!" });
    expect(done.run).toMatchObject({ jobId: job._id, cacheHit: false, startedAt: expect.any(Date), completedAt: expect.any(Date) });
    expect(done.clips).toHaveLength(2);
    expect(done.clips[0]).toMatchObject({
      filename: expect.stringMatching(/^clip_1_0000-0020_/),
      storageKey: `clips/${seeded._id}/${done.clips[0].filename}`,
      startTime: "00:00",
      endTime: "00:20",
      text: expect.stringContaining("rendered Here is the one habit"),
      relevanceScore: 0.9,
      reasoning: "Strong opening claim",
      viralityScore: 70,
      hookScore: 20,
      hookType: "statement",
      hookTitle: "The habit that doubled my output",
      sourceRanges: [{ start: 0, end: 8 }],
      keepRanges: [[0, 8]],
      captionSettings: { font_size: 32, position_y: 0.7 },
    });
    for (const clip of done.clips) expect(await getStorage().stat(clip.storageKey)).not.toBeNull();
    for (const clip of done.clips) expect(clip.lineageId).toBe(clip.id);
    expect((await jobDoc(job._id))!).toMatchObject({ status: "succeeded", progress: 100 });
    expect(await exists(path.join(paths.workRoot, job._id))).toBe(false);

    const cache = await collections().processingCache.findOne({ _id: processingCacheKey("upload", UPLOAD) });
    expect(cache).toMatchObject({ sourceUrl: UPLOAD, sourceType: "upload", transcriptText: TRANSCRIPT });
    expect(JSON.parse(cache!.analyses!.auto!).segments).toHaveLength(2);
  });

  it("reuses a cached analysis without calling Claude or the signals step", async () => {
    const { task: seeded, job } = await queuedTask();
    await collections().processingCache.insertOne({
      _id: processingCacheKey("upload", UPLOAD),
      sourceUrl: UPLOAD,
      sourceType: "upload",
      transcriptText: TRANSCRIPT,
      analyses: { auto: JSON.stringify({ segments: ANALYSIS.most_relevant_segments.slice(0, 1), summary: "", keyTopics: [] }) },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const engine = uploadEngine();
    const fetch = claude();
    await runJob(job, { runEngine: engine.runEngine, fetch: fetch.fetch });

    expect(engine.commands()).toEqual(["prepare-source", "transcribe", "render-clips"]);
    expect(fetch.requests).toHaveLength(0);
    expect((await task(seeded._id))!).toMatchObject({ status: "completed", run: { cacheHit: true } });
    expect((await task(seeded._id))!.clips).toHaveLength(1);
  });

  it("renders the opening as a fallback clip when Claude picks nothing", async () => {
    const { task: seeded, job } = await queuedTask();
    const engine = uploadEngine();
    await runJob(job, { runEngine: engine.runEngine, fetch: claude({ most_relevant_segments: [], summary: "", key_topics: [] }).fetch });

    expect(engine.calls.at(-1)!.request.segments).toEqual([
      { start_time: "00:00", end_time: "00:30", text: expect.stringMatching(/^\[00:00 - 00:20\] Speaker A: Here is/), hook_title: null },
    ]);
    const [clip] = (await task(seeded._id))!.clips;
    expect(clip).toMatchObject({ hookType: "fallback", reasoning: FALLBACK_REASONING, relevanceScore: 0.25, viralityScore: 0 });
  });

  it("fetches a YouTube source into the shared cache and fills in its title", async () => {
    const jobId = "c".repeat(32);
    const seeded = await seedTask({
      source: { type: "youtube", url: "https://www.youtube.com/watch?v=abcdefghijk", title: "YouTube Video" },
      run: { jobId },
    });
    const job = await claimed({ id: jobId, type: "process_task", taskId: seeded._id, userId: seeded.userId });
    const engine = uploadEngine({
      "youtube-info": () => ({ video_id: "abcdefghijk", title: "A real title", duration: 70 }),
      "fetch-youtube": (request) => ({ video_path: request.output_path, duration: 70, from_cache: false }),
    });
    await runJob(job, { runEngine: engine.runEngine, fetch: claude().fetch });

    expect(engine.commands().slice(0, 3)).toEqual(["youtube-info", "fetch-youtube", "prepare-source"]);
    expect(engine.calls[1].request).toMatchObject({
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      video_id: "abcdefghijk",
      output_path: await getStorage().localPath(storageKeys.youtubeSource("abcdefghijk")),
      max_height: 1080,
    });
    expect((await task(seeded._id))!).toMatchObject({
      status: "completed",
      source: { title: "A real title", videoId: "abcdefghijk", durationSeconds: 70 },
    });
  });

  it("fails too-long YouTube videos before downloading", async () => {
    const jobId = "d".repeat(32);
    const seeded = await seedTask({ source: { type: "youtube", url: "https://youtu.be/abcdefghijk", title: "Mine" }, run: { jobId } });
    const job = await claimed({ id: jobId, type: "process_task", taskId: seeded._id, userId: seeded.userId });
    const engine = uploadEngine({ "youtube-info": () => ({ video_id: "abcdefghijk", title: "T", duration: 6000 }) });
    expect(await runJob(job, { runEngine: engine.runEngine })).toMatchObject({ status: "failed" });

    expect(engine.commands()).toEqual(["youtube-info"]);
    expect((await task(seeded._id))!).toMatchObject({
      status: "error",
      progress: 0,
      progressMessage: "Video is too long (100 min). Maximum allowed duration is 90 minutes.",
      run: { errorCode: "task_error" },
      source: { title: "Mine" },
    });
  });

  it.each([
    ["an engine error passes through", { "prepare-source": () => Promise.reject(new EngineError("download_failed", "Failed to download video: 403\nstderr tail")) }, "Failed to download video: 403", "download_error"],
    ["a transcription error", { transcribe: () => Promise.reject(new EngineError("transcription_failed", "AssemblyAI transcript failed: bad audio")) }, "AssemblyAI transcript failed: bad audio", "transcription_error"],
    ["an unknown error is wrapped", { signals: () => Promise.reject(new TypeError("x is undefined")) }, "Processing failed: x is undefined", "task_error"],
    ["no clip rendered", { "render-clips": fakeRender({ fail: [0, 1] }) }, NO_CLIPS_RENDERED, "task_error"],
  ])("records %s as the task error", async (_name, overrides, message, code) => {
    const { task: seeded, job } = await queuedTask();
    const outcome = await runJob(job, { runEngine: uploadEngine(overrides as Record<string, FakeCommand>).runEngine, fetch: claude().fetch });
    expect(outcome).toEqual({ status: "failed", error: message });
    expect((await task(seeded._id))!).toMatchObject({ status: "error", progress: 0, progressMessage: message, run: { errorCode: code } });
    expect((await jobDoc(job._id))!).toMatchObject({ status: "failed", error: message });
  });

  it("reports a Claude failure as an analysis error", async () => {
    const { task: seeded, job } = await queuedTask();
    await runJob(job, { runEngine: uploadEngine().runEngine, fetch: fakeFetch(() => errorResponse(401, "invalid x-api-key")).fetch });
    const failed = (await task(seeded._id))!;
    expect(failed.status).toBe("error");
    expect(failed.progressMessage).toMatch(/^Transcript analysis failed: /);
    expect(failed.run?.errorCode).toBe("analysis_error");
  });

  it.each([
    ["ANTHROPIC_API_KEY", MISSING_ANTHROPIC_KEY],
    ["ASSEMBLY_AI_API_KEY", MISSING_ASSEMBLYAI_KEY],
  ])("fails with the exact message when %s is missing", async (key, message) => {
    const saved = process.env[key];
    delete process.env[key];
    resetEnv();
    try {
      const { task: seeded, job } = await queuedTask();
      const engine = uploadEngine();
      await runJob(job, { runEngine: engine.runEngine });
      expect(engine.calls).toHaveLength(0);
      expect((await task(seeded._id))!).toMatchObject({ status: "error", progressMessage: message });
    } finally {
      process.env[key] = saved;
      resetEnv();
    }
  });

  it("fails when the uploaded file is gone", async () => {
    const { task: seeded, job } = await queuedTask();
    await getStorage().delete("uploads/00000000-0000-4000-8000-000000000001.mp4");
    await runJob(job, { runEngine: uploadEngine().runEngine });
    expect((await task(seeded._id))!).toMatchObject({ status: "error", progressMessage: "Video file not found" });
  });

  it("stops at the next write after a cancel and keeps no clip rendered after it", async () => {
    const { task: seeded, job } = await queuedTask();
    const cancel = async () => {
      await casStatus(seeded._id, ["queued", "processing"], { status: "cancelled", progress: 0, progressMessage: "Cancelled by user" });
      await requestCancel({ taskId: seeded._id });
    };
    const engine = uploadEngine({ "render-clips": fakeRender({ rendering: (index) => (index === 1 ? cancel() : undefined) }) });
    expect(await runJob(job, { runEngine: engine.runEngine, fetch: claude().fetch })).toEqual({ status: "cancelled" });

    const cancelled = (await task(seeded._id))!;
    expect(cancelled).toMatchObject({ status: "cancelled", progressMessage: "Cancelled by user" });
    expect(cancelled.clips).toHaveLength(1);
    expect((await getStorage().list(`clips/${seeded._id}/`)).map((item) => item.key)).toEqual([cancelled.clips[0].storageKey]);
    expect((await jobDoc(job._id))!.status).toBe("cancelled");
    expect(await exists(path.join(paths.workRoot, job._id))).toBe(false);
  });

  it("kills a running render when the cancel arrives through the job heartbeat", async () => {
    const { task: seeded, job } = await queuedTask();
    const engine = uploadEngine({
      "render-clips": fakeRender({
        rendering: async (index, signal) => {
          if (index !== 1) return;
          await casStatus(seeded._id, ["processing"], { status: "cancelled", progress: 0, progressMessage: "Cancelled by user" });
          await requestCancel({ taskId: seeded._id });
          await untilAborted(signal);
        },
      }),
    });
    expect(await runJob(job, { runEngine: engine.runEngine, fetch: claude().fetch, heartbeatMs: 20 })).toEqual({ status: "cancelled" });
    expect((await task(seeded._id))!.clips).toHaveLength(1);
    expect((await jobDoc(job._id))!.status).toBe("cancelled");
  });

  describe("auto-post trigger", () => {
    async function connectYoutube() {
      const now = new Date();
      await collections().youtubeAccounts.insertOne({
        _id: "user-1",
        channelId: "UC1",
        channelTitle: "Mine",
        refreshToken: "encrypted-refresh",
        scopes: [],
        status: "active",
        autoPost: true,
        privacy: "public",
        madeForKids: false,
        connectedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }
    const postsOf = (taskId: string) => collections().youtubePosts.find({ taskId }).toArray();
    const publishJobsOf = (taskId: string) => collections().jobs.find({ taskId, type: "publish_youtube" }).toArray();

    it("completion creates posts for an auto-post account", async () => {
      await connectYoutube();
      const { task: seeded, job } = await queuedTask();
      await runJob(job, { runEngine: uploadEngine().runEngine, fetch: claude().fetch });

      const done = (await task(seeded._id))!;
      expect(done).toMatchObject({ status: "completed", autopost: "done" });
      const posts = await postsOf(seeded._id);
      expect(posts.map((post) => post.lineageId)).toEqual(done.clips.map((clip) => clip.id));
      expect(posts.map((post) => [post.state, post.notifySubscribers])).toEqual([["queued", true], ["queued", false]]);
      expect((await publishJobsOf(seeded._id)).map((j) => j.payload.postId)).toEqual(posts.map((post) => post._id));
    });

    it("completion creates none when not connected", async () => {
      const { task: seeded, job } = await queuedTask();
      await runJob(job, { runEngine: uploadEngine().runEngine, fetch: claude().fetch });

      const done = (await task(seeded._id))!;
      expect(done.status).toBe("completed");
      expect(done.autopost).toBeUndefined();
      expect(await postsOf(seeded._id)).toHaveLength(0);
      expect(await publishJobsOf(seeded._id)).toHaveLength(0);
    });

    it("a resumed task posts on completion", async () => {
      await connectYoutube();
      // What the resume route leaves: the errored run's partial clip, the task re-queued under a new run.
      const { task: seeded, job } = await queuedTask({ progressMessage: "Re-queued by user", clips: [clipFixture("partial", "t")] });
      await runJob(job, { runEngine: uploadEngine().runEngine, fetch: claude().fetch });

      const done = (await task(seeded._id))!;
      expect(done).toMatchObject({ status: "completed", autopost: "done" });
      const posts = await postsOf(seeded._id);
      expect(posts.map((post) => post.lineageId)).toEqual(done.clips.map((clip) => clip.id));
      expect(posts.map((post) => post.lineageId)).not.toContain("partial");
      expect(await publishJobsOf(seeded._id)).toHaveLength(2);
    });
  });

  it("finishes a job whose task points at another run as cancelled, without touching the task", async () => {
    const seeded = await seedTask({ run: { jobId: "f".repeat(32) }, clips: [clipFixture("old", "t")] });
    const job = await claimed({ id: "e".repeat(32), type: "process_task", taskId: seeded._id, userId: seeded.userId });
    const engine = uploadEngine();
    expect(await runJob(job, { runEngine: engine.runEngine })).toEqual({ status: "cancelled" });
    expect(engine.calls).toHaveLength(0);
    expect((await task(seeded._id))!).toMatchObject({ status: "queued", clips: [{ id: "old" }] });
  });
});
