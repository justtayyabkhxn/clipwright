// YouTube auto-post (design §4.2, §4.3): the connected account, its encrypted tokens, and the
// single-use OAuth state that ties a callback to the user who started it. Tokens are stored with
// `encryptSetting`/`decryptSetting` (byte-compatible AES-256-GCM) and never leave this module raw;
// `serializeAccount` is the only shape the API or the worker should hand back to a client.

import { createHash, randomBytes } from "node:crypto";
import type { MatchKeysAndValues, UpdateFilter } from "mongodb";
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

/**
 * Upsert the connected account after a successful OAuth exchange. Keeps the previous refresh token
 * when Google sends none (it only resends one when `prompt=consent` forces re-authorization).
 * `channelChanged` tells the callback route whether to cancel posts queued for a different channel.
 */
export async function saveConnectedAccount(userId: string, tokens: Tokens, channel: Channel): Promise<{ channelChanged: boolean }> {
  const now = new Date();
  const set: MatchKeysAndValues<YoutubeAccountDoc> = {
    channelId: channel.channelId,
    channelTitle: channel.title,
    accessToken: encryptSetting(tokens.accessToken),
    accessTokenExpiresAt: tokens.expiresAt,
    scopes: tokens.scopes,
    status: "active",
    connectedAt: now,
    updatedAt: now,
    ...(channel.handle !== undefined && { channelHandle: channel.handle }),
    ...(channel.thumbnailUrl !== undefined && { thumbnailUrl: channel.thumbnailUrl }),
    ...(tokens.refreshToken !== undefined && { refreshToken: encryptSetting(tokens.refreshToken) }),
  };
  const before = await collections().youtubeAccounts.findOneAndUpdate(
    { _id: userId },
    { $set: set, $setOnInsert: { autoPost: true, privacy: "public", madeForKids: false, createdAt: now } },
    { upsert: true, returnDocument: "before" },
  );
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

/** Deletes the account doc first, then makes a best-effort, logged-only revoke (never thrown). */
export async function disconnectAccount(userId: string): Promise<void> {
  const account = await collections().youtubeAccounts.findOneAndDelete({ _id: userId });
  if (!account) return;
  try {
    await revokeToken(decryptSetting(account.refreshToken));
  } catch (error) {
    console.warn(`[youtube] Could not revoke token for user ${userId}:`, (error as Error).message);
  }
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
 */
export async function getAccessToken(account: YoutubeAccountDoc, fetchImpl: typeof fetch = fetch): Promise<string> {
  const expiresAt = account.accessTokenExpiresAt?.getTime() ?? 0;
  if (account.accessToken && expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return decryptSetting(account.accessToken);
  }
  try {
    const refreshed = await refreshAccessToken(decryptSetting(account.refreshToken), fetchImpl);
    await collections().youtubeAccounts.updateOne(
      { _id: account._id },
      { $set: { accessToken: encryptSetting(refreshed.accessToken), accessTokenExpiresAt: refreshed.expiresAt, updatedAt: new Date() } },
    );
    return refreshed.accessToken;
  } catch (error) {
    if (error instanceof GoogleApiError && error.reason === "invalid_grant") {
      await setAccountStatus(account._id, "reauth_required");
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
