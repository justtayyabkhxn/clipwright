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
/** Uploads of one user start at least this far apart, so a task's clips go live spread out, not all at once. */
export const UPLOAD_GAP_MS = 10 * 60 * 1000;
/**
 * YouTube's channel upload limit (`uploadLimitExceeded`): the channel's posts are held this long, then
 * wait for the user's "Post" / "Post all". Nothing retries on its own: the reset time is unpublished.
 */
export const CHANNEL_LIMIT_HOLD_MS = 12 * 60 * 60 * 1000;
/** A slot may start this early: a job that runs on time must not miss its slot by the seconds the previous claim took. */
const SLOT_SLACK_MS = 60 * 1000;
export const CHANNEL_CHANGED_ERROR = "A different channel was connected.";
export const AUTO_POST_OFF_ERROR = "Auto-post was turned off.";
export const DISCONNECTED_ERROR = "YouTube account was disconnected.";
/** §4.7: clip delete and task delete 409 while the lineage's post is mid-upload. */
export const POST_UPLOADING_MESSAGE = "This clip is uploading to YouTube. Try again in a minute.";
/** §4.7: the restyle route's 409 while any of the task's posts is mid-upload. */
export const RESTYLE_UPLOADING_MESSAGE = "A clip from this task is uploading to YouTube. Try again in a minute.";
/** The §4.6 forced-private code: the UI maps it to copy in `messages/en` (never an English sentence in `post.warning`). */
export const PRIVATE_LOCK = "private_lock";
/** A "Post" / "Post all" pressed before the channel-limit hold ends (the buttons are disabled until then). */
export const CHANNEL_LIMIT_HELD_MESSAGE = "YouTube's channel upload limit was reached. You can post these clips once the 12-hour wait is over.";
const CANCELLABLE: YoutubePostDoc["state"][] = ["queued", "blocked", "failed"];
/** Fields that only mean something while a job holds the post. */
const RELEASE = { claimedBy: "", phase: "", progress: "" } as const;

const due = (now: Date): Filter<YoutubePostDoc> => ({ $or: [{ notBefore: { $exists: false } }, { notBefore: { $lte: now } }] });
const held = (post: YoutubePostDoc): Filter<YoutubePostDoc> => ({ _id: post._id, state: "working", claimedBy: post.claimedBy });
const notUploaded = (postId: string): Filter<YoutubePostDoc> => ({ _id: postId, state: { $ne: "uploaded" } });

async function enqueuePost(
  post: Pick<YoutubePostDoc, "_id" | "taskId" | "userId">,
  runAt?: Date,
): Promise<{ job: JobDoc; created: boolean }> {
  return enqueueJob({
    type: "publish_youtube",
    runAt,
    taskId: post.taskId,
    userId: post.userId,
    activeKey: `youtube:${post._id}`,
    payload: { postId: post._id },
  });
}

/**
 * Enqueue every due `queued` post matching `filter` (an already-held activeKey is a no-op).
 * Exported for the cron dispatch step (§4.5), which calls it with no filter and its own `now`.
 * Returns how many jobs this call actually created, not how many posts matched (a post whose job
 * already existed is a no-op, not a new dispatch).
 */
export async function enqueueQueued(filter: Filter<YoutubePostDoc> = {}, now = new Date()): Promise<number> {
  const posts = await collections()
    .youtubePosts.find({ ...filter, state: "queued", ...due(now) })
    .toArray();
  let created = 0;
  for (const post of posts) if ((await enqueuePost(post)).created) created++;
  return created;
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

  const now = new Date();
  const { state, waitReason, notBefore: heldUntil } = initialState(account, now);
  // Each queued post gets its own upload slot, UPLOAD_GAP_MS after the previous one (§4.4).
  const firstSlot = state === "queued" ? await firstFreeSlot(account, now) : now;
  const slot = (index: number) => new Date(firstSlot.getTime() + index * UPLOAD_GAP_MS);
  // A cron re-run sees the task's current clips. One that starts its own lineage after the run
  // completed was combined in the editor, which never posts (§2); a restyled clip keeps an older lineage.
  // ponytail: a restyle finishing in that window moves run.completedAt and gives the combined clip's
  // re-render the combined lineage, so it would post; mark combined clips explicitly if that matters.
  const completedAt = task.run?.completedAt;
  const combined = (clip: ClipDoc) => completedAt !== undefined && lineageOf(clip) === clip.id && clip.createdAt > completedAt;
  const docs: YoutubePostDoc[] = task.clips
    .filter((clip) => clip.hookType !== "fallback" && !combined(clip))
    .map((clip, index) => ({
      _id: randomUUID(),
      userId: task.userId,
      taskId,
      lineageId: lineageOf(clip),
      channelId: account.channelId,
      state,
      ...(waitReason && { waitReason }),
      ...(heldUntil && { notBefore: heldUntil }),
      ...(state === "queued" && slot(index) > now && { notBefore: slot(index), waitReason: "spacing" as const }),
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
    // Each job runs at its post's slot.
    const queued = await youtubePosts.find({ taskId, state: "queued" }).toArray();
    const byLineage = new Map(queued.map((post) => [post.lineageId, post]));
    for (const doc of docs) {
      const post = byLineage.get(doc.lineageId);
      if (post) await enqueuePost(post, post.notBefore);
    }
  }
  await markDone();
  return inserted;
}

/** The first slot after every upload already started or scheduled for this user. */
async function firstFreeSlot(account: YoutubeAccountDoc, now: Date): Promise<Date> {
  const [last] = await collections()
    .youtubePosts.find({ userId: account._id, state: "queued", notBefore: { $exists: true } })
    .sort({ notBefore: -1 })
    .limit(1)
    .toArray();
  return new Date(Math.max(now.getTime(), account.nextUploadAt?.getTime() ?? 0, last ? last.notBefore!.getTime() + UPLOAD_GAP_MS : 0));
}

/**
 * Take the user's upload slot: null when this upload may start now (the next one then waits
 * UPLOAD_GAP_MS), else when it may. Every post goes through this, however it was queued (a retry,
 * a resume after the lock, a reconnect), so no two uploads ever start back to back.
 */
export async function reserveUploadSlot(userId: string, now = new Date()): Promise<Date | null> {
  const { youtubeAccounts } = collections();
  const reserved = await youtubeAccounts.findOneAndUpdate(
    { _id: userId, $or: [{ nextUploadAt: { $exists: false } }, { nextUploadAt: { $lte: new Date(now.getTime() + SLOT_SLACK_MS) } }] },
    { $set: { nextUploadAt: new Date(now.getTime() + UPLOAD_GAP_MS) } },
  );
  if (reserved) return null;
  return (await youtubeAccounts.findOne({ _id: userId }, { projection: { nextUploadAt: 1 } }))?.nextUploadAt ?? null;
}

/**
 * `queued` only for an active, unlocked account outside a channel-limit hold; the private lock wins over
 * a needed reconnect, which wins over the hold.
 */
function initialState(account: YoutubeAccountDoc, now = new Date()): Pick<YoutubePostDoc, "state" | "waitReason" | "notBefore"> {
  if (account.warning === PRIVATE_LOCK) return { state: "blocked", waitReason: "private_lock" };
  if (account.status !== "active") return { state: "blocked", waitReason: "reconnect" };
  if (account.channelLimitUntil && account.channelLimitUntil > now) {
    return { state: "blocked", waitReason: "channel_limit", notBefore: account.channelLimitUntil };
  }
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

/** The held post's own channel-limit hold: `blocked` until `until`, then the user's "Post" releases it. */
export async function holdPostForChannelLimit(post: YoutubePostDoc, until: Date, message: string): Promise<boolean> {
  const result = await collections().youtubePosts.updateOne(held(post), {
    $set: { state: "blocked", waitReason: "channel_limit", notBefore: until, error: message, updatedAt: new Date() },
    $unset: { ...RELEASE, errorReason: "" },
  });
  return result.matchedCount > 0;
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

/** A held post that must never be uploaded (clip gone, another channel, auto-post off): `error` says why. */
export async function cancelClaimedPost(post: YoutubePostDoc, error: string): Promise<boolean> {
  const result = await collections().youtubePosts.updateOne(held(post), {
    $set: { state: "cancelled", error, updatedAt: new Date() },
    $unset: { ...RELEASE, notBefore: "", waitReason: "", errorReason: "" },
  });
  return result.matchedCount > 0;
}

/** What the claim holder is doing, for the task page's chip. */
export async function setPhase(post: YoutubePostDoc, phase: NonNullable<YoutubePostDoc["phase"]>): Promise<boolean> {
  const result = await collections().youtubePosts.updateOne(held(post), { $set: { phase, updatedAt: new Date() } });
  return result.matchedCount > 0;
}

/**
 * Spend one `videos.insert` session start, counted *before* the call (§4.5); only an explicit quota
 * or channel limit gives it back (`refundInsertCall`). False when the post's `insertCap` is used up
 * (or the claim was lost): the caller must not initiate.
 */
export async function takeInsertCall(post: YoutubePostDoc): Promise<boolean> {
  const result = await collections().youtubePosts.updateOne(
    { ...held(post), $expr: { $lt: ["$insertCalls", "$insertCap"] } },
    { $inc: { insertCalls: 1 }, $set: { updatedAt: new Date() } },
  );
  return result.matchedCount > 0;
}

/**
 * Give back the call `takeInsertCall` counted, when the start was refused with an explicit quota or
 * channel limit: Google sent no Location, so no session, and no video, can exist. Never below zero.
 */
export async function refundInsertCall(post: YoutubePostDoc): Promise<boolean> {
  const result = await collections().youtubePosts.updateOne(
    { ...held(post), insertCalls: { $gt: 0 } },
    { $inc: { insertCalls: -1 }, $set: { updatedAt: new Date() } },
  );
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

/** No `error` (a delete): the old one goes too, so the chip never shows a stale wait or failure as the reason. */
const cancel = (error?: string): UpdateFilter<YoutubePostDoc> => ({
  $set: { state: "cancelled", updatedAt: new Date(), ...(error !== undefined && { error }) },
  $unset: { notBefore: "", waitReason: "", errorReason: "", ...(error === undefined && { error: "" }) },
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

/**
 * Clip delete. The same post doc as `claimPost`'s CAS, so exactly one of the two wins. A cancel
 * returns the post as it was, for `restoreCancelledPost` if the delete is then refused.
 */
export async function cancelPostForLineage(
  taskId: string,
  lineageId: string,
): Promise<{ result: "cancelled"; previous: YoutubePostDoc } | { result: "working" | "none" }> {
  const { youtubePosts } = collections();
  const previous = await youtubePosts.findOneAndUpdate({ taskId, lineageId, state: { $in: CANCELLABLE } }, cancel(), {
    returnDocument: "before",
  });
  if (previous) return { result: "cancelled", previous };
  const post = await youtubePosts.findOne({ taskId, lineageId }, { projection: { state: 1 } });
  return { result: post?.state === "working" ? "working" : "none" };
}

/** Undo `cancelPostForLineage` for a refused clip delete: a post still cancelled gets its state, wait and error back. */
export async function restoreCancelledPost(previous: YoutubePostDoc): Promise<void> {
  await collections().youtubePosts.updateOne(
    { _id: previous._id, state: "cancelled" },
    {
      $set: {
        state: previous.state,
        updatedAt: new Date(),
        ...(previous.waitReason && { waitReason: previous.waitReason }),
        ...(previous.notBefore && { notBefore: previous.notBefore }),
        ...(previous.error && { error: previous.error }),
        ...(previous.errorReason && { errorReason: previous.errorReason }),
      },
    },
  );
}

/** Restyle guard (§4.7): true while any of the task's posts is mid-upload. */
export async function hasWorkingPost(taskId: string): Promise<boolean> {
  return (await collections().youtubePosts.countDocuments({ taskId, state: "working" })) > 0;
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
  // A channel-limit hold is the user's to release ("Post"), never a reconnect's.
  const result = await collections().youtubePosts.updateMany(
    { userId, state: "blocked", waitReason: { $nin: [PRIVATE_LOCK, "channel_limit"] } },
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
    // A wait from before the lock (quota, say) is dropped too: the first post re-defers if it still holds.
    await youtubePosts.updateMany(locked, { $set: { state: "queued", updatedAt: now }, $unset: { waitReason: "", notBefore: "" } });
    await enqueueQueued({ userId });
  } else {
    // The same reset as `unblockAfterReconnect`'s locked branch: no wait or error from before the lock.
    await youtubePosts.updateMany(locked, { $set: { waitReason: "reconnect", updatedAt: now }, $unset: { error: "", errorReason: "", notBefore: "" } });
  }
  return account;
}

/** Hold every queued post matching `filter` until `until`, never shortening a longer wait. */
async function holdQueued(filter: Filter<YoutubePostDoc>, waitReason: YoutubeWaitReason, until: Date): Promise<number> {
  const result = await collections().youtubePosts.updateMany(
    { ...filter, state: "queued", $or: [{ notBefore: { $exists: false } }, { notBefore: { $lt: until } }] },
    { $set: { notBefore: until, waitReason, updatedAt: new Date() } },
  );
  return result.modifiedCount;
}

/** `quotaExceeded`: the quota is per project, so every queued post waits. */
export function deferAllQueuedForQuota(until: Date): Promise<number> {
  return holdQueued({}, "quota", until);
}

/**
 * `uploadLimitExceeded`: the limit is per channel, so the account records the hold (posts created during
 * it start held) and that channel's queued posts are held with it. Returns how many were held.
 */
export async function holdChannelForLimit(userId: string, channelId: string, until: Date): Promise<number> {
  const now = new Date();
  const { youtubeAccounts, youtubePosts } = collections();
  await youtubeAccounts.updateOne({ _id: userId, channelId }, { $set: { channelLimitUntil: until, updatedAt: now } });
  const result = await youtubePosts.updateMany(
    { userId, channelId, state: "queued" },
    { $set: { state: "blocked", waitReason: "channel_limit", notBefore: until, updatedAt: now }, $unset: { error: "", errorReason: "" } },
  );
  return result.modifiedCount;
}

/**
 * "Post all": queue every channel-limit-held post of the user, oldest first, in 10-minute slots. 409 while
 * any hold is still running (the buttons are disabled until then). Returns how many were released.
 */
export async function releaseChannelLimit(userId: string, now = new Date()): Promise<number> {
  const { youtubeAccounts, youtubePosts } = collections();
  const heldFilter = { userId, state: "blocked", waitReason: "channel_limit" } as const;
  const heldPosts = await youtubePosts.find(heldFilter).sort({ createdAt: 1 }).toArray();
  if (!heldPosts.length) return 0;
  const latest = Math.max(...heldPosts.map((post) => post.notBefore?.getTime() ?? 0));
  if (latest > now.getTime()) throw new ApiError(409, { message: CHANNEL_LIMIT_HELD_MESSAGE, code: "channel_limit", available_at: new Date(latest).toISOString() });

  const account = await youtubeAccounts.findOneAndUpdate({ _id: userId }, { $unset: { channelLimitUntil: "" } }, { returnDocument: "after" });
  if (!account) throw new ApiError(404, "YouTube account is not connected.");
  const firstSlot = await firstFreeSlot(account, now);
  let released = 0;
  for (const [index, post] of heldPosts.entries()) {
    const slot = new Date(firstSlot.getTime() + index * UPLOAD_GAP_MS);
    const later = slot > now;
    const queued = await youtubePosts.findOneAndUpdate(
      { _id: post._id, ...heldFilter },
      {
        $set: { state: "queued", attempts: 0, updatedAt: now, ...(later && { notBefore: slot, waitReason: "spacing" as const }) },
        $unset: { error: "", errorReason: "", ...(!later && { notBefore: "", waitReason: "" }) },
      },
      { returnDocument: "after" },
    );
    if (!queued) continue;
    await enqueuePost(queued, queued.notBefore);
    released++;
  }
  return released;
}

// --- Manual retry (§4.8) ---

/**
 * "Try again" on a `failed` or `blocked` post: reset the automatic attempts and set
 * `insertCap = max(insertCap, insertCalls + 1)`. A post that used up its cap gets exactly one more
 * `videos.insert`; one that did not keeps its unused allowance (the cap is never lowered). A retry
 * never resets the duplicate guard, and a saved session is still queried before any new insert.
 */
export async function retryPost(
  postId: string,
  userId: string,
  taskId?: string,
): Promise<{ post: YoutubePostDoc; job: JobDoc }> {
  const { youtubePosts } = collections();
  const now = new Date();
  const owned = { _id: postId, userId, ...(taskId && { taskId }) };
  // A channel-limit hold may only be released once it has run out.
  const stillHeld = { waitReason: "channel_limit" as const, notBefore: { $gt: now } };
  const post = await youtubePosts.findOneAndUpdate(
    { ...owned, state: { $in: ["failed", "blocked"] }, $nor: [stillHeld] },
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
    const existing = await youtubePosts.findOne(owned, { projection: { state: 1, waitReason: 1, notBefore: 1 } });
    if (!existing) throw new ApiError(404, "Post not found");
    if (existing.state === "uploaded") throw new ApiError(409, "This clip is already on YouTube.");
    if (existing.waitReason === "channel_limit" && existing.notBefore && existing.notBefore > now) {
      throw new ApiError(409, { message: CHANNEL_LIMIT_HELD_MESSAGE, code: "channel_limit", available_at: existing.notBefore.toISOString() });
    }
    throw new ApiError(409, "Only a failed or blocked post can be retried.");
  }
  return { post, job: (await enqueuePost(post)).job };
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
  /** YouTube's `status.uploadStatus` from the last verify (§4.6): "deleted", "rejected" and "failed" change the chip. */
  upload_status: string | null;
  warning: string | null;
  error: string | null;
  not_before: string | null;
  stats: { views: number; likes: number | null; comments: number | null } | null;
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
      upload_status: post.uploadStatus ?? null,
      warning: post.warning ?? null,
      error: post.error ?? null,
      not_before: post.notBefore?.toISOString() ?? null,
      stats: post.stats ? { views: post.stats.views, likes: post.stats.likes, comments: post.stats.comments } : null,
      insert_cap_reached: post.insertCalls >= post.insertCap,
    })),
  };
}

/** One `GET /api/youtube/posts` item: a `SerializedPost` plus where it came from. */
export type OverviewPost = SerializedPost & {
  task_id: string;
  /** The task's source title; null once the task is gone. */
  task_title: string | null;
  /** The lineage's current clip's hook title; null once that clip is gone. */
  clip_title: string | null;
  created_at: string;
  uploaded_at: string | null;
  /** What the insights group by; null once the clip or task is gone. */
  hook_type: string | null;
  duration: number | null;
  virality_score: number | null;
  caption_template: string | null;
};

/**
 * The user's newest `limit` posts, newest first, for the YouTube overview page. `truncated` says
 * older ones exist. One query for the posts and one for their tasks (titles and clips only).
 */
export type StatsTotals = { videos: number; views: number; likes: number; comments: number };

export async function listPostsForUser(
  userId: string,
  limit: number,
): Promise<{ posts: OverviewPost[]; truncated: boolean; totals: StatsTotals }> {
  const { youtubePosts, tasks } = collections();
  // Over every live posted video, not just the listed page; $sum skips hidden (null) counts.
  const [sums] = await youtubePosts
    .aggregate<StatsTotals>([
      { $match: { userId, state: "uploaded", uploadStatus: { $ne: "deleted" }, stats: { $exists: true } } },
      { $group: { _id: null, videos: { $sum: 1 }, views: { $sum: "$stats.views" }, likes: { $sum: "$stats.likes" }, comments: { $sum: "$stats.comments" } } },
      { $project: { _id: 0 } },
    ])
    .toArray();
  const totals = sums ?? { videos: 0, views: 0, likes: 0, comments: 0 };
  // A post cancelled without a reason (a clip delete) has nothing to show, so it takes no slot.
  const found = await youtubePosts
    .find({ userId, $nor: [{ state: "cancelled", error: { $exists: false } }] })
    .sort({ createdAt: -1 })
    .limit(limit + 1)
    .toArray();
  const posts = found.slice(0, limit);
  const taskDocs = await tasks
    .find(
      { _id: { $in: [...new Set(posts.map((post) => post.taskId))] }, userId },
      {
        projection: {
          "source.title": 1,
          "settings.captionTemplate": 1,
          "clips.id": 1,
          "clips.lineageId": 1,
          "clips.hookTitle": 1,
          "clips.hookType": 1,
          "clips.duration": 1,
          "clips.viralityScore": 1,
        },
      },
    )
    .toArray();
  const taskById = new Map(taskDocs.map((task) => [task._id, task]));
  return {
    truncated: found.length > limit,
    totals,
    posts: posts.map((post) => {
      const task = taskById.get(post.taskId);
      const [serialized] = serializePosts(task ?? { clips: [] }, [post]).posts;
      const clip = task?.clips.find((candidate) => candidate.id === serialized.clip_id);
      return {
        ...serialized,
        task_id: post.taskId,
        task_title: task?.source.title ?? null,
        clip_title: clip?.hookTitle ?? null,
        hook_type: clip?.hookType ?? null,
        duration: clip?.duration ?? null,
        virality_score: clip?.viralityScore ?? null,
        caption_template: task?.settings.captionTemplate ?? null,
        created_at: post.createdAt.toISOString(),
        uploaded_at: post.uploadedAt?.toISOString() ?? null,
      };
    }),
  };
}
