/** @vitest-environment node */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Collection } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, collections, ensureIndexes } from "./db";
import { resetEnv } from "./env";
import { claimJob, enqueueJob } from "./jobs";
import { getStorage, storageKeys } from "./storage";
import {
  appendClip,
  casStatus,
  clearClips,
  createQueuedTask,
  createTask,
  exportDownloadFilename,
  exportPreset,
  startTaskRun,
  youtubeVideoId,
  deleteAllUserData,
  deleteTaskCompletely,
  getTaskForUser,
  listTasks,
  newTaskCleanupSettings,
  normalizeFilteredWords,
  normalizeFontColor,
  normalizeFontSize,
  pushClip,
  removeClip,
  replaceClips,
  secondsToMmss,
  serializeClip,
  serializeTask,
  serializeTaskSummary,
  settingsFromCreateRequest,
  settingsFromUpdateRequest,
  sliceSourceRanges,
  updatedCleanupSettings,
} from "./tasks";
import type { ClipDoc, TaskDoc } from "./types";

let mongod: MongoMemoryServer;
let dataDir: string;
const baseEnv = { ...process.env };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cw-tasks-"));
  process.env = { ...baseEnv, MONGODB_URI: mongod.getUri(), MONGODB_DB: "tasks", BETTER_AUTH_SECRET: "s".repeat(32), DATA_DIR: dataDir };
  resetEnv();
  await ensureIndexes();
});

afterAll(async () => {
  await closeDb();
  await mongod.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
  process.env = baseEnv;
});

beforeEach(async () => {
  const { tasks, jobs, clipDrafts } = collections();
  await Promise.all([tasks.deleteMany({}), jobs.deleteMany({}), clipDrafts.deleteMany({})]);
});

const settings = () => settingsFromCreateRequest({});

function clip(id: string, overrides: Partial<ClipDoc> = {}): ClipDoc {
  const now = new Date("2026-10-01T10:00:00Z");
  return {
    id,
    filename: `${id}.mp4`,
    storageKey: `clips/t/${id}.mp4`,
    startTime: "00:05",
    endTime: "00:35",
    duration: 30,
    text: "words",
    relevanceScore: 0.9,
    reasoning: "Strong hook",
    viralityScore: 70,
    hookScore: 20,
    engagementScore: 18,
    valueScore: 17,
    shareabilityScore: 15,
    hookType: "question",
    hookTitle: "Why it works",
    sourceRanges: [{ start: 5, end: 35 }],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function writeFile(key: string) {
  await getStorage().writeStream(key, Readable.from([Buffer.from(key)]));
}

const exists = async (key: string) => Boolean(await getStorage().stat(key));

async function processingTask(jobId = "job1", userId = "u1") {
  const task = await createTask({ userId, source: { type: "youtube", url: "https://youtu.be/abc", title: "" }, settings: settings() });
  await casStatus(task._id, ["queued"], { status: "processing", run: { jobId, startedAt: new Date() } });
  return task;
}

describe("normalisers", () => {
  it("port the Python font option rules", () => {
    expect(["30", "abc", 100, 5, 24.9, true, "", null, " 40 ", "24.5"].map((value) => normalizeFontSize(value))).toEqual([
      30, 24, 72, 12, 24, 12, null, null, 40, 24,
    ]);
    expect(normalizeFontColor("#ffcc00")).toBe("#FFCC00");
    expect(normalizeFontColor("red")).toBe("#FFFFFF");
    expect(normalizeFontColor("  ")).toBeNull();
  });

  it("port clip_cleanup", () => {
    expect(normalizeFilteredWords(" Um, uh , UM,  you   know ,,")).toEqual(["um", "uh", "you know"]);
    expect(normalizeFilteredWords(["A", 3, " b ", "a"])).toEqual(["a", "b"]);
    expect(newTaskCleanupSettings({})).toEqual({ cutLongPauses: true, pauseThresholdMs: 1200, removeFillerWords: true, filteredWords: [] });
    expect(
      newTaskCleanupSettings({ cut_long_pauses: null, pause_threshold_ms: "99999", remove_filler_words: "false", filtered_words: "Like" }),
    ).toEqual({ cutLongPauses: false, pauseThresholdMs: 3000, removeFillerWords: true, filteredWords: ["like"] });
    expect(
      updatedCleanupSettings(
        { pause_threshold_ms: 400 },
        { cutLongPauses: true, pauseThresholdMs: 900, removeFillerWords: false, filteredWords: ["x"] },
      ),
    ).toEqual({ cutLongPauses: true, pauseThresholdMs: 400, removeFillerWords: false, filteredWords: ["x"] });
  });

  it("build create and update settings", () => {
    expect(
      settingsFromCreateRequest({
        font_options: { font_family: " Inter ", font_size: 30, font_color: "#abcdef" },
        caption_template: "hormozi",
        output_format: "vertical_split",
        add_subtitles: false,
        clip_length: "short",
        cut_long_pauses: false,
      }),
    ).toEqual({
      fontFamily: "Inter",
      fontSize: 30,
      fontColor: "#ABCDEF",
      captionTemplate: "hormozi",
      outputFormat: "vertical_split",
      addSubtitles: false,
      clipLength: "short",
      cutLongPauses: false,
      pauseThresholdMs: 1200,
      removeFillerWords: true,
      filteredWords: [],
    });
    expect(settingsFromCreateRequest({ output_format: "square", add_subtitles: "no" })).toMatchObject({
      fontFamily: null,
      fontSize: null,
      fontColor: null,
      captionTemplate: "default",
      outputFormat: "vertical",
      addSubtitles: true,
      clipLength: "auto",
    });
    expect(() => settingsFromCreateRequest({ font_options: "x" })).toThrow("font_options must be an object");
    expect(() => settingsFromCreateRequest({ clip_length: "huge" })).toThrow(
      expect.objectContaining({ status: 422, message: "clip_length must be auto, short, medium, or long" }),
    );
    const current = settingsFromCreateRequest({ output_format: "original", clip_length: "long", filtered_words: ["so"] });
    expect(settingsFromUpdateRequest({ font_size: 40, caption_template: "neon", cut_long_pauses: false }, current)).toEqual({
      ...current,
      fontSize: 40,
      captionTemplate: "neon",
      cutLongPauses: false,
    });
  });

  it("format mm:ss like _seconds_to_mmss and slice source ranges", () => {
    expect([0, 2.5, 3.5, 59.5, 61.4, 3600, -3].map(secondsToMmss)).toEqual([
      "00:00", "00:02", "00:04", "01:00", "01:01", "60:00", "00:00",
    ]);
    const ranges = [{ start: 10, end: 20 }, { start: 30, end: 40 }];
    expect(sliceSourceRanges(ranges, 5, 15)).toEqual([{ start: 15, end: 20 }, { start: 30, end: 35 }]);
    expect(sliceSourceRanges(ranges, 0, 100)).toEqual(ranges);
    expect(sliceSourceRanges([{ start: 10, end: 10.03 }, { start: 30, end: 40 }], 0, 5)).toEqual([{ start: 30, end: 35 }]);
  });
});

describe("sources and exports", () => {
  it("port get_youtube_video_id", () => {
    const id = "dQw4w9WgXcQ";
    for (const url of [
      `https://www.youtube.com/watch?v=${id}`,
      ` https://youtu.be/${id}?t=3 `,
      `https://m.youtube.com/watch?feature=share&v=${id}`,
      `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/embed/${id}`,
      `youtube.com/v/${id}`,
      `https://YOUTUBE.com?v=${id}`,
    ]) {
      expect(youtubeVideoId(url)).toBe(id);
    }
    for (const url of [
      "https://vimeo.com/123",
      "https://www.youtube.com/watch?v=short",
      "",
      null,
      "upload://x.mp4",
      `http://169.254.169.254/latest/youtu.be/${id}`,
      `https://youtube.com.evil.example/watch?v=${id}`,
      `https://youtube.com@evil.example/watch?v=${id}`,
      `ftp://youtube.com/watch?v=${id}`,
    ]) {
      expect(youtubeVideoId(url)).toBeNull();
    }
  });

  it("validate presets and name export downloads", () => {
    expect(exportPreset(" Reels ")).toBe("reels");
    expect(() => exportPreset("vimeo")).toThrow("Invalid preset. Use one of: tiktok, reels, shorts");
    expect(exportDownloadFilename("clip_1_0005-0035_abc.mp4", "tiktok")).toBe("clip_1_0005-0035_abc_tiktok.mp4");
    expect(exportDownloadFilename('dir/"we\\ird".MP4', "shorts")).toBe("weird_shorts.mp4");
    expect(exportDownloadFilename(" .mp4", "reels")).toBe("clip_reels.mp4");
    expect(exportDownloadFilename(`${"x".repeat(300)}.mp4`, "tiktok")).toHaveLength(255);
  });
});

describe("task runs", () => {
  it("create a queued task that names its job", async () => {
    const { task, job } = await createQueuedTask({ userId: "u1", source: { type: "youtube", url: "u", title: "" }, settings: settings() });
    expect(task.run).toEqual({ jobId: job._id, type: "process_task" });
    expect(job).toMatchObject({ type: "process_task", taskId: task._id, activeKey: `task:${task._id}`, status: "queued" });
    expect(serializeTask(task).run_type).toBe("process_task");
    expect(serializeTaskSummary({ ...task, status: "completed" }).run_type).toBeNull();
  });

  it("start a run only from the expected status and restore the task when the key is held", async () => {
    const task = await createTask({ userId: "u1", source: { type: "youtube", url: "u", title: "T" }, settings: settings() });
    await casStatus(task._id, ["queued"], { status: "cancelled", progressMessage: "Cancelled by user" });
    const cancelled = (await collections().tasks.findOne({ _id: task._id }))!;
    const start = () =>
      startTaskRun({
        task: cancelled,
        type: "process_task",
        expected: ["cancelled", "error"],
        status: "queued",
        set: { progressMessage: "Re-queued by user" },
        busyMessage: "busy",
      });

    // A run that is still stopping holds the task's key.
    const stopping = await enqueueJob({ type: "process_task", taskId: task._id, userId: "u1", activeKey: `task:${task._id}` });
    await expect(start()).rejects.toMatchObject({ status: 409, detail: "busy" });
    expect(await collections().tasks.findOne({ _id: task._id })).toMatchObject({ status: "cancelled", progressMessage: "Cancelled by user" });

    await collections().jobs.deleteOne({ _id: stopping.job._id });
    const job = (await start())!;
    expect(await collections().tasks.findOne({ _id: task._id })).toMatchObject({
      status: "queued",
      progressMessage: "Re-queued by user",
      run: { jobId: job._id, type: "process_task" },
    });
    expect(await start()).toBeNull();
  });
});

describe("repository and serializers", () => {
  it("creates queued tasks with fallback titles and serializes them", async () => {
    const upload = await createTask({
      userId: "u1",
      source: { type: "upload", url: "upload://0b0e7f3a-0000-4000-8000-000000000000.mp4", title: " " },
      settings: settings(),
    });
    expect(upload).toMatchObject({ status: "queued", progress: 0, clips: [], source: { title: "Uploaded Video" } });
    const stored = (await collections().tasks.findOne({ _id: upload._id })) as TaskDoc;
    expect(serializeTask(stored)).toEqual({
      id: upload._id,
      user_id: "u1",
      source_id: upload._id,
      source_title: "Uploaded Video",
      source_type: "video_url",
      source_url: "upload://0b0e7f3a-0000-4000-8000-000000000000.mp4",
      status: "queued",
      run_type: null,
      progress: 0,
      progress_message: "",
      font_family: null,
      font_size: null,
      font_color: null,
      caption_template: "default",
      output_format: "vertical",
      add_subtitles: true,
      clip_length: "auto",
      cut_long_pauses: true,
      pause_threshold_ms: 1200,
      remove_filler_words: true,
      filtered_words: [],
      clips_count: 0,
      created_at: upload.createdAt.toISOString(),
      updated_at: upload.updatedAt.toISOString(),
    });
    const youtube = await createTask({ userId: "u1", source: { type: "youtube", url: "https://youtu.be/x", title: "" }, settings: settings() });
    expect(youtube.source.title).toBe("YouTube Video");
  });

  it("serializes clips in order with the file URL", () => {
    expect(serializeClip("t1", clip("c1"), 2)).toEqual({
      id: "c1",
      filename: "c1.mp4",
      start_time: "00:05",
      end_time: "00:35",
      duration: 30,
      text: "words",
      relevance_score: 0.9,
      reasoning: "Strong hook",
      clip_order: 3,
      created_at: "2026-10-01T10:00:00.000Z",
      video_url: "/api/tasks/t1/clips/c1/file",
      virality_score: 70,
      hook_score: 20,
      engagement_score: 18,
      value_score: 17,
      shareability_score: 15,
      hook_type: "question",
      hook_title: "Why it works",
    });
  });

  it("lists newest first with cover clip and top score", async () => {
    const older = await processingTask("j1");
    await pushClip(older._id, "j1", clip("a", { viralityScore: 50 }));
    await pushClip(older._id, "j1", clip("b", { viralityScore: 80 }));
    await pushClip(older._id, "j1", clip("c", { viralityScore: 80 }));
    const newer = await createTask({ userId: "u1", source: { type: "youtube", url: "u", title: "New" }, settings: settings() });
    await createTask({ userId: "someone-else", source: { type: "youtube", url: "u", title: "Theirs" }, settings: settings() });

    const summaries = (await listTasks("u1")).map(serializeTaskSummary);
    expect(summaries.map((s) => s.id)).toEqual([newer._id, older._id]);
    expect(summaries[1]).toMatchObject({ clips_count: 3, top_virality_score: 80, cover_clip_id: "b", source_type: "youtube" });
    expect(summaries[0]).toMatchObject({ clips_count: 0, top_virality_score: null, cover_clip_id: null, source_title: "New" });
    expect(Object.keys(summaries[0]).sort()).toEqual(
      ["clips_count", "cover_clip_id", "created_at", "id", "run_type", "source_id", "source_title", "source_type", "source_url", "status", "top_virality_score", "updated_at", "user_id"],
    );
  });

  it("enforces ownership", async () => {
    const task = await createTask({ userId: "u1", source: { type: "youtube", url: "u", title: "T" }, settings: settings() });
    await expect(getTaskForUser(task._id, "u2")).rejects.toMatchObject({ status: 403 });
    await expect(getTaskForUser("missing", "u1")).rejects.toMatchObject({ status: 404, detail: "Task not found" });
    expect((await getTaskForUser(task._id, "u1"))._id).toBe(task._id);
  });
});

describe("CAS helpers", () => {
  it("guard status transitions", async () => {
    const task = await createTask({ userId: "u1", source: { type: "youtube", url: "u", title: "T" }, settings: settings() });
    expect(await casStatus(task._id, ["completed"], { status: "error" })).toBe(false);
    expect(await casStatus(task._id, ["queued", "processing"], { status: "cancelled", progressMessage: "Cancelled by user" })).toBe(true);
    expect((await collections().tasks.findOne({ _id: task._id }))?.status).toBe("cancelled");
  });

  it("only let the owning run write clips", async () => {
    const task = await processingTask("j1");
    await writeFile("clips/t/old.mp4");
    expect(await pushClip(task._id, "j1", clip("old"))).toBe(true);
    expect(await pushClip(task._id, "other-run", clip("x"))).toBe(false);

    expect(await clearClips(task._id, "other-run")).toBeNull();
    await collections().clipDrafts.insertOne({ _id: "old", taskId: task._id, userId: "u1", basis: "old.mp4", status: "ready", revision: 0, createdAt: new Date(), updatedAt: new Date() });
    const cleared = await clearClips(task._id, "j1");
    expect(cleared?.map((c) => c.id)).toEqual(["old"]);
    expect(await exists("clips/t/old.mp4")).toBe(false);
    expect(await collections().clipDrafts.countDocuments()).toBe(0);

    await casStatus(task._id, ["processing"], { status: "cancelled" });
    expect(await pushClip(task._id, "j1", clip("late"))).toBe(false);
  });

  it("replace every clip in one write", async () => {
    const task = await processingTask("restyle1");
    await pushClip(task._id, "restyle1", clip("a"));
    await pushClip(task._id, "restyle1", clip("b"));
    await writeFile("clips/t/a.mp4");
    await writeFile(`${storageKeys.editorDir("a")}h/clean.mp4`);
    expect(await replaceClips(task._id, "nope", [])).toBe(false);
    expect(
      await replaceClips(task._id, "restyle1", [clip("a2", { storageKey: "clips/t/a2.mp4" })], {
        status: "completed",
        progress: 100,
        progressMessage: "Complete!",
      }),
    ).toBe(true);
    const stored = (await collections().tasks.findOne({ _id: task._id }))!;
    expect(stored.clips.map((c) => c.id)).toEqual(["a2"]);
    expect(stored.status).toBe("completed");
    expect(await exists("clips/t/a.mp4")).toBe(false);
    expect(await getStorage().list("editor/a/")).toEqual([]);
  });

  it("report a committed swap as done when the old clips' cleanup fails", async () => {
    const task = await processingTask("restyle2");
    await pushClip(task._id, "restyle2", clip("a"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The only deleteMany in a swap is the old clips' draft cleanup, after the task write committed.
    const deleteMany = vi.spyOn(Collection.prototype, "deleteMany").mockRejectedValueOnce(new Error("connection reset"));
    try {
      expect(await replaceClips(task._id, "restyle2", [clip("a2")], { status: "completed" })).toBe(true);
      expect(warn).toHaveBeenCalledWith("[tasks] Could not delete clip drafts", expect.any(Error));
    } finally {
      deleteMany.mockRestore();
      warn.mockRestore();
    }
    expect((await collections().tasks.findOne({ _id: task._id }))!.clips.map((c) => c.id)).toEqual(["a2"]);
  });

  it("remove a clip only from an idle task", async () => {
    const task = await processingTask("j1");
    await pushClip(task._id, "j1", clip("a"));
    await pushClip(task._id, "j1", clip("b"));
    await expect(removeClip(task._id, "a")).rejects.toMatchObject({
      status: 400,
      detail: "Wait for processing to finish before editing this task",
    });
    await casStatus(task._id, ["processing"], { status: "completed" });
    await expect(removeClip(task._id, "zzz")).rejects.toMatchObject({ status: 404, detail: "Clip not found" });
    await expect(removeClip("missing", "a")).rejects.toMatchObject({ status: 404, detail: "Task not found" });
    expect((await removeClip(task._id, "a")).id).toBe("a");
    expect((await collections().tasks.findOne({ _id: task._id }))!.clips.map((c) => c.id)).toEqual(["b"]);
  });

  it("append a combined clip only while its inputs are unchanged", async () => {
    const task = await processingTask("j1");
    await pushClip(task._id, "j1", clip("a"));
    await pushClip(task._id, "j1", clip("b"));
    expect(await appendClip(task._id, clip("combo"))).toBe(false);
    await casStatus(task._id, ["processing"], { status: "completed" });
    const inputs = [{ id: "a", filename: "a.mp4" }, { id: "b", filename: "b.mp4" }];
    expect(await appendClip(task._id, clip("combo"), [...inputs.slice(0, 1), { id: "b", filename: "changed.mp4" }])).toBe(false);
    expect(await appendClip(task._id, clip("combo"), inputs)).toBe(true);
    expect((await collections().tasks.findOne({ _id: task._id }))!.clips.map((c) => c.id)).toEqual(["a", "b", "combo"]);
  });
});

describe("deletion", () => {
  async function fullTask(userId: string, uploadId: string) {
    const url = `upload://${uploadId}.mp4`;
    const task = await createTask({ userId, source: { type: "upload", url, title: "Talk" }, settings: settings() });
    await casStatus(task._id, ["queued"], { status: "processing", run: { jobId: "j" } });
    const key = storageKeys.clip(task._id, "c1.mp4");
    await pushClip(task._id, "j", clip(`${task._id}-c1`, { storageKey: key }));
    await casStatus(task._id, ["processing"], { status: "completed" });
    await writeFile(key);
    await writeFile(`uploads/${uploadId}.mp4`);
    await writeFile(`uploads/${uploadId}.transcript_cache.json`);
    await writeFile(`${storageKeys.editorDir(`${task._id}-c1`)}hash/clean.mp4`);
    await writeFile(`${storageKeys.editorDir(`${task._id}-gone`)}hash/clean.mp4`);
    await collections().clipDrafts.insertOne({ _id: `${task._id}-gone`, taskId: task._id, userId, basis: "x", status: "ready", revision: 1, createdAt: new Date(), updatedAt: new Date() });
    const exportJob = await enqueueJob({ type: "export_clip", taskId: task._id, clipId: `${task._id}-c1`, userId });
    await writeFile(storageKeys.presetExport(exportJob.job._id));
    const running = await enqueueJob({ type: "export_editor", taskId: task._id, clipId: `${task._id}-c1`, userId });
    await claimJob("w1", ["export_editor"]);
    return { task, key, exportJobId: exportJob.job._id, runningJobId: running.job._id };
  }

  it("removes the task, its drafts, jobs and files", async () => {
    const uploadId = "0b0e7f3a-2222-4000-8000-000000000000";
    const { task, key, exportJobId, runningJobId } = await fullTask("u1", uploadId);
    await deleteTaskCompletely(task._id);

    expect(await collections().tasks.countDocuments({ _id: task._id })).toBe(0);
    expect(await collections().clipDrafts.countDocuments({ taskId: task._id })).toBe(0);
    // The running export stays, flagged, until its worker stops and the cron expires its output.
    expect(await collections().jobs.find({ taskId: task._id }).toArray()).toEqual([
      expect.objectContaining({ _id: runningJobId, status: "running", cancelRequested: true }),
    ]);
    for (const gone of [key, `uploads/${uploadId}.mp4`, `uploads/${uploadId}.transcript_cache.json`, storageKeys.presetExport(exportJobId)]) {
      expect(await exists(gone)).toBe(false);
    }
    expect(await getStorage().list(storageKeys.editorDir(`${task._id}-c1`))).toEqual([]);
    expect(await getStorage().list(storageKeys.editorDir(`${task._id}-gone`))).toEqual([]);
  });

  it("keeps an upload another task still uses", async () => {
    const uploadId = "0b0e7f3a-3333-4000-8000-000000000000";
    const { task } = await fullTask("u1", uploadId);
    await createTask({ userId: "u1", source: { type: "upload", url: `upload://${uploadId}.mp4`, title: "Again" }, settings: settings() });
    await deleteTaskCompletely(task._id);
    expect(await exists(`uploads/${uploadId}.mp4`)).toBe(true);
  });

  it("deletes everything a user owns, fonts included", async () => {
    const mine = await fullTask("u1", "0b0e7f3a-4444-4000-8000-000000000000");
    const theirs = await fullTask("u2", "0b0e7f3a-5555-4000-8000-000000000000");
    await writeFile(`${storageKeys.userFontsDir("u1")}usr-u1-x.ttf`);
    await enqueueJob({ type: "process_task", taskId: "orphan", userId: "u1" });

    await deleteAllUserData("u1");
    expect(await collections().tasks.countDocuments({ userId: "u1" })).toBe(0);
    expect(await collections().jobs.find({ userId: "u1" }).toArray()).toEqual([
      expect.objectContaining({ _id: mine.runningJobId, status: "running", cancelRequested: true }),
    ]);
    expect(await getStorage().list(storageKeys.userFontsDir("u1"))).toEqual([]);
    expect(await exists(mine.key)).toBe(false);
    expect(await exists(theirs.key)).toBe(true);
    expect(await collections().jobs.countDocuments({ userId: "u2" })).toBe(2);
  });
});
