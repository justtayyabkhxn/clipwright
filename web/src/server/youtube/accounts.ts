// YouTube auto-post (design §4.2, §4.3): the connected account, its encrypted tokens, and the
// single-use OAuth state that ties a callback to the user who started it. Tokens are stored with
// `encryptSetting`/`decryptSetting` (byte-compatible AES-256-GCM) and never leave this module raw;
// `serializeAccount` is the only shape the API or the worker should hand back to a client.

import { createHash, randomBytes } from "node:crypto";
import type { Document, MatchKeysAndValues, UpdateFilter } from "mongodb";
import { collections } from "../db";
import { env } from "../env";
import { decryptSetting, encryptSetting } from "../settings";
import type { YoutubeAccountDoc } from "../types";
import { exchangeCode, fetchMyChannel, GoogleApiError, refreshAccessToken, revokeToken } from "./google";

const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// --- OAuth state (PKCE), single-use and user-bound ---

export async function createOAuthState(userId: string): Promise<{ state: string; codeChallenge: string }> {
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  await collections().oauthStates.insertOne({
    _id: state,
    userId,
    codeVerifier,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });
  return { state, codeChallenge };
}

/** `findOneAndDelete` makes this single-use; the `userId` and `expiresAt` checks are part of the same query. */
export async function consumeOAuthState(state: string, userId: string): Promise<{ codeVerifier: string } | null> {
  const doc = await collections().oauthStates.findOneAndDelete({ _id: state, userId, expiresAt: { $gt: new Date() } });
  return doc ? { codeVerifier: doc.codeVerifier } : null;
}

// --- Account repository ---

export async function getAccount(userId: string): Promise<YoutubeAccountDoc | null> {
  return collections().youtubeAccounts.findOne({ _id: userId });
}

type Tokens = Awaited<ReturnType<typeof exchangeCode>>;
type Channel = NonNullable<Awaited<ReturnType<typeof fetchMyChannel>>>;

/** A first-time connect (no existing account) with no refresh token in Google's response: nothing is inserted. */
export class MissingRefreshTokenError extends Error {
  constructor() {
    super("Google did not send a refresh token for a new YouTube connection");
    this.name = "MissingRefreshTokenError";
  }
}

/**
 * Upsert the connected account after a successful OAuth exchange, with a single aggregation-pipeline
 * update so every field reacts atomically to the account's state *before* this write, with no
 * read-then-write race:
 * - Keeps the previous refresh token when Google sends none (it only resends one when
 *   `prompt=consent` forces re-authorization); refuses to insert a brand-new account with none.
 * - Drops `channelHandle`/`thumbnailUrl` (`$$REMOVE`) when the new channel has none, instead of
 *   leaving the previous channel's behind.
 * - Preserves the §4.6 private-lock pause: status becomes `paused` (not `active`) when the stored
 *   `warning` is still `"private_lock"`; only `setAccountStatus`'s "Resume posting" clears it.
 * `channelChanged` tells the callback route whether to cancel posts queued for a different channel.
 */
export async function saveConnectedAccount(userId: string, tokens: Tokens, channel: Channel): Promise<{ channelChanged: boolean }> {
  if (tokens.refreshToken === undefined && !(await getAccount(userId))) {
    throw new MissingRefreshTokenError();
  }
  const now = new Date();
  const pipeline: Document[] = [
    {
      $set: {
        channelId: { $literal: channel.channelId },
        channelTitle: { $literal: channel.title },
        channelHandle: channel.handle !== undefined ? { $literal: channel.handle } : "$$REMOVE",
        thumbnailUrl: channel.thumbnailUrl !== undefined ? { $literal: channel.thumbnailUrl } : "$$REMOVE",
        accessToken: { $literal: encryptSetting(tokens.accessToken) },
        accessTokenExpiresAt: { $literal: tokens.expiresAt },
        scopes: { $literal: tokens.scopes },
        refreshToken: tokens.refreshToken !== undefined ? { $literal: encryptSetting(tokens.refreshToken) } : "$refreshToken",
        status: { $cond: [{ $eq: ["$warning", "private_lock"] }, "paused", "active"] },
        connectedAt: { $literal: now },
        updatedAt: { $literal: now },
        autoPost: { $ifNull: ["$autoPost", true] },
        privacy: { $ifNull: ["$privacy", "public"] },
        madeForKids: { $ifNull: ["$madeForKids", false] },
        createdAt: { $ifNull: ["$createdAt", now] },
      },
    },
  ];
  const before = await collections().youtubeAccounts.findOneAndUpdate({ _id: userId }, pipeline, { upsert: true, returnDocument: "before" });
  return { channelChanged: Boolean(before && before.channelId !== channel.channelId) };
}

export async function updateAccountPrefs(
  userId: string,
  prefs: { autoPost?: boolean; privacy?: YoutubeAccountDoc["privacy"]; madeForKids?: boolean },
): Promise<YoutubeAccountDoc | null> {
  const set: MatchKeysAndValues<YoutubeAccountDoc> = {
    updatedAt: new Date(),
    ...(prefs.autoPost !== undefined && { autoPost: prefs.autoPost }),
    ...(prefs.privacy !== undefined && { privacy: prefs.privacy }),
    ...(prefs.madeForKids !== undefined && { madeForKids: prefs.madeForKids }),
  };
  return collections().youtubeAccounts.findOneAndUpdate({ _id: userId }, { $set: set }, { returnDocument: "after" });
}

/**
 * Deletes the account doc and returns a thunk that best-effort revokes its token (logged-only,
 * never thrown), or `null` when there was no account. The revoke is a separate step, not awaited
 * here, so a caller can cancel the user's queued/blocked posts *before* the network call: a hung or
 * slow revoke (60 s `CALL_TIMEOUT_MS`) must never delay that cancel (design §4.3: delete → cancel →
 * best-effort revoke).
 */
export async function disconnectAccount(userId: string): Promise<(() => Promise<void>) | null> {
  const account = await collections().youtubeAccounts.findOneAndDelete({ _id: userId });
  if (!account) return null;
  return async () => {
    try {
      await revokeToken(decryptSetting(account.refreshToken));
    } catch (error) {
      console.warn(`[youtube] Could not revoke token for user ${userId}:`, (error as Error).message);
    }
  };
}

/**
 * `warning` is a tri-state: omitted leaves the stored warning as it is, `null` clears it, a string
 * replaces it. The private-lock circuit breaker's warning must survive an unrelated status change.
 */
export async function setAccountStatus(userId: string, status: YoutubeAccountDoc["status"], warning?: string | null): Promise<void> {
  const update: UpdateFilter<YoutubeAccountDoc> = {
    $set: { status, updatedAt: new Date(), ...(typeof warning === "string" && { warning }) },
    ...(warning === null && { $unset: { warning: "" } }),
  };
  await collections().youtubeAccounts.updateOne({ _id: userId }, update);
}

/**
 * The account's current access token, refreshing when fewer than 5 minutes remain. A refresh
 * persists the new token so the next call does not re-refresh. `invalid_grant` means the refresh
 * token itself is dead: the account moves to `reauth_required` and the error is re-thrown so the
 * caller blocks the post (design §4.3, §4.5).
 *
 * Both writes are fenced on `{_id, refreshToken: account.refreshToken}`, the caller's own snapshot:
 * a stale caller (an in-flight refresh racing a reconnect, or a revoked old token after the user
 * reconnected) matches no document once the refresh token has changed, so its write is a silent
 * no-op instead of overwriting the newly connected account's token or status. The encrypted
 * refresh token has a random nonce, so a reconnect that brings a *new* token (or even re-sends the
 * same raw token) never matches the old ciphertext.
 */
export async function getAccessToken(account: YoutubeAccountDoc, fetchImpl: typeof fetch = fetch): Promise<string> {
  const expiresAt = account.accessTokenExpiresAt?.getTime() ?? 0;
  if (account.accessToken && expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return decryptSetting(account.accessToken);
  }
  const fence = { _id: account._id, refreshToken: account.refreshToken };
  try {
    const refreshed = await refreshAccessToken(decryptSetting(account.refreshToken), fetchImpl);
    await collections().youtubeAccounts.updateOne(fence, {
      $set: { accessToken: encryptSetting(refreshed.accessToken), accessTokenExpiresAt: refreshed.expiresAt, updatedAt: new Date() },
    });
    return refreshed.accessToken;
  } catch (error) {
    if (error instanceof GoogleApiError && error.reason === "invalid_grant") {
      await collections().youtubeAccounts.updateOne(fence, { $set: { status: "reauth_required", updatedAt: new Date() } });
    }
    throw error;
  }
}

// --- Serializer: never includes tokens ---

function googleConfigured(): boolean {
  return Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);
}

export function serializeAccount(account: YoutubeAccountDoc | null) {
  const configured = googleConfigured();
  return {
    configured,
    connected: account !== null,
    channel: account
      ? { id: account.channelId, title: account.channelTitle, handle: account.channelHandle ?? null, thumbnail_url: account.thumbnailUrl ?? null }
      : null,
    status: account?.status ?? null,
    warning: account?.warning ?? null,
    auto_post: account?.autoPost ?? false,
    privacy: account?.privacy ?? "public",
    made_for_kids: account?.madeForKids ?? false,
    ...(!configured && { setup_hint: "Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to enable YouTube auto-post." }),
  };
}
