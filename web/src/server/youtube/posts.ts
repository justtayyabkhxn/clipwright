// YouTube auto-post (design §4.2): a post belongs to a clip's lineage, not its id, so a restyle
// can never re-post a clip that already went out.
//
// The post repository. Every write is a single-document CAS or one `updateMany` (no transactions):
// - Transitions that take a `post` (defer/block/fail) are fenced on the caller's claim
//   (`state: "working"`, `claimedBy`), so a stale job can never overwrite a newer one's decision.
// - Writes that take a `postId` (session, metadata) and `markUploaded` are fenced only against
//   overwriting the final `uploaded` record: a saved session URI is what prevents a duplicate insert,
//   and a finished upload is a fact on YouTube, so neither may be lost to a claim race.
// - The private lock (§4.6) lives on the account as `warning: "private_lock"`; only `resumePosting`
//   releases it, never a reconnect.

import { randomUUID } from "node:crypto";
import { MongoBulkWriteError, type Filter, type UpdateFilter } from "mongodb";
import { collections } from "../db";
import { ApiError } from "../http";
import { enqueueJob } from "../jobs";
import type { ClipDoc, JobDoc, TaskDoc, YoutubeAccountDoc, YoutubePostDoc, YoutubeWaitReason } from "../types";
import { getAccount } from "./accounts";
import type { VideoResource } from "./google";

export function lineageOf(clip: Pick<ClipDoc, "id" | "lineageId">): string {
  return clip.lineageId ?? clip.id;
}

/** `videos.insert` session starts allowed per post before a manual retry (§4.5). */
export const INSERT_CAP = 3;
const PRIVATE_LOCK = "private_lock";
const CANCELLABLE: YoutubePostDoc["state"][] = ["queued", "blocked", "failed"];
/** Fields that only mean something while a job holds the post. */
const RELEASE = { claimedBy: "", phase: "", progress: "" } as const;

const due = (now: Date): Filter<YoutubePostDoc> => ({ $or: [{ notBefore: { $exists: false } }, { notBefore: { $lte: now } }] });
const held = (post: YoutubePostDoc): Filter<YoutubePostDoc> => ({ _id: post._id, state: "working", claimedBy: post.claimedBy });
const notUploaded = (postId: string): Filter<YoutubePostDoc> => ({ _id: postId, state: { $ne: "uploaded" } });

async function enqueuePost(post: Pick<YoutubePostDoc, "_id" | "taskId" | "userId">): Promise<JobDoc> {
  const { job } = await enqueueJob({
    type: "publish_youtube",
    taskId: post.taskId,
    userId: post.userId,
    activeKey: `youtube:${post._id}`,
    payload: { postId: post._id },
  });
  return job;
}

/** Enqueue every due `queued` post matching `filter` (an already-held activeKey is a no-op). */
async function enqueueQueued(filter: Filter<YoutubePostDoc>): Promise<void> {
  const posts = await collections()
    .youtubePosts.find({ ...filter, state: "queued", ...due(new Date()) })
    .toArray();
  for (const post of posts) await enqueuePost(post);
}

// --- Creation (§4.4) ---

/**
 * Create one post per non-fallback clip of a task whose completion set `autopost: "pending"`, enqueue
 * the queued ones in clip order, then set `autopost: "done"`. Safe to re-run after a crash at any
 * point: the unique `lineageId` turns a second insert into an ignored E11000, and enqueueing is
 * deduplicated by `activeKey`. Returns how many posts this call inserted.
 */
export async function createPostsForTask(taskId: string): Promise<number> {
  const { tasks, youtubePosts } = collections();
  const task = await tasks.findOne({ _id: taskId, autopost: "pending" });
  if (!task) return 0;
  const markDone = () => tasks.updateOne({ _id: taskId, autopost: "pending" }, { $set: { autopost: "done" } });

  const account = await getAccount(task.userId);
  if (!account?.autoPost) {
    await markDone();
    return 0;
  }

  const { state, waitReason } = initialState(account);
  const now = new Date();
  const docs: YoutubePostDoc[] = task.clips
    .filter((clip) => clip.hookType !== "fallback")
    .map((clip, index) => ({
      _id: randomUUID(),
      userId: task.userId,
      taskId,
      lineageId: lineageOf(clip),
      channelId: account.channelId,
      state,
      ...(waitReason && { waitReason }),
      attempts: 0,
      insertCalls: 0,
      insertCap: INSERT_CAP,
      privacy: account.privacy,
      madeForKids: account.madeForKids,
      notifySubscribers: index === 0,
      createdAt: now,
      updatedAt: now,
    }));

  let inserted = 0;
  if (docs.length) {
    try {
      inserted = (await youtubePosts.insertMany(docs, { ordered: false })).insertedCount;
    } catch (error) {
      // Only duplicate lineages are expected. The driver also wraps network and write-concern errors
      // in a MongoBulkWriteError with no write errors; those must fail the call, never mark it done.
      if (!(error instanceof MongoBulkWriteError)) throw error;
      const errs = [error.writeErrors].flat();
      if (!errs.length || !errs.every((e) => e.code === 11000)) throw error;
      inserted = error.insertedCount;
    }
    // Enqueue from the stored docs: after a crash the existing posts carry other ids than `docs`.
    const queued = await youtubePosts.find({ taskId, state: "queued", ...due(now) }).toArray();
    const byLineage = new Map(queued.map((post) => [post.lineageId, post]));
    for (const doc of docs) {
      const post = byLineage.get(doc.lineageId);
      if (post) await enqueuePost(post);
    }
  }
  await markDone();
  return inserted;
}

/** `queued` only for an active, unlocked account; the private lock wins over a needed reconnect. */
function initialState(account: YoutubeAccountDoc): Pick<YoutubePostDoc, "state" | "waitReason"> {
  if (account.warning === PRIVATE_LOCK) return { state: "blocked", waitReason: "private_lock" };
  if (account.status !== "active") return { state: "blocked", waitReason: "reconnect" };
  return { state: "queued" };
}

// --- Claim (§4.5) ---

/**
 * CAS `queued` (due) → `working` for this job. A `working` post already claimed by the same job id
 * is returned too: a released or reaped job re-runs with its id.
 */
export async function claimPost(postId: string, jobId: string): Promise<YoutubePostDoc | null> {
  const now = new Date();
  return collections().youtubePosts.findOneAndUpdate(
    { _id: postId, $or: [{ state: "queued", ...due(now) }, { state: "working", claimedBy: jobId }] },
    { $set: { state: "working", claimedBy: jobId, updatedAt: now }, $unset: { notBefore: "", waitReason: "" } },
    { returnDocument: "after" },
  );
}

// --- Transitions of a claimed post ---

/**
 * Back to `queued` until `until`. A `retry` deferral spends one of the automatic attempts. A given
 * `error` replaces the old one; the old `errorReason` is always dropped (it described another error).
 */
export async function deferPost(post: YoutubePostDoc, reason: YoutubeWaitReason, until: Date, error?: string): Promise<boolean> {
  const update: UpdateFilter<YoutubePostDoc> = {
    $set: { state: "queued", notBefore: until, waitReason: reason, updatedAt: new Date(), ...(error !== undefined && { error }) },
    $unset: { ...RELEASE, errorReason: "", ...(error === undefined && { error: "" }) },
    ...(reason === "retry" && { $inc: { attempts: 1 } }),
  };
  return (await collections().youtubePosts.updateOne(held(post), update)).matchedCount > 0;
}

export async function blockPost(post: YoutubePostDoc, reason: YoutubeWaitReason, message: string): Promise<boolean> {
  const result = await collections().youtubePosts.updateOne(held(post), {
    $set: { state: "blocked", waitReason: reason, error: message, updatedAt: new Date() },
    $unset: { ...RELEASE, notBefore: "", errorReason: "" },
  });
  return result.matchedCount > 0;
}

export async function failPost(post: YoutubePostDoc, message: string, errorReason?: string): Promise<boolean> {
  const result = await collections().youtubePosts.updateOne(held(post), {
    $set: { state: "failed", error: message, updatedAt: new Date(), ...(errorReason !== undefined && { errorReason }) },
    $unset: { ...RELEASE, notBefore: "", waitReason: "", ...(errorReason === undefined && { errorReason: "" }) },
  });
  return result.matchedCount > 0;
}

/**
 * Record a finished upload (final). The session is dropped. A privacy other than the one requested
 * means the forced-private lock: warn on the post and trip the circuit breaker (§4.5, §4.6).
 */
export async function markUploaded(post: YoutubePostDoc, video: VideoResource): Promise<boolean> {
  const now = new Date();
  const locked = video.status.privacyStatus !== post.privacy;
  const result = await collections().youtubePosts.updateOne(notUploaded(post._id), {
    $set: {
      state: "uploaded",
      videoId: video.id,
      videoUrl: `https://www.youtube.com/watch?v=${video.id}`,
      privacyStatus: video.status.privacyStatus,
      uploadStatus: video.status.uploadStatus,
      uploadedAt: now,
      updatedAt: now,
      ...(locked && { warning: PRIVATE_LOCK }),
    },
    $unset: { ...RELEASE, upload: "", notBefore: "", waitReason: "", error: "", errorReason: "" },
  });
  if (!result.matchedCount) return false; // already uploaded: nothing recorded, nothing to trip
  if (locked) await tripPrivateLock(post.userId);
  return true;
}

/** Save the resumable session right after initiation, so any later run queries it before a new insert. */
export async function saveSession(postId: string, upload: NonNullable<YoutubePostDoc["upload"]>): Promise<void> {
  await collections().youtubePosts.updateOne(notUploaded(postId), { $set: { upload, updatedAt: new Date() } });
}

export async function saveMetadata(postId: string, metadata: NonNullable<YoutubePostDoc["metadata"]>): Promise<void> {
  await collections().youtubePosts.updateOne(notUploaded(postId), { $set: { metadata, updatedAt: new Date() } });
}

export async function clearMetadata(postId: string): Promise<void> {
  await collections().youtubePosts.updateOne(notUploaded(postId), { $unset: { metadata: "" }, $set: { updatedAt: new Date() } });
}

// --- Cancelling (§4.3, §4.7) ---

const cancel = (error?: string): UpdateFilter<YoutubePostDoc> => ({
  $set: { state: "cancelled", updatedAt: new Date(), ...(error !== undefined && { error }) },
  $unset: { notBefore: "", waitReason: "", ...(error !== undefined && { errorReason: "" }) },
});

/**
 * Disconnect, auto-post off, or a different channel: `reason` becomes the posts' error.
 * `exceptChannelId` spares posts already queued for that channel — the callback passes the
 * newly-connected channel so a post the autopost trigger creates for it between
 * `saveConnectedAccount` and this call is never cancelled with the old channel's message (§4.3 step 6).
 */
export async function cancelPostsForUser(userId: string, reason: string, options?: { exceptChannelId?: string }): Promise<number> {
  const result = await collections().youtubePosts.updateMany(
    { userId, state: { $in: CANCELLABLE }, ...(options?.exceptChannelId !== undefined && { channelId: { $ne: options.exceptChannelId } }) },
    cancel(reason),
  );
  return result.modifiedCount;
}

/** Task delete: `working` > 0 means a clip is mid-upload and the delete must be refused (409). */
export async function cancelPostsForTask(taskId: string): Promise<{ cancelled: number; working: number }> {
  const { youtubePosts } = collections();
  const result = await youtubePosts.updateMany({ taskId, state: { $in: CANCELLABLE } }, cancel());
  return { cancelled: result.modifiedCount, working: await youtubePosts.countDocuments({ taskId, state: "working" }) };
}

/** Clip delete. The same post doc as `claimPost`'s CAS, so exactly one of the two wins. */
export async function cancelPostForLineage(taskId: string, lineageId: string): Promise<"cancelled" | "working" | "none"> {
  const { youtubePosts } = collections();
  const result = await youtubePosts.updateOne({ taskId, lineageId, state: { $in: CANCELLABLE } }, cancel());
  if (result.matchedCount) return "cancelled";
  const post = await youtubePosts.findOne({ taskId, lineageId }, { projection: { state: 1 } });
  return post?.state === "working" ? "working" : "none";
}

// --- Account-wide transitions ---

/**
 * After a reconnect: every blocked post except the private lock's goes back to the queue. The lock
 * wins, as in `createPostsForTask`: while the account still carries it (a reconnect keeps the pause),
 * those posts stay blocked, re-labelled `private_lock`, for `resumePosting` to release. Returns how
 * many posts were queued.
 */
export async function unblockAfterReconnect(userId: string): Promise<number> {
  const locked = (await getAccount(userId))?.warning === PRIVATE_LOCK;
  const now = new Date();
  const result = await collections().youtubePosts.updateMany(
    { userId, state: "blocked", waitReason: { $ne: PRIVATE_LOCK } },
    locked
      ? { $set: { waitReason: PRIVATE_LOCK, updatedAt: now }, $unset: { notBefore: "", error: "", errorReason: "" } }
      : { $set: { state: "queued", updatedAt: now }, $unset: { waitReason: "", notBefore: "", error: "", errorReason: "" } },
  );
  if (locked) return 0;
  await enqueueQueued({ userId });
  return result.modifiedCount;
}

/**
 * The §4.6 circuit breaker: warn `private_lock` and pause the account (a `reauth_required` account
 * keeps that status, still with the warning), then hold every queued post.
 */
export async function tripPrivateLock(userId: string): Promise<void> {
  const now = new Date();
  const { youtubeAccounts, youtubePosts } = collections();
  await youtubeAccounts.updateOne({ _id: userId }, [
    {
      $set: {
        warning: PRIVATE_LOCK,
        status: { $cond: [{ $eq: ["$status", "reauth_required"] }, "reauth_required", "paused"] },
        updatedAt: now,
      },
    },
  ]);
  await youtubePosts.updateMany({ userId, state: "queued" }, { $set: { state: "blocked", waitReason: "private_lock", updatedAt: now } });
}

/**
 * "Resume posting": clear the lock; `paused` becomes `active`. The held posts are queued when the
 * account ends up active, otherwise they wait for a reconnect. Returns the account, or null if gone.
 */
export async function resumePosting(userId: string): Promise<YoutubeAccountDoc | null> {
  const now = new Date();
  const { youtubeAccounts, youtubePosts } = collections();
  const account = await youtubeAccounts.findOneAndUpdate(
    { _id: userId },
    [{ $set: { status: { $cond: [{ $eq: ["$status", "paused"] }, "active", "$status"] }, updatedAt: now } }, { $unset: "warning" }],
    { returnDocument: "after" },
  );
  if (!account) return null;
  const locked = { userId, state: "blocked", waitReason: "private_lock" } as const;
  if (account.status === "active") {
    await youtubePosts.updateMany(locked, { $set: { state: "queued", updatedAt: now }, $unset: { waitReason: "" } });
    await enqueueQueued({ userId });
  } else {
    await youtubePosts.updateMany(locked, { $set: { waitReason: "reconnect", updatedAt: now } });
  }
  return account;
}

/** `quotaExceeded`: hold every queued post (the quota is per project) until `until`, never shortening a longer wait. */
export async function deferAllQueuedForQuota(until: Date): Promise<number> {
  const result = await collections().youtubePosts.updateMany(
    { state: "queued", $or: [{ notBefore: { $exists: false } }, { notBefore: { $lt: until } }] },
    { $set: { notBefore: until, waitReason: "quota", updatedAt: new Date() } },
  );
  return result.modifiedCount;
}

// --- Manual retry (§4.8) ---

/**
 * "Try again" on a `failed` or `blocked` post: reset the automatic attempts and set
 * `insertCap = max(insertCap, insertCalls + 1)`. A post that used up its cap gets exactly one more
 * `videos.insert`; one that did not keeps its unused allowance (the cap is never lowered). A retry
 * never resets the duplicate guard, and a saved session is still queried before any new insert.
 */
export async function retryPost(postId: string, userId: string): Promise<{ post: YoutubePostDoc; job: JobDoc }> {
  const { youtubePosts } = collections();
  const post = await youtubePosts.findOneAndUpdate(
    { _id: postId, userId, state: { $in: ["failed", "blocked"] } },
    [
      {
        $set: {
          state: "queued",
          attempts: 0,
          insertCap: { $max: ["$insertCap", { $add: ["$insertCalls", 1] }] },
          updatedAt: new Date(),
        },
      },
      { $unset: ["notBefore", "waitReason", "error", "errorReason"] },
    ],
    { returnDocument: "after" },
  );
  if (!post) {
    const existing = await youtubePosts.findOne({ _id: postId, userId }, { projection: { state: 1 } });
    if (!existing) throw new ApiError(404, "Post not found");
    if (existing.state === "uploaded") throw new ApiError(409, "This clip is already on YouTube.");
    throw new ApiError(409, "Only a failed or blocked post can be retried.");
  }
  return { post, job: await enqueuePost(post) };
}

// --- Serializer: never `upload`, tokens, `claimedBy` or storage keys ---

export type SerializedPost = {
  id: string;
  /** The current clip of the post's lineage; null once that clip is gone. */
  clip_id: string | null;
  state: YoutubePostDoc["state"];
  phase: YoutubePostDoc["phase"] | null;
  progress: number | null;
  wait_reason: YoutubeWaitReason | null;
  title: string | null;
  description: string | null;
  tags: string[];
  hashtags: string[];
  video_url: string | null;
  privacy_status: string | null;
  warning: string | null;
  error: string | null;
  not_before: string | null;
  /** "Try again" must warn that the clip may already be on the channel. */
  insert_cap_reached: boolean;
};

export function serializePosts(task: Pick<TaskDoc, "clips">, posts: YoutubePostDoc[]): { posts: SerializedPost[] } {
  const clipIdByLineage = new Map(task.clips.map((clip) => [lineageOf(clip), clip.id]));
  return {
    posts: posts.map((post) => ({
      id: post._id,
      clip_id: clipIdByLineage.get(post.lineageId) ?? null,
      state: post.state,
      phase: post.phase ?? null,
      progress: post.progress ?? null,
      wait_reason: post.waitReason ?? null,
      title: post.metadata?.title ?? null,
      description: post.metadata?.description ?? null,
      tags: post.metadata?.tags ?? [],
      hashtags: post.metadata?.hashtags ?? [],
      video_url: post.videoUrl ?? null,
      privacy_status: post.privacyStatus ?? null,
      warning: post.warning ?? null,
      error: post.error ?? null,
      not_before: post.notBefore?.toISOString() ?? null,
      insert_cap_reached: post.insertCalls >= post.insertCap,
    })),
  };
}
