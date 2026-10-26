/** @vitest-environment node */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getAuth } from "@/server/auth";
import { closeDb, collections, ensureIndexes } from "@/server/db";
import { resetEnv } from "@/server/env";
import { claimJob, finishJob, writeWorkerHeartbeat } from "@/server/jobs";
import { getStorage, storageKeys } from "@/server/storage";
import { casStatus, createTask, pushClip, settingsFromCreateRequest } from "@/server/tasks";
import type { ClipDoc, JobDoc, TaskDoc } from "@/server/types";

import * as listRoute from "./route";
import * as createRoute from "./create/route";
import * as taskRoute from "./[id]/route";
import * as clipsRoute from "./[id]/clips/route";
import * as clipRoute from "./[id]/clips/[clipId]/route";
import * as fileRoute from "./[id]/clips/[clipId]/file/route";
import * as cancelRoute from "./[id]/cancel/route";
import * as resumeRoute from "./[id]/resume/route";
import * as settingsRoute from "./[id]/settings/route";
import * as exportsRoute from "./[id]/clips/[clipId]/exports/route";
import * as exportRoute from "./[id]/clips/[clipId]/exports/[exportId]/route";
import * as exportFileRoute from "./[id]/clips/[clipId]/exports/[exportId]/file/route";

// Real Better Auth sessions on a standalone mongod (transactions off), storage in a temp DATA_DIR.
let mongod: MongoMemoryServer;
let dataDir: string;
const baseEnv = { ...process.env };
const users: Record<"alice" | "bob", { id: string; cookie: string }> = {} as never;

async function signUp(name: "alice" | "bob") {
  const response = await getAuth().api.signUpEmail({
    body: { email: `${name}@example.com`, password: "correct horse battery", name },
    asResponse: true,
  });
  const { user } = (await response.json()) as { user: { id: string } };
  users[name] = { id: user.id, cookie: response.headers.get("set-cookie")!.split(";")[0] };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cw-task-routes-"));
  process.env = {
    ...baseEnv,
    MONGODB_URI: mongod.getUri(),
    MONGODB_DB: "task_routes",
    MONGODB_TRANSACTIONS: "false",
    BETTER_AUTH_SECRET: "a-very-long-test-secret-for-task-routes-01",
    BETTER_AUTH_URL: "http://localhost:3000",
    DATA_DIR: dataDir,
  };
  resetEnv();
  await ensureIndexes();
  await signUp("alice");
  await signUp("bob");
}, 60_000);

afterAll(async () => {
  await closeDb();
  await mongod.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
  process.env = baseEnv;
});

beforeEach(async () => {
  const { tasks, jobs, clipDrafts, workerStatus } = collections();
  await Promise.all([tasks.deleteMany({}), jobs.deleteMany({}), clipDrafts.deleteMany({}), workerStatus.deleteMany({})]);
});

type Handler = (request: Request, context: { params: Promise<never> }) => Promise<Response>;

function call(
  handler: unknown,
  url: string,
  init: { method?: string; as?: "alice" | "bob" | null; body?: unknown; headers?: Record<string, string>; params?: object } = {},
) {
  const { method = "GET", as = "alice", body, headers = {}, params = {} } = init;
  const request = new Request(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...(as && { cookie: users[as].cookie }),
      ...(body !== undefined && { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return (handler as Handler)(request, { params: Promise.resolve(params as never) });
}

const UPLOAD_ID = "0b0e7f3a-1111-4000-8000-000000000000";

async function writeKey(key: string, content = key) {
  await getStorage().writeStream(key, Readable.from([Buffer.from(content)]));
}

const exists = async (key: string) => Boolean(await getStorage().stat(key));
const stored = async (id: string) => (await collections().tasks.findOne({ _id: id })) as TaskDoc;
const jobsOf = (taskId: string) => collections().jobs.find({ taskId }).toArray();

function clip(taskId: string, id: string, overrides: Partial<ClipDoc> = {}): ClipDoc {
  const now = new Date("2026-10-01T10:00:00Z");
  return {
    id,
    filename: `clip_${id}.mp4`,
    storageKey: storageKeys.clip(taskId, `clip_${id}.mp4`),
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

/** A completed task of alice's with clips a and b, their files and (for uploads) the source. */
async function completedTask(opts: { upload?: boolean; userId?: string } = {}) {
  const url = opts.upload ? `upload://${UPLOAD_ID}.mp4` : "https://youtu.be/dQw4w9WgXcQ";
  const task = await createTask({
    userId: opts.userId ?? users.alice.id,
    source: opts.upload ? { type: "upload", url, title: "Talk" } : { type: "youtube", url, title: "Talk", videoId: "dQw4w9WgXcQ" },
    settings: settingsFromCreateRequest({}),
  });
  await casStatus(task._id, ["queued"], { status: "processing", run: { jobId: "j0" } });
  for (const id of ["a", "b"]) {
    const doc = clip(task._id, id, { viralityScore: id === "a" ? 60 : 80 });
    await pushClip(task._id, "j0", doc);
    await writeKey(doc.storageKey, "0123456789");
  }
  await casStatus(task._id, ["processing"], { status: "completed", progress: 100, progressMessage: "Complete!" });
  if (opts.upload) await writeKey(`uploads/${UPLOAD_ID}.mp4`);
  return stored(task._id);
}

describe("POST /api/tasks/create", () => {
  const create = (body: unknown, as: "alice" | "bob" | null = "alice") =>
    call(createRoute.POST, "/api/tasks/create", { method: "POST", body, as });

  it("queues a YouTube task with its process job", async () => {
    const response = await create({ source: { url: " https://www.youtube.com/watch?v=dQw4w9WgXcQ ", title: null }, clip_length: "short" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ task_id: expect.any(String), job_id: expect.stringMatching(/^[a-f0-9]{32}$/), message: "Task created and queued for processing", worker_online: false });

    const task = await stored(body.task_id);
    expect(task).toMatchObject({
      userId: users.alice.id,
      status: "queued",
      source: { type: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "YouTube Video", videoId: "dQw4w9WgXcQ" },
      settings: { clipLength: "short", cutLongPauses: true, removeFillerWords: true },
      run: { jobId: body.job_id, type: "process_task" },
    });
    expect(await jobsOf(body.task_id)).toEqual([
      expect.objectContaining({ _id: body.job_id, type: "process_task", status: "queued", activeKey: `task:${body.task_id}` }),
    ]);
  });

  it("stores YouTube's own watch URL whatever link shape came in", async () => {
    for (const url of ["https://youtu.be/dQw4w9WgXcQ?t=30", "m.youtube.com/shorts/dQw4w9WgXcQ"]) {
      const body = await (await create({ source: { url } })).json();
      expect((await stored(body.task_id)).source).toMatchObject({ type: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", videoId: "dQw4w9WgXcQ" });
    }
  });

  it("queues an upload that is in storage and reports a live worker", async () => {
    await writeKey(`uploads/${UPLOAD_ID}.mp4`);
    await writeWorkerHeartbeat({ workerId: "w", startedAt: new Date(), version: "test" });
    const response = await create({ source: { url: `upload://${UPLOAD_ID}.mp4`, title: "talk.mp4" } });
    const body = await response.json();
    expect(body.worker_online).toBe(true);
    expect((await stored(body.task_id)).source).toEqual({ type: "upload", url: `upload://${UPLOAD_ID}.mp4`, title: "talk.mp4" });
  });

  it.each([
    [{ source: { url: `upload://${UPLOAD_ID}.mov` } }, 422, { code: "VIDEO_METADATA_UNAVAILABLE", message: "We couldn't find this uploaded video. Upload it again." }],
    [{ source: { url: "upload://../../etc/passwd.mp4" } }, 422, { code: "VIDEO_METADATA_UNAVAILABLE", message: "We couldn't find this uploaded video. Upload it again." }],
    [{ source: { url: "   " } }, 400, "Source URL is required"],
    [{ source: "https://youtu.be/dQw4w9WgXcQ" }, 400, "Source URL is required"],
    [{}, 400, "Source URL is required"],
    [{ source: { url: "https://youtu.be/dQw4w9WgXcQ" }, font_options: "big" }, 400, "font_options must be an object"],
    [{ source: { url: "https://youtu.be/dQw4w9WgXcQ" }, clip_length: "epic" }, 422, "clip_length must be auto, short, medium, or long"],
    [{ source: { url: "C:\\videos\\talk.mp4" } }, 404, "Only YouTube URLs or upload:// references are supported"],
    [{ source: { url: "https://vimeo.com/1234" } }, 422, "Only YouTube URLs or uploaded video files are supported"],
    // The ported regex alone would take these as YouTube and hand the raw URL to yt-dlp.
    [{ source: { url: "http://169.254.169.254/latest/youtu.be/AAAAAAAAAAA" } }, 422, "Only YouTube URLs or uploaded video files are supported"],
    [{ source: { url: "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ" } }, 422, "Only YouTube URLs or uploaded video files are supported"],
    [{ source: { url: "https://evil.example/?next=youtube.com/watch?v=dQw4w9WgXcQ" } }, 422, "Only YouTube URLs or uploaded video files are supported"],
    ["{not json", 400, "Invalid JSON body"],
    [[1, 2], 400, "Request body must be an object"],
  ])("rejects %j", async (body, status, detail) => {
    const response = await create(body);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ detail });
    expect(await collections().tasks.countDocuments()).toBe(0);
  });

  it("requires a session", async () => {
    const response = await create({ source: { url: "https://youtu.be/dQw4w9WgXcQ" } }, null);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ detail: "Unauthorized" });
  });
});

describe("task reads and edits", () => {
  it("lists the user's tasks newest first", async () => {
    const done = await completedTask();
    const queued = await (await call(createRoute.POST, "/api/tasks/create", { method: "POST", body: { source: { url: "https://youtu.be/dQw4w9WgXcQ", title: "Q" } } })).json();
    await completedTask({ userId: users.bob.id });

    const response = await call(listRoute.GET, "/api/tasks");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.total).toBe(2);
    expect(body.tasks.map((t: { id: string }) => t.id)).toEqual([queued.task_id, done._id]);
    expect(body.tasks[0]).toMatchObject({ status: "queued", run_type: "process_task", clips_count: 0, source_title: "Q" });
    expect(body.tasks[1]).toEqual({
      id: done._id,
      user_id: users.alice.id,
      source_id: done._id,
      source_title: "Talk",
      source_type: "youtube",
      source_url: "https://youtu.be/dQw4w9WgXcQ",
      status: "completed",
      run_type: null,
      clips_count: 2,
      top_virality_score: 80,
      cover_clip_id: "b",
      created_at: done.createdAt.toISOString(),
      updated_at: done.updatedAt.toISOString(),
    });
    expect((await call(listRoute.GET, "/api/tasks", { as: null })).status).toBe(401);
  });

  it("returns a task without its clips, and only to its owner", async () => {
    const task = await completedTask({ upload: true });
    const response = await call(taskRoute.GET, `/api/tasks/${task._id}`, { params: { id: task._id } });
    const body = await response.json();
    expect(body).toMatchObject({
      id: task._id,
      source_type: "video_url",
      status: "completed",
      run_type: null,
      progress: 100,
      progress_message: "Complete!",
      caption_template: "default",
      output_format: "vertical",
      add_subtitles: true,
      clip_length: "auto",
      cut_long_pauses: true,
      pause_threshold_ms: 1200,
      remove_filler_words: true,
      filtered_words: [],
      clips_count: 2,
    });
    expect(body).not.toHaveProperty("clips");

    const theirs = await call(taskRoute.GET, `/api/tasks/${task._id}`, { as: "bob", params: { id: task._id } });
    expect([theirs.status, await theirs.json()]).toEqual([403, { detail: "Not authorized for this task" }]);
    const missing = await call(taskRoute.GET, "/api/tasks/nope", { params: { id: "nope" } });
    expect([missing.status, await missing.json()]).toEqual([404, { detail: "Task not found" }]);
  });

  it("lists clips in order with their file URLs", async () => {
    const task = await completedTask();
    const body = await (await call(clipsRoute.GET, `/api/tasks/${task._id}/clips`, { params: { id: task._id } })).json();
    expect(body.task_id).toBe(task._id);
    expect(body.total_clips).toBe(2);
    expect(body.clips.map((c: { id: string; clip_order: number; video_url: string }) => [c.id, c.clip_order, c.video_url])).toEqual([
      ["a", 1, `/api/tasks/${task._id}/clips/a/file`],
      ["b", 2, `/api/tasks/${task._id}/clips/b/file`],
    ]);
  });

  it("renames a task, even while it runs", async () => {
    const task = await completedTask();
    await casStatus(task._id, ["completed"], { status: "processing" });
    const response = await call(taskRoute.PATCH, `/api/tasks/${task._id}`, { method: "PATCH", body: { title: "New name" }, params: { id: task._id } });
    expect(await response.json()).toEqual({ message: "Task updated successfully", task_id: task._id });
    expect((await stored(task._id)).source.title).toBe("New name");

    const blank = await call(taskRoute.PATCH, `/api/tasks/${task._id}`, { method: "PATCH", body: { title: "  " }, params: { id: task._id } });
    expect([blank.status, await blank.json()]).toEqual([400, { detail: "Title is required" }]);
    const theirs = await call(taskRoute.PATCH, `/api/tasks/${task._id}`, { method: "PATCH", as: "bob", body: { title: "Mine" }, params: { id: task._id } });
    expect(theirs.status).toBe(403);
  });

  it("deletes an idle task with its files, and refuses an active one", async () => {
    const task = await completedTask({ upload: true });
    await writeKey(`${storageKeys.editorDir("a")}hash/clean.mp4`);
    await casStatus(task._id, ["completed"], { status: "queued" });
    const locked = await call(taskRoute.DELETE, `/api/tasks/${task._id}`, { method: "DELETE", params: { id: task._id } });
    expect([locked.status, await locked.json()]).toEqual([400, { detail: "Wait for processing to finish before editing this task" }]);

    await casStatus(task._id, ["queued"], { status: "error" });
    const response = await call(taskRoute.DELETE, `/api/tasks/${task._id}`, { method: "DELETE", params: { id: task._id } });
    expect(await response.json()).toEqual({ message: "Task deleted successfully" });
    expect(await collections().tasks.countDocuments()).toBe(0);
    for (const key of [task.clips[0].storageKey, task.clips[1].storageKey, `uploads/${UPLOAD_ID}.mp4`, `${storageKeys.editorDir("a")}hash/clean.mp4`]) {
      expect(await exists(key)).toBe(false);
    }
  });

  it("deletes one clip with its file and draft", async () => {
    const task = await completedTask();
    await collections().clipDrafts.insertOne({ _id: "a", taskId: task._id, userId: users.alice.id, basis: "clip_a.mp4", status: "ready", revision: 0, createdAt: new Date(), updatedAt: new Date() });
    const response = await call(clipRoute.DELETE, `/api/tasks/${task._id}/clips/a`, { method: "DELETE", params: { id: task._id, clipId: "a" } });
    expect(await response.json()).toEqual({ message: "Clip deleted successfully" });
    expect((await stored(task._id)).clips.map((c) => c.id)).toEqual(["b"]);
    expect(await exists(task.clips[0].storageKey)).toBe(false);
    expect(await collections().clipDrafts.countDocuments()).toBe(0);

    const gone = await call(clipRoute.DELETE, `/api/tasks/${task._id}/clips/a`, { method: "DELETE", params: { id: task._id, clipId: "a" } });
    expect([gone.status, await gone.json()]).toEqual([404, { detail: "Clip not found" }]);
    await casStatus(task._id, ["completed"], { status: "processing" });
    const locked = await call(clipRoute.DELETE, `/api/tasks/${task._id}/clips/b`, { method: "DELETE", params: { id: task._id, clipId: "b" } });
    expect(locked.status).toBe(400);
  });
});

describe("GET /api/tasks/[id]/clips/[clipId]/file", () => {
  it("serves byte ranges, downloads and HEAD", async () => {
    const task = await completedTask();
    const params = { id: task._id, clipId: "a" };
    const partial = await call(fileRoute.GET, `/api/tasks/${task._id}/clips/a/file`, { headers: { range: "bytes=2-5" }, params });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(partial.headers.get("content-type")).toBe("video/mp4");
    expect(partial.headers.get("content-disposition")).toBe('inline; filename="clip_a.mp4"');
    expect(await partial.text()).toBe("2345");

    const download = await call(fileRoute.GET, `/api/tasks/${task._id}/clips/a/file?download=true`, { params });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toBe('attachment; filename="clip_a.mp4"');
    expect(await download.text()).toBe("0123456789");

    const head = await call(fileRoute.HEAD, `/api/tasks/${task._id}/clips/a/file`, { method: "HEAD", params });
    expect([head.status, head.headers.get("content-length"), await head.text()]).toEqual([200, "10", ""]);
  });

  it("404s a missing clip or file and 403s other users", async () => {
    const task = await completedTask();
    const noClip = await call(fileRoute.GET, "/x", { params: { id: task._id, clipId: "zzz" } });
    expect([noClip.status, await noClip.json()]).toEqual([404, { detail: "Clip not found" }]);
    await getStorage().delete(task.clips[0].storageKey);
    const noFile = await call(fileRoute.GET, "/x", { params: { id: task._id, clipId: "a" } });
    expect([noFile.status, await noFile.json()]).toEqual([404, { detail: "Clip file not found" }]);
    expect((await call(fileRoute.GET, "/x", { as: "bob", params: { id: task._id, clipId: "b" } })).status).toBe(403);
  });
});

describe("cancel and resume", () => {
  const post = (handler: unknown, id: string) => call(handler, `/api/tasks/${id}/x`, { method: "POST", params: { id } });

  it("cancels a pipeline run and its job", async () => {
    const created = await (await call(createRoute.POST, "/x", { method: "POST", body: { source: { url: "https://youtu.be/dQw4w9WgXcQ" } } })).json();
    const response = await post(cancelRoute.POST, created.task_id);
    expect(await response.json()).toEqual({ message: "Task cancellation requested" });
    expect(await stored(created.task_id)).toMatchObject({ status: "cancelled", progress: 0, progressMessage: "Cancelled by user" });
    const [job] = await jobsOf(created.task_id);
    expect(job.status).toBe("cancelled");
    expect(job.activeKey).toBeUndefined();

    expect(await (await post(cancelRoute.POST, created.task_id)).json()).toEqual({ message: "Task already in terminal state: cancelled" });
  });

  it("cancels a restyle back to completed and leaves the clips", async () => {
    const task = await completedTask();
    await call(settingsRoute.POST, "/x", { method: "POST", body: { caption_template: "neon", apply_to_existing: true }, params: { id: task._id } });
    const running = (await claimJob("w1", ["restyle_task"]))!;
    // Even if the worker rewrote `run` without its type, the job says it is a restyle.
    await collections().tasks.updateOne({ _id: task._id }, { $set: { run: { jobId: running._id, startedAt: new Date() } } });
    const response = await post(cancelRoute.POST, task._id);
    expect(await response.json()).toEqual({ message: "Task cancellation requested" });
    const after = await stored(task._id);
    expect(after).toMatchObject({ status: "completed", progress: 100, progressMessage: "Restyle cancelled. Your existing clips are unchanged." });
    expect(after.clips.map((c) => c.id)).toEqual(["a", "b"]);
    // The clips were never re-rendered, so neither are the settings changed.
    expect(after.settings).toEqual(task.settings);
    expect(await collections().jobs.findOne({ _id: running._id })).toMatchObject({ status: "running", cancelRequested: true });
  });

  it("compares a restyle after a cancelled one with the settings the clips were rendered with", async () => {
    const task = await completedTask();
    const restyle = (body: unknown) => call(settingsRoute.POST, "/x", { method: "POST", body, params: { id: task._id } });
    await restyle({ cut_long_pauses: false, apply_to_existing: true });
    await post(cancelRoute.POST, task._id);
    expect((await stored(task._id)).settings.cutLongPauses).toBe(true);
    await restyle({ cut_long_pauses: false, apply_to_existing: true });
    const jobs = await collections().jobs.find({ taskId: task._id }).sort({ createdAt: 1 }).toArray();
    expect(jobs.map((j) => [j.status, j.payload.cleanupChanged])).toEqual([["cancelled", true], ["queued", true]]);
  });

  it("resumes a cancelled or failed task with a new job", async () => {
    const task = await completedTask();
    await casStatus(task._id, ["completed"], { status: "error", progressMessage: "boom" });
    const response = await post(resumeRoute.POST, task._id);
    const body = await response.json();
    expect(body).toEqual({ message: "Task resumed", job_id: expect.stringMatching(/^[a-f0-9]{32}$/), worker_online: false });
    expect(await stored(task._id)).toMatchObject({ status: "queued", progress: 0, progressMessage: "Re-queued by user", run: { jobId: body.job_id, type: "process_task" } });
    expect(await jobsOf(task._id)).toEqual([expect.objectContaining({ _id: body.job_id, type: "process_task", activeKey: `task:${task._id}` })]);

    expect(await (await post(resumeRoute.POST, task._id)).json()).toEqual({ message: "Task already queued", worker_online: false });
  });

  it("refuses to resume a completed task or one whose last run is still stopping", async () => {
    const task = await completedTask();
    const done = await post(resumeRoute.POST, task._id);
    expect([done.status, await done.json()]).toEqual([400, { detail: "Only cancelled/error/queued tasks can be resumed" }]);

    // A cancelled run whose worker has not stopped yet still holds the task's key.
    await casStatus(task._id, ["completed"], { status: "queued" });
    await collections().jobs.insertOne({
      _id: "stopping", type: "process_task", taskId: task._id, userId: users.alice.id, payload: {}, status: "running",
      activeKey: `task:${task._id}`, cancelRequested: true, runAt: new Date(), attempts: 1, maxAttempts: 2, progress: 0,
      createdAt: new Date(), updatedAt: new Date(),
    } as JobDoc);
    await post(cancelRoute.POST, task._id);
    const busy = await post(resumeRoute.POST, task._id);
    expect([busy.status, await busy.json()]).toEqual([409, { detail: "The previous worker is still stopping. Retry resume in a moment." }]);
    expect(await stored(task._id)).toMatchObject({ status: "cancelled", progressMessage: "Cancelled by user" });
  });
});

describe("POST /api/tasks/[id]/settings", () => {
  const apply = (id: string, body: unknown, as: "alice" | "bob" = "alice") =>
    call(settingsRoute.POST, `/api/tasks/${id}/settings`, { method: "POST", body, as, params: { id } });

  it("saves style without a job when not applied to existing clips", async () => {
    const task = await completedTask();
    const response = await apply(task._id, { font_size: 40, font_color: "#abcdef", caption_template: "neon", filtered_words: "Um, uh" });
    const body = await response.json();
    expect(body.message).toBe("Task settings updated");
    expect(body).not.toHaveProperty("worker_online");
    expect(body.task).toMatchObject({ status: "completed", font_size: 40, font_color: "#ABCDEF", caption_template: "neon", filtered_words: ["um", "uh"], cut_long_pauses: true });
    expect(await jobsOf(task._id)).toEqual([]);
  });

  it("enqueues a restyle that keeps the clips visible", async () => {
    const task = await completedTask();
    const response = await apply(task._id, { caption_template: "hormozi", apply_to_existing: true });
    const body = await response.json();
    expect(body).toMatchObject({
      message: "Task settings updated",
      worker_online: false,
      task: { status: "processing", run_type: "restyle_task", progress: 0, progress_message: "Applying new style...", caption_template: "hormozi", clips_count: 2 },
    });
    const [job] = await jobsOf(task._id);
    expect(job).toMatchObject({ type: "restyle_task", status: "queued", activeKey: `task:${task._id}`, payload: { cleanupChanged: false } });
    expect((await stored(task._id)).run).toEqual({ jobId: job._id, type: "restyle_task" });

    const locked = await apply(task._id, { caption_template: "neon" });
    expect([locked.status, await locked.json()]).toEqual([400, { detail: "Wait for processing to finish before editing this task" }]);
  });

  it("flags changed cleanup for the restyle job", async () => {
    const task = await completedTask();
    await apply(task._id, { cut_long_pauses: false, apply_to_existing: true });
    expect((await jobsOf(task._id))[0].payload).toEqual({ cleanupChanged: true, previousSettings: task.settings });
  });

  it("rejects an unknown font, a missing upload and other users", async () => {
    const task = await completedTask({ upload: true });
    const font = await apply(task._id, { font_family: "NoSuchFont" });
    expect([font.status, await font.json()]).toEqual([400, { detail: "Selected font is not available" }]);
    await getStorage().delete(`uploads/${UPLOAD_ID}.mp4`);
    const source = await apply(task._id, { apply_to_existing: true });
    expect([source.status, await source.json()]).toEqual([400, { detail: "Source video file no longer exists" }]);
    expect((await apply(task._id, {}, "bob")).status).toBe(403);
    expect((await stored(task._id)).status).toBe("completed");
  });
});

describe("preset exports", () => {
  const start = (task: TaskDoc, clipId: string, body?: unknown, query = "") =>
    call(exportsRoute.POST, `/api/tasks/${task._id}/clips/${clipId}/exports${query}`, { method: "POST", body, params: { id: task._id, clipId } });
  const status = (task: TaskDoc, exportId: string) =>
    call(exportRoute.GET, "/x", { params: { id: task._id, clipId: "a", exportId } });
  const file = (task: TaskDoc, exportId: string) =>
    call(exportFileRoute.GET, "/x", { params: { id: task._id, clipId: "a", exportId } });

  it("queues one export per clip file and preset", async () => {
    const task = await completedTask();
    const first = await start(task, "a", { preset: "tiktok" });
    expect(first.status).toBe(202);
    const job = await first.json();
    expect(job).toEqual({ id: expect.any(String), status: "queued", progress: 0, preset: "tiktok", error: null, download_url: null, worker_online: false });
    expect((await (await start(task, "a")).json()).id).toBe(job.id);
    expect((await (await start(task, "a", undefined, "?preset=reels")).json()).id).not.toBe(job.id);
    expect((await (await start(task, "b", { preset: "tiktok" })).json()).id).not.toBe(job.id);
    expect(await collections().jobs.findOne({ _id: job.id })).toMatchObject({
      type: "export_clip",
      clipId: "a",
      payload: { preset: "tiktok", filename: "clip_a.mp4" },
    });

    const bad = await start(task, "a", { preset: "vimeo" });
    expect([bad.status, await bad.json()]).toEqual([400, { detail: "Invalid preset. Use one of: tiktok, reels, shorts" }]);
    expect((await start(task, "a", { preset: 5 })).status).toBe(400);
    expect((await start(task, "zzz")).status).toBe(404);
  });

  it("reports status in the preset vocabulary and serves the finished file", async () => {
    const task = await completedTask();
    const { id } = await (await start(task, "a")).json();
    const notReady = await file(task, id);
    expect([notReady.status, await notReady.json()]).toEqual([409, { detail: "Export is not ready" }]);

    const lease = (await claimJob("w1", ["export_clip"]))!;
    expect(await (await status(task, id)).json()).toMatchObject({ status: "running" });
    await writeKey(storageKeys.presetExport(id), "exported");
    await finishJob(lease, { status: "succeeded", expiresAt: new Date(Date.now() + 60_000) });
    expect(await (await status(task, id)).json()).toEqual({ id, status: "succeeded", progress: 100, preset: "tiktok", error: null, download_url: null });

    const download = await file(task, id);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toBe('attachment; filename="clip_a_tiktok.mp4"');
    expect(await download.text()).toBe("exported");
    expect((await (await start(task, "a")).json()).id).toBe(id);

    const missing = await status(task, "nope");
    expect([missing.status, await missing.json()]).toEqual([404, { detail: "Export not found" }]);
  });

  it("replaces a finished export whose file is gone", async () => {
    const task = await completedTask();
    const { id } = await (await start(task, "a")).json();
    const lease = (await claimJob("w1", ["export_clip"]))!;
    await finishJob(lease, { status: "succeeded", expiresAt: new Date(Date.now() + 60_000) });

    expect(await (await status(task, id)).json()).toMatchObject({ status: "failed", error: "Export file is no longer available." });
    const gone = await file(task, id);
    expect([gone.status, await gone.json()]).toEqual([404, { detail: "Export file is no longer available." }]);
    const fresh = await (await start(task, "a")).json();
    expect(fresh).toMatchObject({ status: "queued" });
    expect(fresh.id).not.toBe(id);
  });

  it("maps failed and cancelled exports to failed", async () => {
    const task = await completedTask();
    const { id } = await (await start(task, "a")).json();
    await collections().jobs.updateOne({ _id: id }, { $set: { status: "cancelled" }, $unset: { liveKey: "" } });
    expect(await (await status(task, id)).json()).toMatchObject({ status: "failed", error: "Export failed. Try again." });
  });
});
