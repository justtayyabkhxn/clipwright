/** @vitest-environment node */
import fs from "node:fs/promises";
import path from "node:path";
import { Collection } from "mongodb";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { collections } from "../server/db";
import { PREPARE_FAILED_MESSAGE } from "../server/drafts";
import { paths } from "../server/env";
import { claimJob, enqueueJob, finishJob, reapExpiredJobs, WORKER_STOPPED_ERROR } from "../server/jobs";
import { encryptSetting } from "../server/settings";
import { getStorage, storageKeys, uploadKeys } from "../server/storage";
import { EXPORT_EXPIRED_MESSAGE, RESTYLE_FAILED_MESSAGE, settingsFromCreateRequest, WORKER_STOPPED_TASK_MESSAGE } from "../server/tasks";
import type { JobDoc, JobType, YoutubeAccountDoc, YoutubePostDoc } from "../server/types";
import {
  deleteOldJobs,
  dispatchDuePosts,
  expireExports,
  refreshVideoStats,
  releaseOrphanedPosts,
  resumePendingAutopost,
  runCron,
  sweepUploads,
  sweepWorkDirs,
  sweepYoutubeSources,
  verifyUploads,
} from "./cron";
import { EXPORT_STOPPED_MESSAGE } from "./handlers/export-clip";
import { createJobContext } from "./context";
import { registerFailureHooks, runJob } from "./run-job";
import { claimed, clipFixture, exists, fakeEngine, fakeRender, seedTask, untilAborted, setupWorkerTestEnv, writeFile } from "./test-utils";

setupWorkerTestEnv("cron", { env: { ANTHROPIC_API_KEY: "sk-ant-test", ASSEMBLY_AI_API_KEY: "aai" } });
beforeAll(() => registerFailureHooks());

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const storage = () => getStorage();
const job = (id: string) => collections().jobs.findOne({ _id: id });

async function finished(type: JobType, status: JobDoc["status"], fields: Partial<JobDoc> = {}) {
  const { job: inserted } = await enqueueJob({ type, taskId: "t1", userId: "u1", clipId: "c1" });
  await collections().jobs.updateOne({ _id: inserted._id }, { $set: { status, ...fields } });
  return inserted._id;
}

describe("cron", () => {
  it("expires finished exports: file deleted, liveKey freed, doc kept", async () => {
    const now = new Date();
    const expiredId = await finished("export_clip", "succeeded", { expiresAt: new Date(+now - 1000), liveKey: "c1:a" });
    const freshId = await finished("export_editor", "succeeded", { expiresAt: new Date(+now + DAY) });
    const expiredKey = storageKeys.presetExport(expiredId);
    const freshKey = storageKeys.editorExport(freshId);
    await collections().jobs.updateOne({ _id: freshId }, { $set: { result: { fileKey: freshKey } } });
    for (const key of [expiredKey, freshKey]) await writeFile(await storage().localPath(key));

    expect(await expireExports(now)).toBe(1);
    const expired = (await job(expiredId))!;
    expect(expired).toMatchObject({ status: "failed", error: EXPORT_EXPIRED_MESSAGE });
    expect(expired.liveKey).toBeUndefined();
    expect(await storage().stat(expiredKey)).toBeNull();
    expect((await job(freshId))!.status).toBe("succeeded");
    expect(await storage().stat(freshKey)).not.toBeNull();
  });

  it("deletes finished job docs untouched for 7 days, with their files", async () => {
    const now = new Date();
    const oldId = await finished("combine_editor", "succeeded", { updatedAt: new Date(+now - 8 * DAY) });
    const recentId = await finished("export_clip", "failed", { updatedAt: new Date(+now - DAY) });
    const runningId = await finished("process_task", "running", { updatedAt: new Date(+now - 9 * DAY) });
    await writeFile(await storage().localPath(storageKeys.editorExport(oldId)));

    expect(await deleteOldJobs(now)).toBe(1);
    expect(await job(oldId)).toBeNull();
    expect(await storage().stat(storageKeys.editorExport(oldId))).toBeNull();
    expect(await job(recentId)).not.toBeNull();
    expect(await job(runningId)).not.toBeNull();
  });

  it("sweeps day-old work dirs that no running job owns", async () => {
    const now = new Date(Date.now() + 2 * DAY);
    const runningId = await finished("process_task", "running");
    for (const name of ["stale", runningId]) await writeFile(path.join(paths.workRoot, name, "tmp", "x"));
    await writeFile(path.join(paths.workRoot, "fresh", "x"));
    await fs.utimes(path.join(paths.workRoot, "fresh"), now, now);

    expect(await sweepWorkDirs(now)).toBe(1);
    expect(await exists(path.join(paths.workRoot, "stale"))).toBe(false);
    expect(await exists(path.join(paths.workRoot, runningId))).toBe(true);
    expect(await exists(path.join(paths.workRoot, "fresh"))).toBe(true);
  });

  it("deletes day-old YouTube downloads no task uses, keeping their word timings", async () => {
    const now = new Date(Date.now() + 2 * DAY);
    for (const id of ["usedvideo01", "usedbyurl02", "orphanvid03"]) {
      await writeFile(await storage().localPath(storageKeys.youtubeSource(id)));
      await writeFile(await storage().localPath(storageKeys.youtubeTranscript(id)), "{}");
    }
    await seedTask({ source: { type: "youtube", url: "https://youtu.be/usedvideo01", title: "A", videoId: "usedvideo01" } });
    await seedTask({ source: { type: "youtube", url: "https://www.youtube.com/watch?v=usedbyurl02", title: "B" } });

    expect(await sweepYoutubeSources(now)).toBe(1);
    expect(await storage().stat(storageKeys.youtubeSource("orphanvid03"))).toBeNull();
    expect(await storage().stat(storageKeys.youtubeTranscript("orphanvid03"))).not.toBeNull();
    expect(await storage().stat(storageKeys.youtubeSource("usedvideo01"))).not.toBeNull();
    expect(await storage().stat(storageKeys.youtubeSource("usedbyurl02"))).not.toBeNull();
    await runCron(now); // every step together, without throwing
  });

  it("deletes day-old uploads no task uses, with their word timings", async () => {
    const now = new Date(Date.now() + 2 * DAY);
    const url = (n: number) => `upload://00000000-0000-4000-8000-00000000000${n}.mp4`;
    const keys = (n: number) => uploadKeys(url(n))!;
    for (const n of [1, 2, 3]) {
      await writeFile(await storage().localPath(keys(n).video));
      await writeFile(await storage().localPath(keys(n).transcript), "{}");
    }
    await fs.utimes(await storage().localPath(keys(3).video), now, now); // uploaded just now
    await seedTask({ source: { type: "upload", url: url(1), title: "Used" } });

    expect(await sweepUploads(now)).toBe(1);
    expect(await storage().stat(keys(2).video)).toBeNull();
    expect(await storage().stat(keys(2).transcript)).toBeNull();
    for (const key of [keys(1).video, keys(1).transcript, keys(3).video]) expect(await storage().stat(key)).not.toBeNull();
  });
});

describe("failure hooks (reaper)", () => {
  async function died(type: JobType, taskFields: Parameters<typeof seedTask>[0] = {}, clipId?: string, payload?: Record<string, unknown>) {
    const jobId = `${type.length}`.padStart(32, "9");
    const task = await seedTask({ status: "processing", run: { jobId }, ...taskFields });
    const dead = await claimed({ id: jobId, type, taskId: task._id, userId: task.userId, clipId, payload });
    await collections().jobs.updateOne({ _id: jobId }, { $set: { attempts: dead.maxAttempts, lockedUntil: new Date(Date.now() - 1000) } });
    expect(await reapExpiredJobs()).toBe(1);
    return { task, jobId };
  }
  const taskOf = (id: string) => collections().tasks.findOne({ _id: id });

  it("puts a dead process_task's task in error", async () => {
    const { task, jobId } = await died("process_task");
    expect((await taskOf(task._id))!).toMatchObject({ status: "error", progress: 0, progressMessage: WORKER_STOPPED_TASK_MESSAGE });
    expect((await job(jobId))!).toMatchObject({ status: "failed", error: WORKER_STOPPED_ERROR });
  });

  it("leaves a task alone when it already belongs to a newer run", async () => {
    const { task } = await died("process_task", { status: "queued", run: { jobId: "1".repeat(32) } });
    expect((await taskOf(task._id))!.status).toBe("queued");
  });

  it("restores a dead restyle's task to completed with its old clips and their settings", async () => {
    const previousSettings = { ...settingsFromCreateRequest({}), captionTemplate: "neon" };
    const { task } = await died("restyle_task", { progressMessage: "Applying new style..." }, undefined, { previousSettings });
    const after = (await taskOf(task._id))!;
    expect(after).toMatchObject({ status: "completed", progress: 100, progressMessage: RESTYLE_FAILED_MESSAGE });
    expect(after.settings).toEqual(previousSettings);
  });

  it("fails a dead prepare's draft", async () => {
    const jobId = "7".repeat(32);
    await collections().clipDrafts.insertOne({
      _id: "c1", taskId: "t", userId: "u", basis: "c1.mp4", status: "preparing", jobId, revision: 0, createdAt: new Date(), updatedAt: new Date(),
    });
    const dead = await claimed({ id: jobId, type: "prepare_editor", taskId: "t", userId: "u", clipId: "c1" });
    await collections().jobs.updateOne({ _id: dead._id }, { $set: { attempts: 2, lockedUntil: new Date(Date.now() - 1000) } });
    await reapExpiredJobs();
    expect((await collections().clipDrafts.findOne({ _id: "c1" }))!).toMatchObject({ status: "failed", error: PREPARE_FAILED_MESSAGE });
  });

  it("gives a dead preset export the message the task page shows", async () => {
    const { jobId } = await died("export_clip", { status: "completed" }, "c1");
    expect((await job(jobId))!).toMatchObject({ status: "failed", error: EXPORT_STOPPED_MESSAGE });
  });
});

describe("shutdown", () => {
  it("hands a running job back to the queue without spending an attempt", async () => {
    const jobId = "5".repeat(32);
    const task = await seedTask({ run: { jobId } });
    await writeFile(await storage().localPath("uploads/00000000-0000-4000-8000-000000000001.mp4"));
    const claimedJob = await claimed({ id: jobId, type: "process_task", taskId: task._id, userId: task.userId, activeKey: `task:${task._id}` });
    const shutdown = new AbortController();
    const engine = fakeEngine({
      "prepare-source": async (_request, { signal }) => {
        shutdown.abort();
        await untilAborted(signal);
      },
      "render-clips": fakeRender(),
    });
    expect(await runJob(claimedJob, { runEngine: engine.runEngine }, shutdown.signal)).toBeNull();

    expect((await job(jobId))!).toMatchObject({ status: "queued", attempts: 0, activeKey: `task:${task._id}` });
    expect((await job(jobId))!.lockedBy).toBeUndefined();
    // The task waits for the next worker, still in this run.
    expect((await taskOf(task._id))!).toMatchObject({ status: "processing", run: { jobId } });
    expect(await finishJob(claimedJob, { status: "succeeded" })).toBe(false);
  });

  const taskOf = (id: string) => collections().tasks.findOne({ _id: id });
});

describe("lost lease", () => {
  const VIDEO_KEY = "uploads/00000000-0000-4000-8000-000000000001.mp4";
  async function running(jobId: string) {
    const task = await seedTask({ run: { jobId } });
    await writeFile(await storage().localPath(VIDEO_KEY));
    const lease = await claimed({ id: jobId, type: "process_task", taskId: task._id, userId: task.userId, activeKey: `task:${task._id}` });
    return { task, lease };
  }
  /** A prepare-source that runs `whileRunning`, then hangs until the job stops. */
  const hangingEngine = (whileRunning: () => Promise<void> = async () => {}) =>
    fakeEngine({
      "prepare-source": async (_request, { signal }) => {
        await whileRunning();
        await untilAborted(signal);
      },
    });

  it("leaves a re-claimed job, its task and the new attempt's files to the new holder", async () => {
    const jobId = "6".repeat(32);
    const { task, lease } = await running(jobId);
    let fresh!: JobDoc;
    let marker = "";
    let ctx!: Awaited<ReturnType<typeof createJobContext>>;
    // Before the stale attempt's next beat: its lease lapses (a sleeping laptop), another slot re-claims the job.
    const engine = hangingEngine(async () => {
      await collections().jobs.updateOne({ _id: jobId }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });
      await reapExpiredJobs();
      fresh = (await claimJob("worker-b"))!;
      ctx = await createJobContext(fresh);
      marker = await writeFile(path.join(ctx.workDir, "tmp", "normalizing.mp4"));
    });

    expect(await runJob(lease, { runEngine: engine.runEngine, heartbeatMs: 500 })).toBeNull();
    ctx.dispose();
    const staleDir = engine.calls[0].request.work_dir as string;
    expect(ctx.workDir).not.toBe(staleDir);
    expect(await exists(staleDir)).toBe(false);
    expect(await exists(marker)).toBe(true);
    expect((await job(jobId))!).toMatchObject({ status: "running", lockedBy: fresh.lockedBy, attempts: 2 });
    // No failure hook ran: the task is still in the run.
    expect((await collections().tasks.findOne({ _id: task._id }))!).toMatchObject({ status: "processing", run: { jobId } });
  });

  it("stops on its own when no heartbeat got through for most of the lease", async () => {
    const jobId = "7".repeat(32);
    const { lease } = await running(jobId);
    const findOneAndUpdate = Collection.prototype.findOneAndUpdate;
    let failedBeats = 0;
    // Every heartbeat fails (a Mongo outage for the jobs collection).
    vi.spyOn(Collection.prototype, "findOneAndUpdate").mockImplementation(function (this: Collection, ...args: unknown[]) {
      if (this.collectionName !== "jobs") return findOneAndUpdate.apply(this, args as never);
      failedBeats++;
      return Promise.reject(new Error("connection reset"));
    } as never);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A lease that lapses in 200 ms unless a beat renews it.
      const outcome = await runJob({ ...lease, lockedUntil: new Date(Date.now() + 200) }, { runEngine: hangingEngine().runEngine, heartbeatMs: 20 });
      expect(outcome).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
    expect(failedBeats).toBeGreaterThan(0);
    expect((await job(jobId))!).toMatchObject({ status: "running", lockedBy: lease.lockedBy });
  });
});

describe("YouTube auto-post cron (design §4.4, §4.5, §4.6)", () => {
  const USER = "yt-user";

  function accountDoc(overrides: Partial<YoutubeAccountDoc> = {}): YoutubeAccountDoc {
    const now = new Date();
    return {
      _id: USER,
      channelId: "UC1",
      channelTitle: "Mine",
      refreshToken: encryptSetting("refresh-1"),
      accessToken: encryptSetting("access-1"),
      accessTokenExpiresAt: new Date(now.getTime() + 60 * MINUTE),
      scopes: [],
      status: "active",
      autoPost: true,
      privacy: "public",
      madeForKids: false,
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }
  const seedAccount = (overrides: Partial<YoutubeAccountDoc> = {}) => collections().youtubeAccounts.insertOne(accountDoc(overrides));

  function postDoc(overrides: Partial<YoutubePostDoc> = {}): YoutubePostDoc {
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
  const seedPost = (overrides: Partial<YoutubePostDoc> = {}) => collections().youtubePosts.insertOne(postDoc(overrides));
  const storedPost = async (id: string) => (await collections().youtubePosts.findOne({ _id: id }))!;

  /** A fake `videos.list?part=status` answering only the ids in `responses`; others come back absent (deleted). */
  function videoStatusFetch(responses: Record<string, { privacyStatus: string; uploadStatus: string; rejectionReason?: string }>) {
    return (async (input: string | URL) => {
      const ids = (new URL(String(input)).searchParams.get("id") ?? "").split(",").filter(Boolean);
      const items = ids.filter((id) => responses[id]).map((id) => ({ id, status: responses[id] }));
      return new Response(JSON.stringify({ items }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  }

  it("dispatches only due queued posts", async () => {
    const now = new Date();
    await seedPost({ _id: "due", lineageId: "c1", notBefore: new Date(now.getTime() - MINUTE) });
    await seedPost({ _id: "no-wait", lineageId: "c2" }); // no notBefore at all: always due
    await seedPost({ _id: "future", lineageId: "c3", notBefore: new Date(now.getTime() + MINUTE) });
    await seedPost({ _id: "working", lineageId: "c4", state: "working", claimedBy: "job0" });

    expect(await dispatchDuePosts(now)).toBe(2);

    const jobs = await collections()
      .jobs.find({ type: "publish_youtube" })
      .toArray();
    expect(jobs.map((j) => j.payload.postId).sort()).toEqual(["due", "no-wait"]);
  });

  it("releases a working post whose job is no longer queued or running, as its failure hook would have", async () => {
    const jobIn = async (postId: string, status: JobDoc["status"]) => {
      const { job: queued } = await enqueueJob({ type: "publish_youtube", taskId: "t1", userId: USER, activeKey: `youtube:${postId}`, payload: { postId } });
      await collections().jobs.updateOne({ _id: queued._id }, { $set: { status } });
      return queued._id;
    };
    await seedPost({ _id: "failed-job", lineageId: "c1", state: "working", claimedBy: await jobIn("failed-job", "failed"), phase: "uploading" });
    await seedPost({ _id: "running-job", lineageId: "c2", state: "working", claimedBy: await jobIn("running-job", "running") });
    await seedPost({ _id: "requeued-job", lineageId: "c3", state: "working", claimedBy: await jobIn("requeued-job", "queued") });
    await seedPost({ _id: "deleted-job", lineageId: "c4", state: "working", claimedBy: "0".repeat(32) });
    await seedPost({ _id: "last-attempt", lineageId: "c5", state: "working", claimedBy: "f".repeat(32), attempts: 3 });
    const before = Date.now();

    expect(await releaseOrphanedPosts()).toBe(3);

    for (const id of ["failed-job", "deleted-job"]) {
      const released = await storedPost(id);
      expect(released).toMatchObject({ state: "queued", waitReason: "retry", attempts: 1, error: "The upload stopped unexpectedly." });
      expect(released.claimedBy).toBeUndefined();
      expect(released.phase).toBeUndefined();
      expect(released.notBefore!.getTime()).toBeGreaterThanOrEqual(before + 2 * MINUTE);
    }
    expect(await storedPost("last-attempt")).toMatchObject({ state: "failed", error: "The upload stopped unexpectedly." });
    for (const id of ["running-job", "requeued-job"]) expect((await storedPost(id)).state).toBe("working");
  });

  it("does not count a due post whose job already exists", async () => {
    const now = new Date();
    await seedPost({ _id: "due", lineageId: "c1" });
    // Already enqueued by an earlier pass: the activeKey E11000 makes a second dispatch a no-op.
    await enqueueJob({ type: "publish_youtube", taskId: "t1", userId: USER, activeKey: "youtube:due", payload: { postId: "due" } });

    expect(await dispatchDuePosts(now)).toBe(0);
    expect(await collections().jobs.countDocuments({ type: "publish_youtube" })).toBe(1);
  });

  it("re-creates posts for a task stuck in autopost pending", async () => {
    const now = new Date();
    await seedAccount();
    const taskFields = {
      userId: USER,
      status: "completed" as const,
      progress: 100,
      progressMessage: "Complete!",
      source: { type: "upload" as const, url: "upload://00000000-0000-4000-8000-000000000001.mp4", title: "Talk" },
      settings: settingsFromCreateRequest({}),
      autopost: "pending" as const,
      createdAt: now,
    };
    await collections().tasks.insertOne({ ...taskFields, _id: "stuck", clips: [clipFixture("c1", "stuck")], updatedAt: new Date(now.getTime() - 3 * MINUTE) });
    await collections().tasks.insertOne({ ...taskFields, _id: "fresh", clips: [clipFixture("c2", "fresh")], updatedAt: now });

    expect(await resumePendingAutopost(now)).toBe(1);

    expect((await collections().tasks.findOne({ _id: "stuck" }))!.autopost).toBe("done");
    expect(await collections().youtubePosts.countDocuments({ taskId: "stuck" })).toBe(1);
    // Not stuck long enough yet: left alone for the next run.
    expect((await collections().tasks.findOne({ _id: "fresh" }))!.autopost).toBe("pending");
    expect(await collections().youtubePosts.countDocuments({ taskId: "fresh" })).toBe(0);
  });

  it("refreshes stale view/like/comment counts of posted videos", async () => {
    const now = new Date();
    await seedAccount();
    const uploaded = { state: "uploaded" as const, uploadStatus: "processed", uploadedAt: new Date(now.getTime() - 3 * DAY) };
    await seedPost({ _id: "stale", lineageId: "c1", ...uploaded, videoId: "V1", stats: { views: 1, likes: 0, comments: 0, at: new Date(now.getTime() - 2 * 60 * MINUTE) } });
    await seedPost({ _id: "fresh", lineageId: "c2", ...uploaded, videoId: "V2", stats: { views: 5, likes: 1, comments: 1, at: new Date(now.getTime() - MINUTE) } });
    await seedPost({ _id: "gone", lineageId: "c3", ...uploaded, videoId: "V3", uploadStatus: "deleted" });
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      requested.push(...(new URL(String(input)).searchParams.get("id") ?? "").split(","));
      const items = [{ id: "V1", status: { privacyStatus: "public", uploadStatus: "processed" }, statistics: { viewCount: "900", likeCount: "12" } }];
      return new Response(JSON.stringify({ items }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    expect(await refreshVideoStats(now, fetchImpl)).toBe(1);

    expect(requested).toEqual(["V1"]);
    expect((await storedPost("stale")).stats).toEqual({ views: 900, likes: 12, comments: null, at: now });
    expect((await storedPost("fresh")).stats!.views).toBe(5);
  });

  it("verification records processed videos and trips the breaker on private", async () => {
    const now = new Date();
    await seedAccount();
    await seedPost({
      _id: "p1",
      state: "uploaded",
      videoId: "VID1",
      videoUrl: "https://www.youtube.com/watch?v=VID1",
      privacyStatus: "public",
      uploadStatus: "uploaded",
      uploadedAt: new Date(now.getTime() - 20 * MINUTE),
    });
    // A second, still-queued post of the same user: the breaker must hold it too.
    await seedPost({ _id: "p2", lineageId: "c2", state: "queued" });

    const fetchImpl = videoStatusFetch({ VID1: { privacyStatus: "private", uploadStatus: "processed" } });
    expect(await verifyUploads(now, fetchImpl)).toBe(1);

    const p1 = await storedPost("p1");
    // post.warning is a code, never an English sentence: the UI maps it to copy in messages/en.
    expect(p1).toMatchObject({ state: "uploaded", privacyStatus: "private", uploadStatus: "processed", warning: "private_lock" });
    expect(p1.verifiedAt).toBeInstanceOf(Date);
    expect(await collections().youtubeAccounts.findOne({ _id: USER })).toMatchObject({ status: "paused", warning: "private_lock" });
    expect(await storedPost("p2")).toMatchObject({ state: "blocked", waitReason: "private_lock" });
  });

  it("does not re-trip the breaker on a video already known to be locked", async () => {
    const now = new Date();
    await seedAccount(); // active: the user has pressed "Resume posting" since the first trip.
    await seedPost({
      _id: "p1",
      state: "uploaded",
      videoId: "VID1",
      videoUrl: "https://www.youtube.com/watch?v=VID1",
      privacy: "public",
      privacyStatus: "private", // already stored locked, from task 8's markUploaded.
      uploadStatus: "uploaded",
      uploadedAt: new Date(now.getTime() - 20 * MINUTE),
    });
    // A sibling the user just released by resuming: must stay queued, not re-blocked.
    await seedPost({ _id: "p2", lineageId: "c2", state: "queued" });

    const fetchImpl = videoStatusFetch({ VID1: { privacyStatus: "private", uploadStatus: "processed" } });
    expect(await verifyUploads(now, fetchImpl)).toBe(1);

    const p1 = await storedPost("p1");
    expect(p1).toMatchObject({ state: "uploaded", privacyStatus: "private", uploadStatus: "processed", warning: "private_lock" });
    expect(p1.verifiedAt).toBeInstanceOf(Date);
    expect(await collections().youtubeAccounts.findOne({ _id: USER })).toMatchObject({ status: "active" });
    expect(await storedPost("p2")).toMatchObject({ state: "queued" });
  });

  it("verification skips posts from a previous channel", async () => {
    const now = new Date();
    await seedAccount({ channelId: "UC-NEW" });
    await seedPost({
      _id: "old-channel",
      channelId: "UC-OLD",
      state: "uploaded",
      videoId: "VIDOLD",
      uploadedAt: new Date(now.getTime() - 20 * MINUTE),
    });
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new Error("must not be called");
    }) as typeof fetch;

    expect(await verifyUploads(now, fetchImpl)).toBe(0);
    expect(called).toBe(false);
    expect((await storedPost("old-channel")).verifiedAt).toBeUndefined();
  });

  it("does not verify for an account that needs a reconnect", async () => {
    const now = new Date();
    // Expired token, dead refresh token: every pass would hit the token endpoint for 48 h.
    await seedAccount({ status: "reauth_required", accessTokenExpiresAt: new Date(now.getTime() - MINUTE) });
    await seedPost({ _id: "p1", state: "uploaded", videoId: "VID1", uploadedAt: new Date(now.getTime() - 20 * MINUTE) });
    const fetchImpl = vi.fn(async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;

    expect(await verifyUploads(now, fetchImpl)).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await storedPost("p1")).verifiedAt).toBeUndefined();
  });

  it("clears a stale warning once the video matches the requested privacy and has no rejection", async () => {
    const now = new Date();
    await seedAccount();
    // Pass 1 saw the video private while it processed; the user has made it public again since.
    await seedPost({ _id: "p1", state: "uploaded", videoId: "VID1", privacyStatus: "private", warning: "private_lock", uploadedAt: new Date(now.getTime() - 20 * MINUTE) });
    const fetchImpl = videoStatusFetch({ VID1: { privacyStatus: "public", uploadStatus: "processed" } });

    expect(await verifyUploads(now, fetchImpl)).toBe(1);

    const p1 = await storedPost("p1");
    expect(p1).toMatchObject({ privacyStatus: "public", uploadStatus: "processed" });
    expect(p1.warning).toBeUndefined();
  });

  it("stores a video missing from videos.list as deleted and finalizes it", async () => {
    const now = new Date();
    await seedAccount();
    await seedPost({ _id: "p1", state: "uploaded", videoId: "VIDGONE", uploadedAt: new Date(now.getTime() - 20 * MINUTE) });
    const fetchImpl = videoStatusFetch({}); // VIDGONE absent from the response: gone from YouTube.

    expect(await verifyUploads(now, fetchImpl)).toBe(1);

    const p1 = await storedPost("p1");
    expect(p1).toMatchObject({ uploadStatus: "deleted" });
    expect(p1.verifiedAt).toBeInstanceOf(Date);
  });

  it("leaves verifiedAt unset for a non-final uploadStatus", async () => {
    const now = new Date();
    await seedAccount();
    await seedPost({ _id: "p1", state: "uploaded", videoId: "VID1", uploadedAt: new Date(now.getTime() - 20 * MINUTE) });
    const fetchImpl = videoStatusFetch({ VID1: { privacyStatus: "public", uploadStatus: "uploaded" } });

    expect(await verifyUploads(now, fetchImpl)).toBe(0);

    const p1 = await storedPost("p1");
    expect(p1).toMatchObject({ uploadStatus: "uploaded", privacyStatus: "public" });
    expect(p1.verifiedAt).toBeUndefined();
  });

  it("stores a rejection reason as the post warning and finalizes it", async () => {
    const now = new Date();
    await seedAccount();
    await seedPost({ _id: "p1", state: "uploaded", videoId: "VID1", uploadedAt: new Date(now.getTime() - 20 * MINUTE) });
    const fetchImpl = videoStatusFetch({ VID1: { privacyStatus: "public", uploadStatus: "rejected", rejectionReason: "copyright" } });

    expect(await verifyUploads(now, fetchImpl)).toBe(1);

    const p1 = await storedPost("p1");
    expect(p1).toMatchObject({ uploadStatus: "rejected", warning: "copyright" });
    expect(p1.verifiedAt).toBeInstanceOf(Date);
  });

  it("checks only posts inside the 10 min / 48 h verification window", async () => {
    const now = new Date();
    const MIN_AGE = 10 * MINUTE;
    const MAX_AGE = 48 * 60 * MINUTE;
    await seedAccount();
    await seedPost({ _id: "too-fresh", lineageId: "c-fresh", videoId: "V-FRESH", state: "uploaded", uploadedAt: new Date(now.getTime() - (MIN_AGE - MINUTE)) });
    await seedPost({ _id: "min-edge", lineageId: "c-min", videoId: "V-MIN", state: "uploaded", uploadedAt: new Date(now.getTime() - MIN_AGE) });
    await seedPost({ _id: "max-edge", lineageId: "c-max", videoId: "V-MAX", state: "uploaded", uploadedAt: new Date(now.getTime() - MAX_AGE) });
    await seedPost({ _id: "too-old", lineageId: "c-old", videoId: "V-OLD", state: "uploaded", uploadedAt: new Date(now.getTime() - (MAX_AGE + MINUTE)) });
    const fetchImpl = videoStatusFetch({
      "V-FRESH": { privacyStatus: "public", uploadStatus: "processed" },
      "V-MIN": { privacyStatus: "public", uploadStatus: "processed" },
      "V-MAX": { privacyStatus: "public", uploadStatus: "processed" },
      "V-OLD": { privacyStatus: "public", uploadStatus: "processed" },
    });

    expect(await verifyUploads(now, fetchImpl)).toBe(2);

    expect((await storedPost("too-fresh")).verifiedAt).toBeUndefined();
    expect((await storedPost("min-edge")).verifiedAt).toBeInstanceOf(Date);
    expect((await storedPost("max-edge")).verifiedAt).toBeInstanceOf(Date);
    expect((await storedPost("too-old")).verifiedAt).toBeUndefined();
  });

  it("one user's fetch failure does not stop another user's verification", async () => {
    const now = new Date();
    const FAILING_USER = "yt-user-fails";
    await seedAccount();
    await seedAccount({ _id: FAILING_USER, channelId: "UC2" });
    await seedPost({ _id: "ok", lineageId: "c-ok", state: "uploaded", videoId: "VID-OK", uploadedAt: new Date(now.getTime() - 20 * MINUTE) });
    await seedPost({
      _id: "broken",
      lineageId: "c-broken",
      userId: FAILING_USER,
      channelId: "UC2",
      state: "uploaded",
      videoId: "VID-BROKEN",
      uploadedAt: new Date(now.getTime() - 20 * MINUTE),
    });
    const fetchImpl = (async (input: string | URL) => {
      if (String(input).includes("VID-BROKEN")) throw new Error("network down");
      return videoStatusFetch({ "VID-OK": { privacyStatus: "public", uploadStatus: "processed" } })(input);
    }) as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(await verifyUploads(now, fetchImpl)).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }

    expect((await storedPost("ok")).verifiedAt).toBeInstanceOf(Date);
    const broken = await storedPost("broken");
    expect(broken.state).toBe("uploaded");
    expect(broken.uploadStatus).toBeUndefined();
    expect(broken.verifiedAt).toBeUndefined();
  });
});
