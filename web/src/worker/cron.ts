// Housekeeping, every 5 minutes in the worker (DESIGN §6.2 "Cron").

import fs from "node:fs/promises";
import path from "node:path";
import { collections } from "../server/db";
import { paths } from "../server/env";
import { getStorage, uploadKeys } from "../server/storage";
import { EXPORT_EXPIRED_MESSAGE, jobFileKey } from "../server/tasks";
import type { JobType } from "../server/types";

export const CRON_INTERVAL_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const JOB_RETENTION_MS = 7 * DAY_MS;
export const ORPHAN_GRACE_MS = DAY_MS;
const EXPORT_TYPES: JobType[] = ["export_clip", "export_editor", "combine_editor"];

/** Succeeded exports past `expiresAt` lose their file and become failed (the doc stays 7 more days). */
export async function expireExports(now = new Date()) {
  const { jobs } = collections();
  const expired = await jobs
    .find({ status: "succeeded", type: { $in: EXPORT_TYPES }, expiresAt: { $lt: now } }, { projection: { type: 1, result: 1 } })
    .toArray();
  for (const job of expired) {
    const key = jobFileKey(job);
    if (key) await getStorage().delete(key);
    await jobs.updateOne(
      { _id: job._id, status: "succeeded" },
      { $set: { status: "failed", error: EXPORT_EXPIRED_MESSAGE, updatedAt: now }, $unset: { liveKey: "" } },
    );
  }
  return expired.length;
}

/** Finished job docs untouched for 7 days go, with any output file they still own. */
export async function deleteOldJobs(now = new Date()) {
  const { jobs } = collections();
  const old = await jobs
    .find(
      { status: { $in: ["succeeded", "failed", "cancelled"] }, updatedAt: { $lt: new Date(now.getTime() - JOB_RETENTION_MS) } },
      { projection: { type: 1, result: 1 } },
    )
    .toArray();
  for (const job of old) {
    const key = jobFileKey(job);
    if (key) await getStorage().delete(key);
    await jobs.deleteOne({ _id: job._id });
  }
  return old.length;
}

/** DATA_DIR/work/{jobId} dirs left by a crashed job, once a day old and not a running job's. */
export async function sweepWorkDirs(now = new Date()) {
  let entries;
  try {
    entries = await fs.readdir(paths.workRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const running = new Set(
    (await collections().jobs.find({ status: "running" }, { projection: { _id: 1 } }).toArray()).map((job) => job._id),
  );
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || running.has(entry.name)) continue;
    const dir = path.join(paths.workRoot, entry.name);
    const info = await fs.stat(dir).catch(() => null);
    if (!info || now.getTime() - info.mtimeMs <= ORPHAN_GRACE_MS) continue;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
    removed++;
  }
  return removed;
}

/** Downloaded YouTube videos no task uses any more. Their word timings are paid for and stay. */
export async function sweepYoutubeSources(now = new Date()) {
  const storage = getStorage();
  let removed = 0;
  for (const item of await storage.list("sources/youtube/")) {
    const [, , videoId, name] = item.key.split("/");
    if (name !== "source.mp4" || now.getTime() - item.mtimeMs <= ORPHAN_GRACE_MS) continue;
    // The URL match covers tasks saved without a videoId.
    const pattern = videoId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const used = await collections().tasks.findOne(
      { "source.type": "youtube", $or: [{ "source.videoId": videoId }, { "source.url": { $regex: pattern } }] },
      { projection: { _id: 1 } },
    );
    if (used) continue;
    await storage.delete(item.key);
    removed++;
  }
  return removed;
}

/** Uploaded videos no task uses (never submitted, or every task using it is gone), with their word timings. */
export async function sweepUploads(now = new Date()) {
  const storage = getStorage();
  let removed = 0;
  for (const item of await storage.list("uploads/")) {
    const url = `upload://${item.key.slice("uploads/".length)}`;
    const keys = uploadKeys(url); // null for the .transcript_cache.json sidecars: they go with their video
    if (!keys || now.getTime() - item.mtimeMs <= ORPHAN_GRACE_MS) continue;
    if (await collections().tasks.findOne({ "source.url": url }, { projection: { _id: 1 } })) continue;
    await storage.delete(keys.video);
    await storage.delete(keys.transcript);
    removed++;
  }
  return removed;
}

export async function runCron(now = new Date()) {
  for (const [name, step] of [
    ["expire exports", expireExports],
    ["delete old jobs", deleteOldJobs],
    ["sweep work dirs", sweepWorkDirs],
    ["sweep YouTube sources", sweepYoutubeSources],
    ["sweep uploads", sweepUploads],
  ] as const) {
    try {
      await step(now);
    } catch (error) {
      console.error(`[cron] ${name} failed`, error);
    }
  }
}
