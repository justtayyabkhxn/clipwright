/** @vitest-environment node */
import fs from "node:fs/promises";
import path from "node:path";
import { Collection } from "mongodb";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { collections } from "../server/db";
import { PREPARE_FAILED_MESSAGE } from "../server/drafts";
import { paths } from "../server/env";
import { claimJob, enqueueJob, finishJob, reapExpiredJobs, WORKER_STOPPED_ERROR } from "../server/jobs";
import { getStorage, storageKeys, uploadKeys } from "../server/storage";
import { EXPORT_EXPIRED_MESSAGE, RESTYLE_FAILED_MESSAGE, settingsFromCreateRequest, WORKER_STOPPED_TASK_MESSAGE } from "../server/tasks";
import type { JobDoc, JobType } from "../server/types";
import { deleteOldJobs, expireExports, runCron, sweepUploads, sweepWorkDirs, sweepYoutubeSources } from "./cron";
import { EXPORT_STOPPED_MESSAGE } from "./handlers/export-clip";
import { createJobContext } from "./context";
import { registerFailureHooks, runJob } from "./run-job";
import { claimed, exists, fakeEngine, fakeRender, seedTask, untilAborted, setupWorkerTestEnv, writeFile } from "./test-utils";

setupWorkerTestEnv("cron", { env: { ANTHROPIC_API_KEY: "sk-ant-test", ASSEMBLY_AI_API_KEY: "aai" } });
beforeAll(() => registerFailureHooks());

const DAY = 24 * 60 * 60 * 1000;
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
