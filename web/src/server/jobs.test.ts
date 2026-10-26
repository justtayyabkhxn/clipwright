/** @vitest-environment node */
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, collections, ensureIndexes } from "./db";
import { resetEnv } from "./env";
import {
  claimJob,
  enqueueJob,
  finishJob,
  heartbeatJob,
  LEASE_MS,
  newJobId,
  onJobFailure,
  reapExpiredJobs,
  releaseJob,
  requestCancel,
  WORKER_STOPPED_ERROR,
  workerHealthy,
  workerStatus,
  writeWorkerHeartbeat,
} from "./jobs";

let mongod: MongoMemoryServer;
const baseEnv = { ...process.env };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env = { ...baseEnv, MONGODB_URI: mongod.getUri(), MONGODB_DB: "jobs", BETTER_AUTH_SECRET: "s".repeat(32) };
  resetEnv();
  await ensureIndexes();
});

afterAll(async () => {
  await closeDb();
  await mongod.stop();
  process.env = baseEnv;
});

beforeEach(async () => {
  await collections().jobs.deleteMany({});
  await collections().workerStatus.deleteMany({});
});

const processJob = (taskId = "t1") =>
  enqueueJob({ type: "process_task", taskId, userId: "u1", payload: { a: 1 }, activeKey: `task:${taskId}` });

async function expireLease(jobId: string) {
  await collections().jobs.updateOne({ _id: jobId }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });
}

describe("enqueue", () => {
  it("inserts queued jobs with type defaults", async () => {
    const { job, created } = await processJob();
    expect(created).toBe(true);
    expect(job._id).toMatch(/^[a-f0-9]{32}$/);
    expect(await collections().jobs.findOne({ _id: job._id })).toMatchObject({
      type: "process_task",
      status: "queued",
      attempts: 0,
      maxAttempts: 2,
      progress: 0,
      activeKey: "task:t1",
      payload: { a: 1 },
    });
    expect((await enqueueJob({ type: "export_clip", taskId: "t", userId: "u" })).job.maxAttempts).toBe(1);
    expect(newJobId()).not.toBe(newJobId());
  });

  it("returns the holder when the activeKey is taken, and frees it once finished", async () => {
    const first = await processJob();
    const second = await processJob();
    expect(second.created).toBe(false);
    expect(second.job._id).toBe(first.job._id);
    expect(await collections().jobs.countDocuments()).toBe(1);

    const claimed = await claimJob("w1");
    await finishJob(claimed!, { status: "failed", error: "boom" });
    const third = await processJob();
    expect(third.created).toBe(true);
  });

  it("deduplicates exports by liveKey until one fails", async () => {
    const live = { type: "export_clip" as const, taskId: "t1", clipId: "c1", userId: "u1", liveKey: "c1:hash" };
    const first = await enqueueJob(live);
    expect((await enqueueJob(live)).job._id).toBe(first.job._id);

    const claimed = await claimJob("w1");
    await finishJob(claimed!, { status: "succeeded", result: { fileKey: "exports/x.mp4" } });
    const reused = await enqueueJob(live);
    expect(reused).toMatchObject({ created: false, job: { _id: first.job._id, status: "succeeded", progress: 100 } });

    await collections().jobs.updateOne({ _id: first.job._id }, { $unset: { liveKey: "" } });
    expect((await enqueueJob(live)).created).toBe(true);
  });
});

describe("claim, heartbeat and finish", () => {
  it("claims the oldest runnable job and leases it", async () => {
    const later = await enqueueJob({ type: "export_clip", taskId: "t", userId: "u", runAt: new Date(Date.now() - 1000) });
    const earliest = await enqueueJob({ type: "export_editor", taskId: "t", userId: "u", runAt: new Date(Date.now() - 5000) });
    await enqueueJob({ type: "export_editor", taskId: "t", userId: "u", runAt: new Date(Date.now() + 60_000) });

    const before = Date.now();
    const job = await claimJob("w1");
    expect(job).toMatchObject({ _id: earliest.job._id, status: "running", lockedBy: expect.stringMatching(/^w1:[0-9a-f]{8}$/), attempts: 1 });
    expect(job!.lockedUntil!.getTime()).toBeGreaterThanOrEqual(before + LEASE_MS - 50);
    expect((await claimJob("w2"))?._id).toBe(later.job._id);
    expect(await claimJob("w3")).toBeNull();
  });

  it("filters by type", async () => {
    await enqueueJob({ type: "export_clip", taskId: "t", userId: "u" });
    expect(await claimJob("w1", ["process_task"])).toBeNull();
    expect(await claimJob("w1", ["export_clip"])).not.toBeNull();
  });

  it("heartbeats renew the lease, carry progress and report cancellation", async () => {
    const { job } = await processJob();
    const lease = (await claimJob("w1"))!;
    await expireLease(job._id);
    expect(await heartbeatJob(lease, { progress: 30, message: "Generating transcript..." })).toEqual({
      cancelRequested: false,
    });
    const stored = await collections().jobs.findOne({ _id: job._id });
    expect(stored).toMatchObject({ progress: 30, message: "Generating transcript..." });
    expect(stored!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    expect(await requestCancel({ _id: job._id })).toEqual({ cancelled: 0, cancelling: 1 });
    expect(await heartbeatJob(lease)).toEqual({ cancelRequested: true });
    expect(await heartbeatJob({ _id: job._id, lockedBy: "w2:00000000" })).toBeNull();
  });

  it("only lets the lease holder finish", async () => {
    const { job } = await processJob();
    const lease = (await claimJob("w1"))!;
    expect(await finishJob({ _id: job._id, lockedBy: "intruder" }, { status: "succeeded" })).toBe(false);
    expect(await finishJob(lease, { status: "succeeded", result: { clips: 3 } })).toBe(true);
    const stored = await collections().jobs.findOne({ _id: job._id });
    expect(stored).toMatchObject({ status: "succeeded", progress: 100, result: { clips: 3 } });
    expect(stored).not.toHaveProperty("activeKey");
    expect(stored).not.toHaveProperty("lockedUntil");
    expect(stored!.finishedAt).toBeInstanceOf(Date);
    expect(await finishJob(lease, { status: "failed" })).toBe(false);
  });

  it("fences each claim, even when the same worker re-claims an expired job", async () => {
    const { job } = await processJob();
    const stale = (await claimJob("w1"))!;
    await expireLease(job._id);
    await reapExpiredJobs();
    const fresh = (await claimJob("w1"))!;
    expect(fresh.lockedBy).not.toBe(stale.lockedBy);
    expect(await heartbeatJob(stale)).toBeNull();
    expect(await finishJob(stale, { status: "succeeded" })).toBe(false);
    expect(await heartbeatJob(fresh)).toEqual({ cancelRequested: false });
    expect(await finishJob(fresh, { status: "succeeded" })).toBe(true);
  });
});

describe("release", () => {
  it("requeues a running job without spending an attempt, unless a cancel was requested", async () => {
    const { job } = await processJob("t1");
    const lease = (await claimJob("w1"))!;
    expect(await releaseJob(lease)).toBe(true);
    const released = await collections().jobs.findOne({ _id: job._id });
    expect(released).toMatchObject({ status: "queued", attempts: 0, activeKey: "task:t1" });
    expect(released).not.toHaveProperty("lockedBy");
    expect(await releaseJob(lease)).toBe(false);

    const again = (await claimJob("w1"))!;
    await requestCancel({ _id: job._id });
    expect(await releaseJob(again)).toBe(false);
    expect(await collections().jobs.findOne({ _id: job._id })).toMatchObject({ status: "running", attempts: 1 });
  });
});

describe("cancel", () => {
  it("cancels queued jobs at once and flags running ones", async () => {
    const running = await processJob("t1");
    await claimJob("w1");
    const queued = await processJob("t2");
    expect(await requestCancel({ taskId: { $in: ["t1", "t2"] } })).toEqual({ cancelled: 1, cancelling: 1 });
    expect(await collections().jobs.findOne({ _id: queued.job._id })).toMatchObject({ status: "cancelled" });
    expect(await collections().jobs.findOne({ _id: queued.job._id })).not.toHaveProperty("activeKey");
    expect(await collections().jobs.findOne({ _id: running.job._id })).toMatchObject({
      status: "running",
      cancelRequested: true,
    });
  });
});

describe("reaper", () => {
  it("requeues an expired lease while attempts remain, then fails it and runs the hook", async () => {
    const hook = vi.fn(async () => {});
    onJobFailure("process_task", hook);
    const { job } = await processJob();

    const first = (await claimJob("w1"))!;
    await expireLease(job._id);
    expect(await reapExpiredJobs()).toBe(0);
    expect(await collections().jobs.findOne({ _id: job._id })).toMatchObject({ status: "queued", attempts: 1 });
    expect(await finishJob(first, { status: "succeeded" })).toBe(false);

    await claimJob("w2");
    await expireLease(job._id);
    expect(await reapExpiredJobs()).toBe(1);
    const failed = await collections().jobs.findOne({ _id: job._id });
    expect(failed).toMatchObject({ status: "failed", error: WORKER_STOPPED_ERROR, attempts: 2 });
    expect(failed).not.toHaveProperty("activeKey");
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ _id: job._id, status: "failed", taskId: "t1" }));
    expect((await processJob()).created).toBe(true);
  });

  it("leaves live leases alone and does not retry a cancelled job", async () => {
    const hook = vi.fn(async () => {});
    onJobFailure("export_editor", hook);
    const live = await enqueueJob({ type: "export_editor", taskId: "t", userId: "u" });
    await claimJob("w1");
    expect(await reapExpiredJobs()).toBe(0);
    expect(await collections().jobs.findOne({ _id: live.job._id })).toMatchObject({ status: "running" });

    const cancelled = await processJob("t9");
    await claimJob("w1");
    await requestCancel({ _id: cancelled.job._id });
    await expireLease(cancelled.job._id);
    await reapExpiredJobs();
    expect(await collections().jobs.findOne({ _id: cancelled.job._id })).toMatchObject({ status: "cancelled" });
  });

  it("keeps reaping when a hook throws", async () => {
    onJobFailure("export_clip", async () => {
      throw new Error("hook broke");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { job } = await enqueueJob({ type: "export_clip", taskId: "t", userId: "u", liveKey: "c:h" });
    await claimJob("w1");
    await expireLease(job._id);
    expect(await reapExpiredJobs()).toBe(1);
    expect(await collections().jobs.findOne({ _id: job._id })).not.toHaveProperty("liveKey");
    spy.mockRestore();
  });
});

describe("worker heartbeat", () => {
  it("is healthy only with a recent heartbeat", async () => {
    expect(await workerStatus()).toEqual({ online: false, heartbeatAt: null });
    await writeWorkerHeartbeat({ workerId: "w1", startedAt: new Date(), version: "test" });
    expect(await workerHealthy()).toBe(true);
    expect(await collections().workerStatus.findOne({ _id: "worker" })).toMatchObject({ workerId: "w1", pid: process.pid });
    await collections().workerStatus.updateOne({ _id: "worker" }, { $set: { heartbeatAt: new Date(Date.now() - 31_000) } });
    expect(await workerHealthy()).toBe(false);
  });
});
