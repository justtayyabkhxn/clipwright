/** @vitest-environment node */
// YouTube auto-post: task-scoped routes and their interaction with clip/task delete and restyle
// (design §4.7, §4.8). Real Better Auth sessions on a standalone mongod; no Google or Anthropic calls.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAuth } from "@/server/auth";
import { closeDb, collections, ensureIndexes } from "@/server/db";
import { resetEnv } from "@/server/env";
import { casStatus, createTask, pushClip, settingsFromCreateRequest } from "@/server/tasks";
import type { ClipDoc, YoutubePostDoc } from "@/server/types";
import { POST_UPLOADING_MESSAGE, RESTYLE_UPLOADING_MESSAGE } from "@/server/youtube/posts";

import * as clipRoute from "./[id]/clips/[clipId]/route";
import * as taskRoute from "./[id]/route";
import * as settingsRoute from "./[id]/settings/route";
import * as youtubeRoute from "./[id]/youtube/route";
import * as retryRoute from "./[id]/youtube/[postId]/retry/route";

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
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cw-task-youtube-"));
  process.env = {
    ...baseEnv,
    MONGODB_URI: mongod.getUri(),
    MONGODB_DB: "task_youtube_routes",
    MONGODB_TRANSACTIONS: "false",
    BETTER_AUTH_SECRET: "a-very-long-test-secret-for-task-yt-routes-01",
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
  const { tasks, jobs, youtubePosts, clipDrafts } = collections();
  await Promise.all([tasks.deleteMany({}), jobs.deleteMany({}), youtubePosts.deleteMany({}), clipDrafts.deleteMany({})]);
});

type Handler = (request: Request, context: { params: Promise<never> }) => Promise<Response>;

function call(
  handler: unknown,
  url: string,
  init: { method?: string; as?: "alice" | "bob" | null; body?: unknown; params?: object } = {},
) {
  const { method = "GET", as = "alice", body, params = {} } = init;
  const request = new Request(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...(as && { cookie: users[as].cookie }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (handler as Handler)(request, { params: Promise.resolve(params as never) });
}

function clip(id: string, overrides: Partial<ClipDoc> = {}): ClipDoc {
  const now = new Date();
  return {
    id,
    filename: `clip_${id}.mp4`,
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

/** A completed task of `userId`'s with one clip per id in `clipIds`. */
async function completedTask(clipIds: string[], userId = users.alice.id) {
  const task = await createTask({
    userId,
    source: { type: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Talk", videoId: "dQw4w9WgXcQ" },
    settings: settingsFromCreateRequest({}),
  });
  await casStatus(task._id, ["queued"], { status: "processing", run: { jobId: "j0" } });
  for (const id of clipIds) await pushClip(task._id, "j0", clip(id));
  await casStatus(task._id, ["processing"], { status: "completed", progress: 100, progressMessage: "Complete!" });
  return (await collections().tasks.findOne({ _id: task._id }))!;
}

function post(taskId: string, overrides: Partial<YoutubePostDoc> = {}): YoutubePostDoc {
  const now = new Date();
  return {
    _id: overrides._id ?? "p1",
    userId: users.alice.id,
    taskId,
    lineageId: "a",
    channelId: "UC1",
    state: "queued",
    attempts: 0,
    insertCalls: 0,
    insertCap: 3,
    privacy: "public",
    madeForKids: false,
    notifySubscribers: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function seedPost(taskId: string, overrides: Partial<YoutubePostDoc> = {}) {
  const doc = post(taskId, overrides);
  await collections().youtubePosts.insertOne(doc);
  return doc;
}

const jobsFor = (postId: string) => collections().jobs.find({ "payload.postId": postId }).toArray();

describe("GET /api/tasks/[id]/youtube", () => {
  it("returns serialized posts for the owner only", async () => {
    const task = await completedTask(["a", "b"]);
    await seedPost(task._id, { _id: "p1", lineageId: "a", state: "queued" });
    await seedPost(task._id, {
      _id: "p2",
      lineageId: "b",
      state: "uploaded",
      videoUrl: "https://www.youtube.com/watch?v=VID",
      metadata: { title: "Title", description: "Desc", tags: ["t1"], hashtags: ["h1"], model: "claude-sonnet-5" },
    });

    const response = await call(youtubeRoute.GET, `/api/tasks/${task._id}/youtube`, { params: { id: task._id } });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.posts).toHaveLength(2);
    const byId = Object.fromEntries(body.posts.map((p: { id: string; clip_id: string }) => [p.id, p]));
    expect(byId.p1).toMatchObject({ clip_id: "a", state: "queued" });
    expect(byId.p2).toMatchObject({ clip_id: "b", state: "uploaded", title: "Title", video_url: "https://www.youtube.com/watch?v=VID" });

    const theirs = await call(youtubeRoute.GET, `/api/tasks/${task._id}/youtube`, { as: "bob", params: { id: task._id } });
    expect(theirs.status).toBe(403);
    const missing = await call(youtubeRoute.GET, "/api/tasks/nope/youtube", { params: { id: "nope" } });
    expect(missing.status).toBe(404);
  });
});

describe("POST /api/tasks/[id]/youtube/[postId]/retry", () => {
  it("requeues a failed post with worker_online and 409s for uploaded", async () => {
    const task = await completedTask(["a"]);
    await seedPost(task._id, { _id: "p1", lineageId: "a", state: "failed", error: "boom", attempts: 3 });

    const response = await call(retryRoute.POST, `/api/tasks/${task._id}/youtube/p1/retry`, {
      method: "POST",
      params: { id: task._id, postId: "p1" },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ id: "p1", state: "queued", error: null, worker_online: false });
    expect(await jobsFor("p1")).toHaveLength(1);

    await seedPost(task._id, { _id: "p2", lineageId: "b", state: "uploaded" });
    const conflict = await call(retryRoute.POST, `/api/tasks/${task._id}/youtube/p2/retry`, {
      method: "POST",
      params: { id: task._id, postId: "p2" },
    });
    expect([conflict.status, await conflict.json()]).toEqual([409, { detail: "This clip is already on YouTube." }]);

    const theirs = await call(retryRoute.POST, `/api/tasks/${task._id}/youtube/p1/retry`, {
      method: "POST",
      as: "bob",
      params: { id: task._id, postId: "p1" },
    });
    expect(theirs.status).toBe(403);
  });
});

describe("DELETE /api/tasks/[id]/clips/[clipId]", () => {
  it("cancels the lineage's waiting post, and 409s while working", async () => {
    const task = await completedTask(["a", "b"]);
    await seedPost(task._id, { _id: "p1", lineageId: "a", state: "queued" });
    await seedPost(task._id, { _id: "p2", lineageId: "b", state: "working", claimedBy: "job1" });

    const ok = await call(clipRoute.DELETE, `/api/tasks/${task._id}/clips/a`, { method: "DELETE", params: { id: task._id, clipId: "a" } });
    expect(await ok.json()).toEqual({ message: "Clip deleted successfully" });
    expect((await collections().youtubePosts.findOne({ _id: "p1" }))?.state).toBe("cancelled");

    const blocked = await call(clipRoute.DELETE, `/api/tasks/${task._id}/clips/b`, { method: "DELETE", params: { id: task._id, clipId: "b" } });
    expect([blocked.status, await blocked.json()]).toEqual([409, { detail: POST_UPLOADING_MESSAGE }]);
    expect((await collections().youtubePosts.findOne({ _id: "p2" }))?.state).toBe("working");
    const stillThere = await collections().tasks.findOne({ _id: task._id });
    expect(stillThere?.clips.map((c) => c.id)).toEqual(["b"]);
  });
});

describe("DELETE /api/tasks/[id]", () => {
  it("cancels and deletes its posts", async () => {
    const task = await completedTask(["a"]);
    await casStatus(task._id, ["completed"], { status: "error" }); // idle, so delete is allowed
    await seedPost(task._id, { _id: "p1", lineageId: "a", state: "queued" });

    const response = await call(taskRoute.DELETE, `/api/tasks/${task._id}`, { method: "DELETE", params: { id: task._id } });

    expect(await response.json()).toEqual({ message: "Task deleted successfully" });
    expect(await collections().tasks.findOne({ _id: task._id })).toBeNull();
    expect(await collections().youtubePosts.countDocuments({ taskId: task._id })).toBe(0);
  });

  it("refuses while a post is working, leaving the task and its posts alone", async () => {
    const task = await completedTask(["a"]);
    await casStatus(task._id, ["completed"], { status: "error" });
    await seedPost(task._id, { _id: "p1", lineageId: "a", state: "working", claimedBy: "job1" });

    const response = await call(taskRoute.DELETE, `/api/tasks/${task._id}`, { method: "DELETE", params: { id: task._id } });

    expect([response.status, await response.json()]).toEqual([409, { detail: POST_UPLOADING_MESSAGE }]);
    expect(await collections().tasks.findOne({ _id: task._id })).not.toBeNull();
    expect((await collections().youtubePosts.findOne({ _id: "p1" }))?.state).toBe("working");
  });
});

describe("POST /api/tasks/[id]/settings (restyle)", () => {
  it("409s while a post is working", async () => {
    const task = await completedTask(["a"]);
    await seedPost(task._id, { _id: "p1", lineageId: "a", state: "working", claimedBy: "job1" });

    const response = await call(settingsRoute.POST, `/api/tasks/${task._id}/settings`, {
      method: "POST",
      body: { caption_template: "neon", apply_to_existing: true },
      params: { id: task._id },
    });

    expect([response.status, await response.json()]).toEqual([409, { detail: RESTYLE_UPLOADING_MESSAGE }]);
    expect((await collections().tasks.findOne({ _id: task._id }))?.status).toBe("completed");
  });
});
