// publish_youtube (design §4.5): claim the post, check it may still go out, have Claude write its
// metadata, upload the lineage's current clip with the resumable protocol and record the video.
// Every post transition is fenced on this job's claim. Nothing is ever posted with fallback text.

import { setTimeout as sleep } from "node:timers/promises";
import { writeYoutubeMetadata, youtubeDescription, type YoutubeMetadata } from "../../server/ai/youtube-metadata";
import { collections } from "../../server/db";
import { env } from "../../server/env";
import type { JobOutcome } from "../../server/jobs";
import { getRuntimeSettings } from "../../server/settings";
import { getStorage } from "../../server/storage";
import { getTask } from "../../server/tasks";
import type { JobDoc, YoutubeAccountDoc, YoutubePostDoc } from "../../server/types";
import { getAccessToken, getAccount, markReauthRequired } from "../../server/youtube/accounts";
import {
  classify,
  GoogleApiError,
  nextMidnightPacific,
  querySession,
  startUploadSession,
  uploadFrom,
  type VideoInsertBody,
  type VideoResource,
} from "../../server/youtube/google";
import {
  AUTO_POST_OFF_ERROR,
  blockPost,
  cancelClaimedPost,
  CHANNEL_CHANGED_ERROR,
  claimPost,
  clearMetadata,
  deferAllQueuedForChannel,
  deferAllQueuedForQuota,
  deferPost,
  DISCONNECTED_ERROR,
  failPost,
  lineageOf,
  markUploaded,
  refundInsertCall,
  saveMetadata,
  saveSession,
  setPhase,
  takeInsertCall,
} from "../../server/youtube/posts";
import { cancelledOutcome, errorMessage, type JobContext } from "../context";

const MINUTE = 60_000;
/** Back in the queue after a transient failure; the failure after the last delay fails the post. */
const RETRY_DELAYS_MS = [1, 5, 15].map((minutes) => minutes * MINUTE);
/** Per job: the upload is tried this many times, 1/2/4/8 s apart, before the post is deferred. */
const UPLOAD_TRIES = 5;

/** Backoff seam, replaced in tests. */
export const uploadTiming = { sleep: (ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }) };

const RECONNECT = "Reconnect YouTube to post";
const PAUSED = "Posting is paused because YouTube made an upload private. Resume posting in Settings.";
const CLIP_GONE = "Not posted: the clip no longer exists.";
const FILE_MISSING = "The clip's video file is missing.";
const METADATA_FAILED = "Claude could not write the title and description.";
const INSERT_CAP_REACHED =
  "Stopped after repeated upload attempts so the clip is never posted twice. Check your channel before trying again.";
const SESSION_REFUSED = "YouTube refused the upload session (HTTP 401).";
const WORKER_STOPPED = "The upload stopped unexpectedly.";
/** Names the settings to check, never their values. */
const CHECK_OAUTH_CLIENT = "Check GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.";

const DONE: JobOutcome = { status: "succeeded" };
const later = (ms: number) => new Date(Date.now() + ms);

async function settle(write: Promise<unknown>): Promise<JobOutcome> {
  await write;
  return DONE;
}

/** Ends the upload as `failed` with our words, outside the §4.5 table: the insert cap, or a refused session. */
class PostFailed extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** §4.5 step 4: the job itself retries a network error, a 5xx or a 308 mid-upload; rate limits wait in the queue. */
const retryInJob = (error: unknown) =>
  classify(error) === "transient" && (!(error instanceof GoogleApiError) || error.status >= 500 || error.status === 308);

export async function publishYoutube(ctx: JobContext): Promise<JobOutcome> {
  const post = await claimPost(String(ctx.job.payload.postId), ctx.job._id);
  // Cancelled, uploaded, not due yet or held by another job: nothing to do.
  if (!post) return cancelledOutcome;

  // §4.5 checks, in order. This account snapshot also fences every token write.
  const account = await getAccount(post.userId);
  // No account doc: the user disconnected while this post was working, which cancels it (§7.9).
  if (!account) return settle(cancelClaimedPost(post, DISCONNECTED_ERROR));
  // Never upload to a channel the post wasn't meant for (§4.3 step 6).
  if (account.channelId !== post.channelId) return settle(cancelClaimedPost(post, CHANNEL_CHANGED_ERROR));
  if (!account.autoPost) return settle(cancelClaimedPost(post, AUTO_POST_OFF_ERROR));
  // The lock wins over a needed reconnect; only "Resume posting" releases it (§4.6).
  if (account.warning === "private_lock" || account.status === "paused") return settle(blockPost(post, "private_lock", PAUSED));
  if (account.status !== "active") return settle(blockPost(post, "reconnect", `${RECONNECT}.`));
  const task = await getTask(post.taskId);
  if (task?.status === "processing") return settle(deferPost(post, "restyle", later(2 * MINUTE)));
  const clip = task?.clips.find((candidate) => lineageOf(candidate) === post.lineageId);
  if (!task || !clip) return settle(cancelClaimedPost(post, CLIP_GONE));
  const file = await getStorage().stat(clip.storageKey);
  if (!file) return settle(failPost(post, FILE_MISSING));

  const upload = uploader(ctx, post, account, clip.storageKey, file.size);
  let metadata: YoutubeMetadata | undefined = post.metadata;
  for (let rewrites = 0; ; rewrites++) {
    if (!metadata) {
      await setPhase(post, "writing");
      try {
        const settings = await getRuntimeSettings();
        metadata = await writeYoutubeMetadata(
          { sourceTitle: task.source.title, hookTitle: clip.hookTitle, transcript: clip.text },
          { apiKey: settings.anthropicApiKey ?? "", model: env.CLAUDE_METADATA_MODEL, signal: ctx.signal, fetch: ctx.deps.fetch },
        );
      } catch (error) {
        if (ctx.stopReason) throw error;
        // Not classified: runWithRetry's give-up errors would read as permanent. The post waits instead.
        console.warn(`[youtube] Post ${post._id}: Claude could not write the metadata: ${errorMessage(error)}`);
        return settle(retryLater(post, METADATA_FAILED));
      }
      // Stored before any upload, so a retry never re-asks Claude and the task page shows what was sent.
      await saveMetadata(post._id, metadata);
    }
    await setPhase(post, "uploading");
    try {
      // markUploaded trips the private lock itself when YouTube returns another privacy.
      await markUploaded(post, await upload(metadata));
      return DONE;
    } catch (error) {
      if (ctx.stopReason) throw error;
      // The table is for Google's answers and network failures. Anything else (MongoDB failing in
      // markUploaded after the video went up, say) fails the job: the failure hook re-queues the post
      // in 2 min, and the kept session then recovers the video through the status query.
      if (!(error instanceof PostFailed || error instanceof GoogleApiError || classify(error) === "transient")) throw error;
      if (classify(error) === "invalid_metadata") {
        // Google refused Claude's text: never reuse it. Ask once more, then give up.
        await clearMetadata(post._id);
        metadata = undefined;
        if (rewrites === 0) continue;
      }
      return settle(settleUploadError(post, account, error));
    }
  }
}

/**
 * §4.5 steps 1–4. A saved session is always queried first: a 200 there recovers a lost response
 * without a second insert. One saved for this exact file is resumed from its offset. One saved for an
 * older render (a restyle changed the file) is queried once with its own size: a 200 means that render
 * is already the lineage's video; gone or incomplete, it is dropped, never resumed or fed the new file.
 * Otherwise one insert call is spent and a session started and saved. The rest of the file then goes
 * up in one PUT. A network error, 5xx or 308 on a query or the PUT goes back to step 1 within the job.
 * A failed start is never retried here (each try would spend an insert call): it goes to the error
 * table, except that a 401 refreshes the token once per job.
 */
function uploader(ctx: JobContext, post: YoutubePostDoc, account: YoutubeAccountDoc, storageKey: string, size: number) {
  const fetchImpl = ctx.deps.fetch ?? fetch;
  const current = post.upload?.storageKey === storageKey && post.upload.size === size;
  let session = current ? post.upload?.sessionUri : undefined;
  /** An older render's session: until it answers, no new session may start (it may hold the video). */
  let stale = current ? undefined : post.upload;
  /** The token the one 401-driven refresh returned; every later start in this job reuses it. */
  let freshToken: string | undefined;

  async function initiate(metadata: YoutubeMetadata): Promise<string> {
    for (;;) {
      const token = freshToken ?? (await getAccessToken(account, fetchImpl));
      // ponytail: claimedBy is the job id, which a re-claimed attempt of this job shares; this lease check
      // narrows that race before an insert, and the insert cap bounds it. A claim token in the fence would close it.
      ctx.throwIfStopped();
      if (!(await takeInsertCall(post))) throw new PostFailed(INSERT_CAP_REACHED, "insertCap");
      try {
        return await startUploadSession(token, insertBody(post, metadata), size, post.notifySubscribers, fetchImpl);
      } catch (error) {
        // An explicit limit refused the start: nothing exists to duplicate, so the call is not counted.
        const refused = classify(error);
        if (refused === "quota" || refused === "channel_limit") await refundInsertCall(post);
        if (freshToken !== undefined || !(error instanceof GoogleApiError && error.status === 401)) throw error;
        // The claim-time token counts as expired; the snapshot's refresh token still fences the write.
        freshToken = await getAccessToken({ ...account, accessTokenExpiresAt: undefined }, fetchImpl);
      }
    }
  }

  return async (metadata: YoutubeMetadata): Promise<VideoResource> => {
    for (let tries = 1; ; tries++) {
      try {
        let start = 0;
        if (stale) {
          const state = await querySession(stale.sessionUri, stale.size, fetchImpl);
          if ("done" in state) return state.done;
          stale = undefined;
        }
        if (session) {
          const state = await querySession(session, size, fetchImpl);
          if ("done" in state) return state.done;
          if ("gone" in state) session = undefined;
          else start = state.nextByte;
        }
        if (!session) {
          session = await initiate(metadata);
          await saveSession(post._id, { sessionUri: session, storageKey, size, startedAt: new Date() });
        }
        const body = getStorage().createReadStream(storageKey, { start, end: size - 1 });
        return await uploadFrom(session, size, start, body, ctx.signal, fetchImpl);
      } catch (error) {
        // No session (and no older one still to read) means the start itself failed: that goes to
        // the table, never round this loop.
        if (ctx.stopReason || (!session && !stale)) throw error;
        // The session URI gets no token, so its 401 asks for neither a refresh nor a reconnect: it is
        // §4.5's "any other 4xx". The session is kept, so "Try again" queries it before any new insert.
        if (error instanceof GoogleApiError && error.status === 401) throw new PostFailed(SESSION_REFUSED, "HTTP 401");
        if (!retryInJob(error) || tries >= UPLOAD_TRIES) throw error;
        await uploadTiming.sleep(1000 * 2 ** (tries - 1), ctx.signal);
      }
    }
  };
}

/** Exactly the §4.5 request: Claude's text with the hashtags at the end, nothing fixed beyond category 22. */
function insertBody(post: YoutubePostDoc, metadata: YoutubeMetadata): VideoInsertBody {
  return {
    snippet: {
      title: metadata.title,
      description: youtubeDescription(metadata),
      tags: metadata.tags,
      categoryId: "22",
      ...(metadata.language !== undefined && { defaultLanguage: metadata.language, defaultAudioLanguage: metadata.language }),
    },
    status: { privacyStatus: post.privacy, selfDeclaredMadeForKids: post.madeForKids, containsSyntheticMedia: false },
  };
}

/** A transient failure: back to the queue after 1, 5, then 15 min; the next one fails the post. */
function retryLater(post: YoutubePostDoc, message: string, errorReason?: string) {
  const delay = RETRY_DELAYS_MS[post.attempts];
  return delay === undefined ? failPost(post, message, errorReason) : deferPost(post, "retry", later(delay), message);
}

/** The §4.5 error table. Stored text is ours plus the reason code: never Google's body, a header, a URL or a token. */
async function settleUploadError(post: YoutubePostDoc, account: YoutubeAccountDoc, error: unknown): Promise<unknown> {
  if (error instanceof PostFailed) return failPost(post, error.message, error.code);
  const code = error instanceof GoogleApiError ? (error.reason ?? `HTTP ${error.status}`) : error instanceof Error ? error.name : "unknown";
  const say = (words: string) => `${words} (${code}).`;
  console.warn(`[youtube] Post ${post._id}: upload failed (${code})`);
  switch (classify(error)) {
    case "quota": {
      // The quota belongs to the Cloud project: hold every queued post so none wastes a call.
      const until = new Date(nextMidnightPacific(new Date()).getTime() + 5 * MINUTE);
      await deferPost(post, "quota", until, say("YouTube's daily upload quota is used up"));
      return deferAllQueuedForQuota(until);
    }
    case "channel_limit": {
      // The limit belongs to the channel: hold its other queued posts so none spends a refused call.
      const until = later(6 * 60 * MINUTE);
      await deferPost(post, "channel_limit", until, say("The channel reached YouTube's upload limit"));
      return deferAllQueuedForChannel(post.userId, post.channelId, until);
    }
    case "transient":
      return retryLater(post, say("YouTube could not be reached"), code);
    case "reauth":
      // A disconnect mid-run revokes the grant: cancel as the disconnect would have, never wait for a reconnect.
      if (!(await getAccount(post.userId))) return cancelClaimedPost(post, DISCONNECTED_ERROR);
      await markReauthRequired(account);
      return blockPost(post, "reconnect", say(code === "youtubeSignupRequired" ? "Create a YouTube channel, then reconnect" : RECONNECT));
    case "invalid_metadata":
      return failPost(post, say("YouTube rejected the title, description or tags"), code);
    default:
      // The token endpoint refusing our client (invalid_client, say) is the server's setup, not this clip.
      if (error instanceof GoogleApiError && error.tokenEndpoint) {
        return failPost(post, `${say("Google rejected the server's OAuth client")} ${CHECK_OAUTH_CLIENT}`, code);
      }
      return failPost(post, say("YouTube rejected the upload"), code);
  }
}

/** The job holding `post` died or threw: back in the queue in 2 min while automatic attempts remain, else failed. */
export function releaseLostPost(post: YoutubePostDoc): Promise<boolean> {
  return post.attempts < RETRY_DELAYS_MS.length ? deferPost(post, "retry", later(2 * MINUTE), WORKER_STOPPED) : failPost(post, WORKER_STOPPED);
}

/** Failure hook. The cron's `releaseOrphanedPosts` does the same for a post whose hook never completed. */
export async function publishFailed(job: JobDoc): Promise<void> {
  const post = await collections().youtubePosts.findOne({ _id: String(job.payload.postId), state: "working", claimedBy: job._id });
  if (post) await releaseLostPost(post);
}
