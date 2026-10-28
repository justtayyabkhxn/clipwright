// Housekeeping, every 5 minutes in the worker (DESIGN §6.2 "Cron").

import fs from "node:fs/promises";
import path from "node:path";
import { collections } from "../server/db";
import { paths } from "../server/env";
import { getStorage, uploadKeys } from "../server/storage";
import { EXPORT_EXPIRED_MESSAGE, jobFileKey } from "../server/tasks";
import type { JobType, YoutubePostDoc } from "../server/types";
import { getAccessToken, getAccount } from "../server/youtube/accounts";
import { listVideoStatus } from "../server/youtube/google";
import { createPostsForTask, enqueueQueued, tripPrivateLock } from "../server/youtube/posts";

export const CRON_INTERVAL_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
export const JOB_RETENTION_MS = 7 * DAY_MS;
export const ORPHAN_GRACE_MS = DAY_MS;
const EXPORT_TYPES: JobType[] = ["export_clip", "export_editor", "combine_editor"];

/** §4.4 step 4: how long a task may sit "pending" before the cron assumes the trigger crashed. */
const RESUME_AUTOPOST_DELAY_MS = 2 * MINUTE_MS;
/** §4.6: a video is checked only once it has had time to finish processing, and only within YouTube's own window. */
const VERIFY_MIN_AGE_MS = 10 * MINUTE_MS;
const VERIFY_MAX_AGE_MS = 48 * 60 * MINUTE_MS;
const FINAL_UPLOAD_STATUSES = new Set(["processed", "rejected", "failed", "deleted"]);
const FORCED_PRIVATE_WARNING = "YouTube made this video private";

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

// --- YouTube auto-post (design §4.4, §4.5, §4.6) ---

/** §4.5: enqueue every `queued` post whose `notBefore` has passed or is absent (a deferred handler only sets `notBefore`). */
export async function dispatchDuePosts(now = new Date()): Promise<number> {
  return enqueueQueued({}, now);
}

/** §4.4 step 4: re-run `createPostsForTask` for a task left "pending" by a crash between the completion CAS and the enqueue. */
export async function resumePendingAutopost(now = new Date()): Promise<number> {
  const stuck = await collections()
    .tasks.find(
      { autopost: "pending", updatedAt: { $lt: new Date(now.getTime() - RESUME_AUTOPOST_DELAY_MS) } },
      { projection: { _id: 1 } },
    )
    .toArray();
  let resumed = 0;
  for (const task of stuck) {
    try {
      await createPostsForTask(task._id);
      resumed++;
    } catch (error) {
      console.error(`[cron] resuming autopost for task ${task._id} failed`, error);
    }
  }
  return resumed;
}

/**
 * §4.6: re-read each due `uploaded` post's video status, store it, and finalize once it is
 * `processed`, `rejected`, `failed` or (absent from the list) `deleted`. Grouped per user so one
 * user's account or network failure never stops another's. Trips the §4.6 circuit breaker the first
 * time a video comes back with a privacy other than the one the post requested.
 */
export async function verifyUploads(now = new Date(), fetchImpl: typeof fetch = fetch): Promise<number> {
  const due = await collections()
    .youtubePosts.find({
      state: "uploaded",
      verifiedAt: { $exists: false },
      uploadedAt: { $lte: new Date(now.getTime() - VERIFY_MIN_AGE_MS), $gte: new Date(now.getTime() - VERIFY_MAX_AGE_MS) },
    })
    .toArray();
  if (!due.length) return 0;

  const byUser = new Map<string, YoutubePostDoc[]>();
  for (const post of due) byUser.set(post.userId, [...(byUser.get(post.userId) ?? []), post]);

  let verified = 0;
  for (const [userId, posts] of byUser) {
    try {
      verified += await verifyUserUploads(userId, posts, fetchImpl);
    } catch (error) {
      // Never log tokens: only the error's own message.
      console.error(`[cron] verifying YouTube uploads for user ${userId} failed: ${(error as Error).message}`);
    }
  }
  return verified;
}

/** One user's share of `verifyUploads`: one token, one `videos.list` call, posts on another channel left untouched. */
async function verifyUserUploads(userId: string, posts: YoutubePostDoc[], fetchImpl: typeof fetch): Promise<number> {
  const account = await getAccount(userId);
  if (!account) return 0;
  // A video on a channel that is no longer connected cannot be read with the current token (§4.6).
  const matching = posts.filter((post) => post.channelId === account.channelId && post.videoId);
  if (!matching.length) return 0;

  const accessToken = await getAccessToken(account, fetchImpl);
  const statuses = await listVideoStatus(accessToken, matching.map((post) => post.videoId!), fetchImpl);

  let verified = 0;
  for (const post of matching) {
    const status = statuses.get(post.videoId!);
    const updatedAt = new Date();
    const set: Partial<YoutubePostDoc> = { updatedAt };
    if (!status) {
      // Absent from the list: the video is gone from YouTube.
      set.uploadStatus = "deleted";
    } else {
      set.privacyStatus = status.privacyStatus;
      set.uploadStatus = status.uploadStatus;
      if (status.privacyStatus !== post.privacy) set.warning = FORCED_PRIVATE_WARNING;
      else if (status.rejectionReason) set.warning = status.rejectionReason;
    }
    if (FINAL_UPLOAD_STATUSES.has(set.uploadStatus!)) set.verifiedAt = updatedAt;

    const result = await collections()
      .youtubePosts.updateOne({ _id: post._id, state: "uploaded", verifiedAt: { $exists: false } }, { $set: set });
    if (!result.matchedCount) continue;
    if (set.warning === FORCED_PRIVATE_WARNING) await tripPrivateLock(userId);
    if (set.verifiedAt) verified++;
  }
  return verified;
}

export async function runCron(now = new Date()) {
  for (const [name, step] of [
    ["expire exports", expireExports],
    ["delete old jobs", deleteOldJobs],
    ["sweep work dirs", sweepWorkDirs],
    ["sweep YouTube sources", sweepYoutubeSources],
    ["sweep uploads", sweepUploads],
    ["dispatch due YouTube posts", dispatchDuePosts],
    ["resume pending YouTube autopost", resumePendingAutopost],
    ["verify YouTube uploads", verifyUploads],
  ] as const) {
    try {
      await step(now);
    } catch (error) {
      console.error(`[cron] ${name} failed`, error);
    }
  }
}
