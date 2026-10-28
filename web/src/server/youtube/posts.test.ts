/** @vitest-environment node */
// Post repository (design §4.2, §4.4, §4.6, §4.7, §4.8): creation, the claim/cancel CAS, the
// private-lock circuit breaker, retry and the serializer. In-memory MongoDB; no Google or Anthropic calls.

import { type BulkWriteResult, Collection, MongoBulkWriteError, MongoNetworkError } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, collections, ensureIndexes } from "../db";
import { resetEnv } from "../env";
import type { ClipDoc, TaskDoc, YoutubeAccountDoc, YoutubePostDoc } from "../types";
import {
  blockPost,
  cancelClaimedPost,
  cancelPostForLineage,
  cancelPostsForTask,
  cancelPostsForUser,
  claimPost,
  clearMetadata,
  createPostsForTask,
  deferAllQueuedForQuota,
  deferPost,
  failPost,
  markUploaded,
  resumePosting,
  retryPost,
  saveMetadata,
  saveSession,
  serializePosts,
  setPhase,
  takeInsertCall,
  tripPrivateLock,
  unblockAfterReconnect,
} from "./posts";

let mongod: MongoMemoryServer;
const baseEnv = { ...process.env };
const USER = "u1";

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env = { ...baseEnv, MONGODB_URI: mongod.getUri(), MONGODB_DB: "youtube_posts", BETTER_AUTH_SECRET: "s".repeat(32) };
  resetEnv();
  await ensureIndexes();
});

afterAll(async () => {
  await closeDb();
  await mongod.stop();
  process.env = baseEnv;
  resetEnv();
});

beforeEach(async () => {
  const { tasks, jobs, youtubeAccounts, youtubePosts } = collections();
  await Promise.all([tasks.deleteMany({}), jobs.deleteMany({}), youtubeAccounts.deleteMany({}), youtubePosts.deleteMany({})]);
});

function clip(id: string, overrides: Partial<ClipDoc> = {}): ClipDoc {
  const now = new Date();
  return {
    id,
    filename: `${id}.mp4`,
    storageKey: `clips/t1/${id}.mp4`,
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

async function seedTask(clips: ClipDoc[], overrides: Partial<TaskDoc> = {}) {
  const now = new Date();
  await collections().tasks.insertOne({
    _id: "t1",
    userId: USER,
    status: "completed",
    progress: 100,
    progressMessage: "Complete!",
    source: { type: "youtube", url: "https://www.youtube.com/watch?v=abcdefghijk", title: "Talk" },
    settings: {} as TaskDoc["settings"],
    clips,
    autopost: "pending",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

async function seedAccount(overrides: Partial<YoutubeAccountDoc> = {}) {
  const now = new Date();
  await collections().youtubeAccounts.insertOne({
    _id: USER,
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
    ...overrides,
  });
}

function post(overrides: Partial<YoutubePostDoc> = {}): YoutubePostDoc {
  const now = new Date();
  return {
    _id: "p1",
    userId: USER,
    taskId: "t1",
    lineageId: "c1",
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

async function seedPost(overrides: Partial<YoutubePostDoc> = {}): Promise<YoutubePostDoc> {
  const doc = post(overrides);
  await collections().youtubePosts.insertOne(doc);
  return doc;
}

const storedPosts = () => collections().youtubePosts.find({}).toArray();
const storedPost = async (id: string) => (await collections().youtubePosts.findOne({ _id: id }))!;
const publishJobs = () => collections().jobs.find({ type: "publish_youtube" }).toArray();
const autopostFlag = async () => (await collections().tasks.findOne({ _id: "t1" }))?.autopost;
const storedAccount = () => collections().youtubeAccounts.findOne({ _id: USER });
const video = (privacyStatus: string, id = "VID") => ({ id, status: { privacyStatus, uploadStatus: "uploaded" } });
/** Seed p1 (plus `overrides`) and claim it for job1. */
async function claimed(overrides: Partial<YoutubePostDoc> = {}): Promise<YoutubePostDoc> {
  await seedPost(overrides);
  return (await claimPost("p1", "job1"))!;
}

describe("createPostsForTask", () => {
  it("creates one post per non-fallback clip in order, notifying only the first", async () => {
    await seedAccount({ privacy: "unlisted", madeForKids: true });
    await seedTask([clip("c1"), clip("fb", { hookType: "fallback" }), clip("c2", { lineageId: "orig2" }), clip("c3")]);

    expect(await createPostsForTask("t1")).toBe(3);

    const posts = await storedPosts();
    expect(Object.fromEntries(posts.map((p) => [p.lineageId, p.notifySubscribers]))).toEqual({ c1: true, orig2: false, c3: false });
    for (const p of posts) {
      expect(p).toMatchObject({
        userId: USER,
        taskId: "t1",
        channelId: "UC1",
        state: "queued",
        attempts: 0,
        insertCalls: 0,
        insertCap: 3,
        privacy: "unlisted",
        madeForKids: true,
      });
      expect(p.waitReason).toBeUndefined();
    }
    const byLineage = Object.fromEntries(posts.map((p) => [p.lineageId, p._id]));
    const jobs = await publishJobs();
    expect(jobs.map((job) => job.payload.postId)).toEqual([byLineage.c1, byLineage.orig2, byLineage.c3]);
    for (const job of jobs) {
      expect(job).toMatchObject({ taskId: "t1", userId: USER, status: "queued", activeKey: `youtube:${job.payload.postId}` });
    }
    expect(await autopostFlag()).toBe("done");
  });

  it("is idempotent across repeated calls", async () => {
    await seedAccount();
    await seedTask([clip("c1"), clip("c2")]);
    expect(await createPostsForTask("t1")).toBe(2);

    // A crash before the flag flip leaves the task pending; the cron runs it again.
    await collections().tasks.updateOne({ _id: "t1" }, { $set: { autopost: "pending" } });
    expect(await createPostsForTask("t1")).toBe(0);

    expect(await storedPosts()).toHaveLength(2);
    expect(await publishJobs()).toHaveLength(2);
    expect(await autopostFlag()).toBe("done");
  });

  it("creates blocked posts for a reauth_required account", async () => {
    await seedAccount({ status: "reauth_required" });
    await seedTask([clip("c1")]);

    expect(await createPostsForTask("t1")).toBe(1);

    expect(await storedPosts()).toEqual([expect.objectContaining({ state: "blocked", waitReason: "reconnect" })]);
    expect(await publishJobs()).toHaveLength(0);
    expect(await autopostFlag()).toBe("done");
  });

  it.each(["active", "paused", "reauth_required"] as const)("blocks posts as private_lock while the lock is set (%s)", async (status) => {
    await seedAccount({ status, warning: "private_lock" });
    await seedTask([clip("c1")]);

    await createPostsForTask("t1");

    expect(await storedPosts()).toEqual([expect.objectContaining({ state: "blocked", waitReason: "private_lock" })]);
    expect(await publishJobs()).toHaveLength(0);
  });

  it("rethrows a bulk error that is not a duplicate lineage, leaving the task pending", async () => {
    await seedAccount();
    await seedTask([clip("c1")]);
    // What mongodb 7 throws from insertMany on a network failure: a bulk error with no write errors.
    const networkError = new MongoBulkWriteError(new MongoNetworkError("connection reset"), { insertedCount: 0 } as BulkWriteResult);
    const insertMany = vi.spyOn(Collection.prototype, "insertMany").mockRejectedValueOnce(networkError);
    try {
      await expect(createPostsForTask("t1")).rejects.toBe(networkError);
    } finally {
      insertMany.mockRestore();
    }

    expect(await autopostFlag()).toBe("pending");
    expect(await publishJobs()).toHaveLength(0);
    // The cron's re-run then creates the posts.
    expect(await createPostsForTask("t1")).toBe(1);
    expect(await autopostFlag()).toBe("done");
  });

  it("creates nothing when auto-post is off", async () => {
    await seedAccount({ autoPost: false });
    await seedTask([clip("c1")]);

    expect(await createPostsForTask("t1")).toBe(0);
    expect(await storedPosts()).toHaveLength(0);
    expect(await publishJobs()).toHaveLength(0);
    expect(await autopostFlag()).toBe("done");

    // Never a backfill: a task that is not pending gets nothing, even with auto-post on.
    await collections().youtubeAccounts.updateOne({ _id: USER }, { $set: { autoPost: true } });
    expect(await createPostsForTask("t1")).toBe(0);
    expect(await storedPosts()).toHaveLength(0);
  });
});

describe("claim and cancel", () => {
  it("claim and cancel race: exactly one wins", async () => {
    for (let i = 0; i < 20; i++) {
      await collections().youtubePosts.deleteMany({});
      await seedPost();
      const claim = claimPost("p1", "job1");
      const cancel = cancelPostForLineage("t1", "c1");
      const [claimed, cancelled] = i % 2 ? await Promise.all([claim, cancel]) : (await Promise.all([cancel, claim])).reverse();

      const final = await storedPost("p1");
      if (claimed) {
        expect(cancelled).toBe("working");
        expect(final).toMatchObject({ state: "working", claimedBy: "job1" });
      } else {
        expect(cancelled).toBe("cancelled");
        expect(final.state).toBe("cancelled");
      }
    }
  });

  it("re-claim by the same job id succeeds after a restart", async () => {
    await seedPost();
    expect(await claimPost("p1", "job1")).toMatchObject({ state: "working", claimedBy: "job1" });
    expect(await claimPost("p1", "job2")).toBeNull();
    expect(await claimPost("p1", "job1")).toMatchObject({ state: "working", claimedBy: "job1" });

    await seedPost({ _id: "later", lineageId: "c2", notBefore: new Date(Date.now() + 60_000), waitReason: "quota" });
    expect(await claimPost("later", "job3")).toBeNull();
    await seedPost({ _id: "due", lineageId: "c3", notBefore: new Date(Date.now() - 1_000), waitReason: "quota" });
    expect(await claimPost("due", "job4")).toMatchObject({ state: "working", claimedBy: "job4" });
  });

  it("transitions only apply while the caller still holds the claim", async () => {
    await seedPost();
    const claimed = (await claimPost("p1", "job1"))!;
    expect(await deferPost({ ...claimed, claimedBy: "stale-job" }, "retry", new Date())).toBe(false);
    expect((await storedPost("p1")).state).toBe("working");

    const until = new Date(Date.now() + 60_000);
    expect(await deferPost(claimed, "retry", until, "Upload interrupted; retrying.")).toBe(true);
    expect(await storedPost("p1")).toMatchObject({ state: "queued", waitReason: "retry", notBefore: until, attempts: 1, error: "Upload interrupted; retrying." });
    expect((await storedPost("p1")).claimedBy).toBeUndefined();
  });

  it("cancels queued, blocked and failed posts, never working or uploaded ones", async () => {
    for (const [id, state] of [["q", "queued"], ["b", "blocked"], ["f", "failed"], ["w", "working"], ["u", "uploaded"]] as const) {
      await seedPost({ _id: id, lineageId: id, state });
      await seedPost({ _id: `other-${id}`, lineageId: `other-${id}`, state, taskId: "t2", userId: "u2", errorReason: "backendError" });
    }

    expect(await cancelPostsForTask("t1")).toEqual({ cancelled: 3, working: 1 });
    expect(await cancelPostsForUser("u2", "Auto-post was turned off.")).toBe(3);

    const states = Object.fromEntries((await storedPosts()).map((p) => [p._id, p.state]));
    expect(states).toEqual({
      q: "cancelled", b: "cancelled", f: "cancelled", w: "working", u: "uploaded",
      "other-q": "cancelled", "other-b": "cancelled", "other-f": "cancelled", "other-w": "working", "other-u": "uploaded",
    });
    expect((await storedPost("other-q")).error).toBe("Auto-post was turned off.");
    expect((await storedPost("other-f")).errorReason).toBeUndefined();
    expect((await storedPost("other-w")).errorReason).toBe("backendError");
    expect(await cancelPostForLineage("t1", "u")).toBe("none");
  });

  it("cancelPostsForUser with exceptChannelId spares posts already on that channel", async () => {
    await seedPost({ _id: "old", lineageId: "old", userId: "u3", channelId: "UC-old", state: "queued" });
    await seedPost({ _id: "new", lineageId: "new", userId: "u3", channelId: "UC-new", state: "queued" });

    expect(await cancelPostsForUser("u3", "Not posted: a different channel was connected.", { exceptChannelId: "UC-new" })).toBe(1);

    expect((await storedPost("old")).state).toBe("cancelled");
    expect((await storedPost("new")).state).toBe("queued");
  });
});

describe("transitions of a claimed post", () => {
  it("deferPost with a new error drops the old reason code", async () => {
    const post = await claimed({ error: "Upload failed.", errorReason: "backendError" });
    expect(await deferPost(post, "retry", new Date(), "Upload interrupted; retrying.")).toBe(true);
    const stored = await storedPost("p1");
    expect(stored).toMatchObject({ state: "queued", waitReason: "retry", error: "Upload interrupted; retrying." });
    expect(stored.errorReason).toBeUndefined();
  });

  it("blockPost blocks the post for the claim holder only", async () => {
    const post = await claimed({ phase: "uploading", progress: 40, error: "Upload failed.", errorReason: "backendError" });
    expect(await blockPost({ ...post, claimedBy: "stale-job" }, "reconnect", "Reconnect YouTube to post.")).toBe(false);
    expect((await storedPost("p1")).state).toBe("working");

    expect(await blockPost(post, "reconnect", "Reconnect YouTube to post.")).toBe(true);
    const stored = await storedPost("p1");
    expect(stored).toMatchObject({ state: "blocked", waitReason: "reconnect", error: "Reconnect YouTube to post." });
    for (const field of ["claimedBy", "phase", "progress", "notBefore", "errorReason"] as const) expect(stored[field]).toBeUndefined();
  });

  it("failPost records the error and its reason code for the claim holder only", async () => {
    const post = await claimed({ phase: "writing" });
    expect(await failPost({ ...post, claimedBy: "stale-job" }, "Upload failed.", "backendError")).toBe(false);
    expect((await storedPost("p1")).state).toBe("working");

    expect(await failPost(post, "Upload failed.", "backendError")).toBe(true);
    const stored = await storedPost("p1");
    expect(stored).toMatchObject({ state: "failed", error: "Upload failed.", errorReason: "backendError" });
    for (const field of ["claimedBy", "phase", "waitReason", "notBefore"] as const) expect(stored[field]).toBeUndefined();

    // Without a reason code, the stale one is dropped.
    await collections().youtubePosts.deleteMany({});
    expect(await failPost(await claimed({ errorReason: "backendError" }), "The clip file is missing.")).toBe(true);
    expect(await storedPost("p1")).toMatchObject({ state: "failed", error: "The clip file is missing." });
    expect((await storedPost("p1")).errorReason).toBeUndefined();
  });

  it("claim-fenced transitions never overwrite an uploaded post", async () => {
    await seedAccount();
    const post = await claimed();
    expect(await markUploaded(post, video("public"))).toBe(true);

    expect(await deferPost(post, "retry", new Date(), "Upload interrupted; retrying.")).toBe(false);
    expect(await blockPost(post, "reconnect", "Reconnect YouTube to post.")).toBe(false);
    expect(await failPost(post, "Upload failed.", "backendError")).toBe(false);
    const stored = await storedPost("p1");
    expect(stored).toMatchObject({ state: "uploaded", videoId: "VID" });
    for (const field of ["error", "errorReason", "waitReason", "notBefore"] as const) expect(stored[field]).toBeUndefined();
  });

  it("session and metadata writes need no claim and never touch an uploaded post", async () => {
    const upload = { sessionUri: "https://upload.example/s", storageKey: "clips/t1/c1.mp4", size: 10, startedAt: new Date() };
    const metadata = { title: "Why index funds win", description: "Fees compound.", tags: ["index funds"], hashtags: ["investing"], model: "claude-sonnet-5" };
    await seedPost();
    await saveSession("p1", upload);
    await saveMetadata("p1", metadata);
    expect(await storedPost("p1")).toMatchObject({ state: "queued", upload, metadata });
    await clearMetadata("p1");
    expect((await storedPost("p1")).metadata).toBeUndefined();
    expect((await storedPost("p1")).upload).toEqual(upload);

    const posted = { ...metadata, title: "As posted" };
    await seedPost({ _id: "u", lineageId: "c2", state: "uploaded", videoId: "VID", metadata: posted });
    await saveSession("u", upload);
    await saveMetadata("u", metadata);
    await clearMetadata("u");
    const stored = await storedPost("u");
    expect(stored.metadata).toEqual(posted);
    expect(stored.upload).toBeUndefined();
  });

  it("takeInsertCall counts session starts up to the post's cap, for the claim holder only", async () => {
    const post = await claimed({ insertCalls: 1, insertCap: 3 });
    expect(await takeInsertCall({ ...post, claimedBy: "stale-job" })).toBe(false);
    expect(await takeInsertCall(post)).toBe(true);
    expect(await takeInsertCall(post)).toBe(true);
    expect(await takeInsertCall(post)).toBe(false);
    expect((await storedPost("p1")).insertCalls).toBe(3);

    // A manual retry's raised cap allows exactly one more.
    await collections().youtubePosts.updateOne({ _id: "p1" }, { $set: { insertCap: 4 } });
    expect(await takeInsertCall(post)).toBe(true);
    expect(await takeInsertCall(post)).toBe(false);
    expect((await storedPost("p1")).insertCalls).toBe(4);
  });

  it("setPhase marks what the claim holder is doing", async () => {
    const post = await claimed();
    expect(await setPhase({ ...post, claimedBy: "stale-job" }, "writing")).toBe(false);
    expect((await storedPost("p1")).phase).toBeUndefined();
    expect(await setPhase(post, "uploading")).toBe(true);
    expect(await storedPost("p1")).toMatchObject({ state: "working", phase: "uploading" });
  });

  it("cancelClaimedPost cancels with an error for the claim holder only", async () => {
    const post = await claimed({ phase: "writing", errorReason: "backendError" });
    expect(await cancelClaimedPost({ ...post, claimedBy: "stale-job" }, "Not posted: a different channel was connected.")).toBe(false);
    expect((await storedPost("p1")).state).toBe("working");

    expect(await cancelClaimedPost(post, "Not posted: a different channel was connected.")).toBe(true);
    const stored = await storedPost("p1");
    expect(stored).toMatchObject({ state: "cancelled", error: "Not posted: a different channel was connected." });
    for (const field of ["claimedBy", "phase", "errorReason", "waitReason", "notBefore"] as const) expect(stored[field]).toBeUndefined();
  });

  it("markUploaded with the requested privacy does not trip the breaker", async () => {
    await seedAccount();
    await seedPost({ _id: "next", lineageId: "c2" });
    const post = await claimed({ privacy: "unlisted" });

    expect(await markUploaded(post, video("unlisted"))).toBe(true);
    const stored = await storedPost("p1");
    expect(stored).toMatchObject({ state: "uploaded", privacyStatus: "unlisted" });
    expect(stored.warning).toBeUndefined();
    const account = await storedAccount();
    expect(account?.status).toBe("active");
    expect(account?.warning).toBeUndefined();
    expect((await storedPost("next")).state).toBe("queued");
  });

  it("markUploaded on an already-uploaded post records nothing and does not trip the breaker", async () => {
    await seedAccount();
    await seedPost({ _id: "next", lineageId: "c2" });
    const uploadedAt = new Date("2026-10-28T10:00:00Z");
    const post = await seedPost({ state: "uploaded", videoId: "VID", videoUrl: "https://www.youtube.com/watch?v=VID", privacyStatus: "public", uploadStatus: "processed", uploadedAt });

    expect(await markUploaded(post, video("private", "OTHER"))).toBe(false);
    const stored = await storedPost("p1");
    expect(stored).toMatchObject({ videoId: "VID", privacyStatus: "public", uploadStatus: "processed", uploadedAt });
    expect(stored.warning).toBeUndefined();
    const account = await storedAccount();
    expect(account?.status).toBe("active");
    expect(account?.warning).toBeUndefined();
    expect((await storedPost("next")).state).toBe("queued");
  });
});

describe("account-wide transitions", () => {
  it("tripPrivateLock pauses the account and blocks queued posts; resumePosting undoes it", async () => {
    await seedAccount();
    await seedPost({ _id: "q", lineageId: "c1" });
    await seedPost({ _id: "b", lineageId: "c2", state: "blocked", waitReason: "reconnect" });
    await seedPost({ _id: "u", lineageId: "c3", state: "uploaded" });

    await tripPrivateLock(USER);
    expect(await collections().youtubeAccounts.findOne({ _id: USER })).toMatchObject({ status: "paused", warning: "private_lock" });
    expect(await storedPost("q")).toMatchObject({ state: "blocked", waitReason: "private_lock" });
    expect(await storedPost("b")).toMatchObject({ state: "blocked", waitReason: "reconnect" });
    expect((await storedPost("u")).state).toBe("uploaded");

    // A reconnect never releases the lock, and the lock wins over the reconnect a post waited for.
    expect(await unblockAfterReconnect(USER)).toBe(0);
    expect(await storedPost("q")).toMatchObject({ state: "blocked", waitReason: "private_lock" });
    expect(await storedPost("b")).toMatchObject({ state: "blocked", waitReason: "private_lock" });
    expect(await publishJobs()).toHaveLength(0);

    const account = await resumePosting(USER);
    expect(account).toMatchObject({ status: "active" });
    expect(account?.warning).toBeUndefined();
    for (const id of ["q", "b"]) {
      const resumed = await storedPost(id);
      expect(resumed.state).toBe("queued");
      expect(resumed.waitReason).toBeUndefined();
    }
    expect((await publishJobs()).map((job) => job.payload.postId).sort()).toEqual(["b", "q"]);
  });

  it("unblockAfterReconnect queues every blocked post but private_lock's on an unlocked account", async () => {
    await seedAccount();
    await seedPost({ _id: "b", state: "blocked", waitReason: "reconnect", error: "Reconnect YouTube to post.", errorReason: "invalid_grant" });
    await seedPost({ _id: "lock", lineageId: "c2", state: "blocked", waitReason: "private_lock" });
    await seedPost({ _id: "f", lineageId: "c3", state: "failed", error: "Upload failed." });
    await seedPost({ _id: "other", lineageId: "c4", userId: "u2", state: "blocked", waitReason: "reconnect" });

    expect(await unblockAfterReconnect(USER)).toBe(1);
    const queued = await storedPost("b");
    expect(queued.state).toBe("queued");
    for (const field of ["waitReason", "error", "errorReason"] as const) expect(queued[field]).toBeUndefined();
    expect(await storedPost("lock")).toMatchObject({ state: "blocked", waitReason: "private_lock" });
    expect((await storedPost("f")).state).toBe("failed");
    expect((await storedPost("other")).state).toBe("blocked");
    expect((await publishJobs()).map((job) => job.payload.postId)).toEqual(["b"]);
  });

  it("keeps a reauth_required account's status through the lock, and its posts wait for a reconnect", async () => {
    await seedAccount({ status: "reauth_required" });
    await seedPost({ _id: "q" });

    await tripPrivateLock(USER);
    expect(await collections().youtubeAccounts.findOne({ _id: USER })).toMatchObject({ status: "reauth_required", warning: "private_lock" });
    expect(await storedPost("q")).toMatchObject({ state: "blocked", waitReason: "private_lock" });

    const account = await resumePosting(USER);
    expect(account).toMatchObject({ status: "reauth_required" });
    expect(account?.warning).toBeUndefined();
    expect(await storedPost("q")).toMatchObject({ state: "blocked", waitReason: "reconnect" });
    expect(await publishJobs()).toHaveLength(0);

    expect(await unblockAfterReconnect(USER)).toBe(1);
    expect((await storedPost("q")).state).toBe("queued");
  });

  it("records an upload, and a privacy other than requested trips the breaker", async () => {
    await seedAccount();
    await seedPost({ upload: { sessionUri: "https://upload.example/s", storageKey: "clips/t1/c1.mp4", size: 10, startedAt: new Date() } });
    await seedPost({ _id: "next", lineageId: "c2" });
    const claimed = (await claimPost("p1", "job1"))!;

    expect(await markUploaded(claimed, { id: "VID", status: { privacyStatus: "private", uploadStatus: "uploaded" } })).toBe(true);

    const uploaded = await storedPost("p1");
    expect(uploaded).toMatchObject({
      state: "uploaded",
      videoId: "VID",
      videoUrl: "https://www.youtube.com/watch?v=VID",
      privacyStatus: "private",
      uploadStatus: "uploaded",
      warning: "private_lock",
    });
    expect(uploaded.upload).toBeUndefined();
    expect(uploaded.uploadedAt).toBeInstanceOf(Date);
    expect(await collections().youtubeAccounts.findOne({ _id: USER })).toMatchObject({ status: "paused", warning: "private_lock" });
    expect(await storedPost("next")).toMatchObject({ state: "blocked", waitReason: "private_lock" });
  });

  it("defers every queued post for the quota without shortening a longer wait", async () => {
    const until = new Date(Date.now() + 3_600_000);
    const later = new Date(Date.now() + 6 * 3_600_000);
    await seedPost({ _id: "q" });
    await seedPost({ _id: "other-user", lineageId: "c2", userId: "u2" });
    await seedPost({ _id: "limited", lineageId: "c3", notBefore: later, waitReason: "channel_limit" });
    await seedPost({ _id: "b", lineageId: "c4", state: "blocked", waitReason: "reconnect" });

    expect(await deferAllQueuedForQuota(until)).toBe(2);
    expect(await storedPost("q")).toMatchObject({ notBefore: until, waitReason: "quota" });
    expect(await storedPost("other-user")).toMatchObject({ notBefore: until, waitReason: "quota" });
    expect(await storedPost("limited")).toMatchObject({ notBefore: later, waitReason: "channel_limit" });
    expect(await storedPost("b")).toMatchObject({ state: "blocked", waitReason: "reconnect" });
  });
});

describe("retryPost", () => {
  it("retry raises the insert cap by one and refuses uploaded posts", async () => {
    await seedPost({ state: "failed", attempts: 4, insertCalls: 3, insertCap: 3, error: "Upload failed.", errorReason: "backendError" });

    const { post: retried, job } = await retryPost("p1", USER);
    expect(retried).toMatchObject({ state: "queued", attempts: 0, insertCalls: 3, insertCap: 4 });
    expect(retried.error).toBeUndefined();
    expect(retried.errorReason).toBeUndefined();
    expect(job).toMatchObject({ type: "publish_youtube", status: "queued", activeKey: "youtube:p1", payload: { postId: "p1" } });

    // Retry adds an allowance, it never lowers one a post has not used up.
    await seedPost({ _id: "fresh", lineageId: "c2", state: "blocked", waitReason: "reconnect" });
    expect((await retryPost("fresh", USER)).post).toMatchObject({ state: "queued", insertCap: 3 });

    await seedPost({ _id: "done", lineageId: "c3", state: "uploaded" });
    await expect(retryPost("done", USER)).rejects.toMatchObject({ status: 409 });
    await expect(retryPost("p1", USER)).rejects.toMatchObject({ status: 409 }); // already queued
    await expect(retryPost("p1", "someone-else")).rejects.toMatchObject({ status: 404 });
  });
});

describe("serializePosts", () => {
  it("serializer never outputs upload, tokens, claimedBy or storage keys", () => {
    const notBefore = new Date("2026-10-28T16:05:00Z");
    const task = { clips: [clip("c2", { lineageId: "c1" })] } as TaskDoc;
    const working = post({
      state: "working",
      phase: "uploading",
      progress: 40,
      claimedBy: "job-holding-claim",
      insertCalls: 3,
      notBefore,
      waitReason: "retry",
      metadata: { title: "Why index funds win", description: "Fees compound.", tags: ["index funds"], hashtags: ["investing"], language: "en", model: "claude-sonnet-5" },
      upload: { sessionUri: "https://upload.example/session?upload_id=SESSIONSECRET", storageKey: "clips/t1/c2.mp4", size: 10, startedAt: new Date() },
    });
    const orphan = post({ _id: "p2", lineageId: "gone", state: "cancelled" });

    const out = serializePosts(task, [working, orphan]);

    expect(out.posts[0]).toEqual({
      id: "p1",
      clip_id: "c2",
      state: "working",
      phase: "uploading",
      progress: 40,
      wait_reason: "retry",
      title: "Why index funds win",
      description: "Fees compound.",
      tags: ["index funds"],
      hashtags: ["investing"],
      video_url: null,
      privacy_status: null,
      warning: null,
      error: null,
      not_before: notBefore.toISOString(),
      insert_cap_reached: true,
    });
    expect(out.posts[1]).toMatchObject({ id: "p2", clip_id: null, title: null, tags: [], hashtags: [], insert_cap_reached: false });
    const json = JSON.stringify(out);
    for (const secret of ["upload_id", "SESSIONSECRET", "sessionUri", "clips/t1", "storageKey", "job-holding-claim", "claimed", "token", "Token"]) {
      expect(json).not.toContain(secret);
    }
  });
});
