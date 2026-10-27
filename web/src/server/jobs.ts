import { randomUUID } from "node:crypto";
import { MongoServerError, type Filter, type UpdateFilter } from "mongodb";
import { collections } from "./db";
import type { JobDoc, JobType } from "./types";

export const LEASE_MS = 60_000;
export const HEARTBEAT_MS = 15_000;
export const WORKER_STALE_MS = 30_000;

export const MAX_ATTEMPTS: Record<JobType, number> = {
  process_task: 2,
  restyle_task: 2,
  prepare_editor: 2,
  export_editor: 1,
  combine_editor: 1,
  export_clip: 1,
  publish_youtube: 3,
};

export const EDITOR_JOB_TYPES: JobType[] = ["export_editor", "combine_editor"];

/** 32 lowercase hex characters; editor routes validate /^[a-f0-9]{32}$/. */
export function newJobId(): string {
  return randomUUID().replace(/-/g, "");
}

export type EnqueueInput = {
  type: JobType;
  taskId: string;
  userId: string;
  clipId?: string;
  payload?: Record<string, unknown>;
  /** process/restyle: "task:{taskId}"; prepare: "prepare:{clipId}". */
  activeKey?: string;
  /** export_clip: "{clipId}:{optionsHash}". */
  liveKey?: string;
  /** Pre-generated id, for callers that must write it elsewhere before the insert. */
  id?: string;
  runAt?: Date;
};

/**
 * Insert a job. When `activeKey` or `liveKey` is already held, nothing is inserted and the holder
 * is returned with `created: false` (process/restyle: already queued or running; exports: reuse it).
 */
export async function enqueueJob(input: EnqueueInput): Promise<{ job: JobDoc; created: boolean }> {
  const { jobs } = collections();
  for (let attempt = 0; ; attempt++) {
    const now = new Date();
    const job: JobDoc = {
      _id: input.id ?? newJobId(),
      type: input.type,
      taskId: input.taskId,
      userId: input.userId,
      payload: input.payload ?? {},
      status: "queued",
      runAt: input.runAt ?? now,
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS[input.type],
      progress: 0,
      createdAt: now,
      updatedAt: now,
      ...(input.clipId !== undefined && { clipId: input.clipId }),
      ...(input.activeKey !== undefined && { activeKey: input.activeKey }),
      ...(input.liveKey !== undefined && { liveKey: input.liveKey }),
    };
    try {
      await jobs.insertOne(job);
      return { job, created: true };
    } catch (error) {
      const key = duplicateKey(error);
      if (!key) throw error;
      const holder = await jobs.findOne({ [key]: input[key] } as Filter<JobDoc>);
      if (holder) return { job: holder, created: false };
      // The holder finished between the insert and the read; try once more.
      if (attempt > 0) throw error;
    }
  }
}

function duplicateKey(error: unknown): "activeKey" | "liveKey" | null {
  if (!(error instanceof MongoServerError) || error.code !== 11000) return null;
  const pattern = (error.keyPattern ?? {}) as Record<string, unknown>;
  if ("activeKey" in pattern) return "activeKey";
  if ("liveKey" in pattern) return "liveKey";
  return null;
}

/** The claimed job, as `claimJob` returned it: its `lockedBy` names this one claim. */
export type JobLease = Pick<JobDoc, "_id" | "lockedBy">;

/**
 * `lockedBy` is `{workerId}:{claim token}`, so a handler whose lease expired and was re-claimed,
 * even by another slot of the same worker, can no longer heartbeat or finish.
 */
export async function claimJob(workerId: string, types?: JobType[]): Promise<JobDoc | null> {
  const now = new Date();
  return collections().jobs.findOneAndUpdate(
    { status: "queued", runAt: { $lte: now }, ...(types && { type: { $in: types } }) },
    {
      $set: {
        status: "running",
        lockedBy: `${workerId}:${randomUUID().slice(0, 8)}`,
        lockedUntil: new Date(now.getTime() + LEASE_MS),
        startedAt: now,
        updatedAt: now,
      },
      $inc: { attempts: 1 },
    },
    { sort: { runAt: 1 }, returnDocument: "after" },
  );
}

/** Renew the lease (and write progress). Null means the lease is gone: stop without finishing. */
export async function heartbeatJob(
  lease: JobLease,
  update: { progress?: number; message?: string } = {},
): Promise<{ cancelRequested: boolean } | null> {
  const now = new Date();
  const live = await collections().jobs.findOneAndUpdate(
    { _id: lease._id, lockedBy: lease.lockedBy, status: "running" },
    {
      $set: {
        lockedUntil: new Date(now.getTime() + LEASE_MS),
        updatedAt: now,
        ...(update.progress !== undefined && { progress: update.progress }),
        ...(update.message !== undefined && { message: update.message }),
      },
    },
    { returnDocument: "after", projection: { cancelRequested: 1 } },
  );
  return live ? { cancelRequested: Boolean(live.cancelRequested) } : null;
}

export type JobOutcome = {
  status: "succeeded" | "failed" | "cancelled";
  result?: Record<string, unknown>;
  error?: string;
  message?: string;
  expiresAt?: Date;
};

/** Only the lease holder can finish a job. Returns false when the lease was lost. */
export async function finishJob(lease: JobLease, outcome: JobOutcome): Promise<boolean> {
  const now = new Date();
  const unset: Record<string, ""> = { activeKey: "", lockedUntil: "" };
  // A live export stays deduplicated only while it can still be served.
  if (outcome.status !== "succeeded") unset.liveKey = "";
  const update: UpdateFilter<JobDoc> = {
    $set: {
      status: outcome.status,
      finishedAt: now,
      updatedAt: now,
      ...(outcome.status === "succeeded" && { progress: 100 }),
      ...(outcome.result !== undefined && { result: outcome.result }),
      ...(outcome.error !== undefined && { error: outcome.error }),
      ...(outcome.message !== undefined && { message: outcome.message }),
      ...(outcome.expiresAt !== undefined && { expiresAt: outcome.expiresAt }),
    },
    $unset: unset,
  };
  const result = await collections().jobs.updateOne({ _id: lease._id, lockedBy: lease.lockedBy, status: "running" }, update);
  return result.matchedCount > 0;
}

/**
 * Worker shutdown: hand a running job back to the queue without spending an attempt. False when
 * the lease is gone or a cancel was requested (then the job must be finished, not requeued).
 */
export async function releaseJob(lease: JobLease): Promise<boolean> {
  const now = new Date();
  const result = await collections().jobs.updateOne(
    { _id: lease._id, lockedBy: lease.lockedBy, status: "running", cancelRequested: { $ne: true } },
    {
      $set: { status: "queued", runAt: now, updatedAt: now },
      $unset: { lockedBy: "", lockedUntil: "" },
      $inc: { attempts: -1 },
    },
  );
  return result.matchedCount > 0;
}

/** Queued jobs become cancelled at once; running ones get `cancelRequested` for their worker. */
export async function requestCancel(filter: Filter<JobDoc>): Promise<{ cancelled: number; cancelling: number }> {
  const { jobs } = collections();
  const now = new Date();
  const queued = await jobs.updateMany(
    { ...filter, status: "queued" },
    { $set: { status: "cancelled", finishedAt: now, updatedAt: now }, $unset: { activeKey: "", liveKey: "" } },
  );
  const running = await jobs.updateMany(
    { ...filter, status: "running" },
    { $set: { cancelRequested: true, updatedAt: now } },
  );
  return { cancelled: queued.modifiedCount, cancelling: running.matchedCount };
}

export type FailureHook = (job: JobDoc) => Promise<void>;

const failureHooks = new Map<JobType, FailureHook>();

/** The worker registers what happens to a task, draft or export when its job dies. */
export function onJobFailure(type: JobType, hook: FailureHook) {
  failureHooks.set(type, hook);
}

export const WORKER_STOPPED_ERROR = "The worker stopped before this job finished.";

/** Run on every poll: requeue expired leases with attempts left, fail the rest and run their hooks. */
export async function reapExpiredJobs(): Promise<number> {
  const { jobs } = collections();
  const now = new Date();
  const expired = { status: "running" as const, lockedUntil: { $lt: now } };
  await jobs.updateMany(
    { ...expired, cancelRequested: { $ne: true }, $expr: { $lt: ["$attempts", "$maxAttempts"] } },
    { $set: { status: "queued", runAt: now, updatedAt: now }, $unset: { lockedBy: "", lockedUntil: "" } },
  );
  const dead = await jobs.find(expired).toArray();
  let failed = 0;
  for (const job of dead) {
    const status = job.cancelRequested ? "cancelled" : "failed";
    const claimed = await jobs.findOneAndUpdate(
      { _id: job._id, ...expired },
      {
        $set: { status, error: job.error ?? WORKER_STOPPED_ERROR, finishedAt: now, updatedAt: now },
        $unset: { activeKey: "", liveKey: "", lockedBy: "", lockedUntil: "" },
      },
      { returnDocument: "after" },
    );
    if (!claimed) continue;
    failed++;
    try {
      await failureHooks.get(job.type)?.(claimed);
    } catch (error) {
      console.error(`[jobs] Failure hook for ${job.type} ${job._id} failed`, error);
    }
  }
  return failed;
}

export async function writeWorkerHeartbeat(worker: { workerId: string; startedAt: Date; version: string }) {
  await collections().workerStatus.updateOne(
    { _id: "worker" },
    { $set: { ...worker, pid: process.pid, heartbeatAt: new Date() } },
    { upsert: true },
  );
}

export async function workerStatus(): Promise<{ online: boolean; heartbeatAt: Date | null }> {
  const status = await collections().workerStatus.findOne({ _id: "worker" });
  const heartbeatAt = status?.heartbeatAt ?? null;
  return { online: Boolean(heartbeatAt && Date.now() - heartbeatAt.getTime() < WORKER_STALE_MS), heartbeatAt };
}

export async function workerHealthy(): Promise<boolean> {
  return (await workerStatus()).online;
}
