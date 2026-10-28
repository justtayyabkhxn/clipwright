// Google OAuth, YouTube Data API and resumable upload over plain fetch (design §4.3, §4.5, §4.6).
// Errors never carry a body, header, URL or token: only the operation, the HTTP status and
// Google's reason code.

import type { Readable } from "node:stream";
import { isTransientError } from "../ai/client";
import { env } from "../env";
import { pullStream } from "../http";

export const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

// Every call but the upload PUT is small; a hung connection must not hold the worker's only slot.
const CALL_TIMEOUT_MS = 60_000;

/** The redirect URI registered with Google (design §4.3): one literal, shared by `/connect` and `/callback`. */
export function callbackRedirectUri(): string {
  return `${env.BETTER_AUTH_URL}/api/youtube/callback`;
}

/** Google's endpoints; GOOGLE_BASE_URL_OVERRIDE (tests, e2e) replaces every origin. */
export function googleUrls() {
  const base = env.GOOGLE_BASE_URL_OVERRIDE?.replace(/\/+$/, "");
  const at = (origin: string, path: string) => (base ?? origin) + path;
  return {
    authorize: at("https://accounts.google.com", "/o/oauth2/v2/auth"),
    token: at("https://oauth2.googleapis.com", "/token"),
    revoke: at("https://oauth2.googleapis.com", "/revoke"),
    api: at("https://www.googleapis.com", "/youtube/v3"),
    upload: at("https://www.googleapis.com", "/upload/youtube/v3"),
  };
}

export class GoogleApiError extends Error {
  constructor(
    operation: string,
    readonly status: number,
    readonly reason?: string,
    // Only the token endpoint returns OAuth error codes (invalid_client, invalid_grant, ...). A 401
    // there is a server misconfiguration (bad/missing client secret), not an expired user token, so
    // classify must not treat it like a Data API/upload 401 (§4.3: only invalid_grant means reconnect).
    readonly tokenEndpoint = false,
  ) {
    super(`Google ${operation} failed (HTTP ${status}${reason ? `, ${reason}` : ""})`);
    this.name = "GoogleApiError";
  }
}

/** Throw for a failed response; `reason` is the token endpoint's `error` or the Data API's `error.errors[0].reason`. */
async function fail(operation: string, response: Response, tokenEndpoint = false): Promise<never> {
  let reason: string | undefined;
  try {
    const body = JSON.parse(await response.text()) as { error?: string | { errors?: { reason?: unknown }[] } };
    const raw = typeof body.error === "string" ? body.error : body.error?.errors?.[0]?.reason;
    if (typeof raw === "string" && /^\w{1,64}$/.test(raw)) reason = raw;
  } catch {
    // Not JSON: the status alone classifies it.
  }
  throw new GoogleApiError(operation, response.status, reason, tokenEndpoint);
}

async function readJson<T>(operation: string, response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    // V8 quotes the start of the body in a JSON SyntaxError, and a token response holds tokens.
    if (error instanceof SyntaxError) throw new GoogleApiError(operation, response.status, "invalidJson");
    throw error;
  }
}

async function okJson<T>(operation: string, response: Response, tokenEndpoint = false): Promise<T> {
  if (!response.ok) await fail(operation, response, tokenEndpoint);
  return readJson<T>(operation, response);
}

type TokenResponse = { access_token: string; refresh_token?: string; expires_in: number; scope?: string };

async function tokenRequest(operation: string, params: Record<string, string>, fetchImpl: typeof fetch) {
  const response = await fetchImpl(googleUrls().token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...params,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
    }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  return okJson<TokenResponse>(operation, response, true);
}

const expiresAt = (token: TokenResponse) => new Date(Date.now() + token.expires_in * 1000);

export async function exchangeCode(code: string, codeVerifier: string, redirectUri: string, fetchImpl: typeof fetch = fetch) {
  const token = await tokenRequest(
    "token exchange",
    { grant_type: "authorization_code", code, code_verifier: codeVerifier, redirect_uri: redirectUri },
    fetchImpl,
  );
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: expiresAt(token),
    scopes: token.scope?.split(" ").filter(Boolean) ?? [],
  };
}

export async function refreshAccessToken(refreshToken: string, fetchImpl: typeof fetch = fetch) {
  const token = await tokenRequest("token refresh", { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
  return { accessToken: token.access_token, expiresAt: expiresAt(token) };
}

export async function revokeToken(token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const response = await fetchImpl(googleUrls().revoke, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!response.ok) await fail("token revoke", response, true);
}

const apiGet = (accessToken: string, path: string, fetchImpl: typeof fetch) =>
  fetchImpl(`${googleUrls().api}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });

type ChannelList = {
  items?: { id: string; snippet: { title: string; customUrl?: string; thumbnails?: { default?: { url?: string } } } }[];
};

/** The token owner's channel, or null when the Google account has none. */
export async function fetchMyChannel(accessToken: string, fetchImpl: typeof fetch = fetch) {
  const list = await okJson<ChannelList>("channel lookup", await apiGet(accessToken, "/channels?part=snippet&mine=true", fetchImpl));
  const channel = list.items?.[0];
  if (!channel) return null;
  return {
    channelId: channel.id,
    title: channel.snippet.title,
    handle: channel.snippet.customUrl,
    thumbnailUrl: channel.snippet.thumbnails?.default?.url,
  };
}

export type VideoStatus = { privacyStatus: string; uploadStatus: string; rejectionReason?: string };

type VideoList = {
  items?: { id: string; status: { privacyStatus: string; uploadStatus: string; rejectionReason?: string; failureReason?: string } }[];
};

/** `videos.list?part=status`, 50 ids (1 quota unit) per call. Deleted videos are absent from the map. */
export async function listVideoStatus(accessToken: string, ids: string[], fetchImpl: typeof fetch = fetch) {
  const statuses = new Map<string, VideoStatus>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50).map(encodeURIComponent).join(",");
    // videos.list does not support maxResults together with the id filter; an id lookup already
    // returns every match (up to the 50 ids sent in this batch).
    const list = await okJson<VideoList>(
      "video status lookup",
      await apiGet(accessToken, `/videos?part=status&id=${batch}`, fetchImpl),
    );
    for (const { id, status } of list.items ?? []) {
      // A failed upload explains itself in failureReason, a rejected one in rejectionReason.
      const reason = status.rejectionReason ?? status.failureReason;
      statuses.set(id, {
        privacyStatus: status.privacyStatus,
        uploadStatus: status.uploadStatus,
        ...(reason ? { rejectionReason: reason } : {}),
      });
    }
  }
  return statuses;
}

export type VideoInsertBody = {
  snippet: {
    title: string;
    description: string;
    tags: string[];
    categoryId: string;
    defaultLanguage?: string;
    defaultAudioLanguage?: string;
  };
  status: { privacyStatus: string; selfDeclaredMadeForKids: boolean; containsSyntheticMedia: boolean };
};

export type VideoResource = { id: string; status: { privacyStatus: string; uploadStatus: string } };

/** Initiate a resumable `videos.insert` (one call against the 100/day bucket); returns the session URI. */
export async function startUploadSession(
  accessToken: string,
  body: VideoInsertBody,
  size: number,
  notifySubscribers: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = `${googleUrls().upload}/videos?uploadType=resumable&part=snippet,status&notifySubscribers=${notifySubscribers}`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(size),
      "X-Upload-Content-Type": "video/mp4",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!response.ok) await fail("upload session start", response);
  const location = response.headers.get("location");
  if (!location) throw new GoogleApiError("upload session start", response.status, "missingLocation");
  return location;
}

export type SessionState = { done: VideoResource } | { nextByte: number } | { gone: true };

/** Ask a saved session how far it got: finished (a lost response), resume offset, or expired. */
export async function querySession(sessionUri: string, size: number, fetchImpl: typeof fetch = fetch): Promise<SessionState> {
  const response = await fetchImpl(sessionUri, {
    method: "PUT",
    headers: { "Content-Length": "0", "Content-Range": `bytes */${size}` },
    redirect: "manual", // 308 is "Resume Incomplete" here, not a redirect
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (response.status === 200 || response.status === 201) return { done: await readJson<VideoResource>("upload session query", response) };
  if (response.status === 308) {
    const last = /^bytes=0-(\d+)$/.exec(response.headers.get("range") ?? "");
    return { nextByte: last ? Number(last[1]) + 1 : 0 };
  }
  if (response.status === 404 || response.status === 410) return { gone: true };
  return fail("upload session query", response);
}

/** Stream bytes `startByte..size-1` of the file in one PUT (Google discourages chunking). */
export async function uploadFrom(
  sessionUri: string,
  size: number,
  startByte: number,
  body: NodeJS.ReadableStream,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<VideoResource> {
  const headers: Record<string, string> = { "Content-Length": String(size - startByte), "Content-Type": "video/mp4" };
  if (startByte > 0) headers["Content-Range"] = `bytes ${startByte}-${size - 1}/${size}`;
  const response = await fetchImpl(sessionUri, {
    method: "PUT",
    headers,
    body: pullStream(body as Readable),
    duplex: "half",
    redirect: "manual",
    signal,
  } as RequestInit);
  return okJson<VideoResource>("upload", response);
}

export type ErrorClass = "quota" | "channel_limit" | "transient" | "reauth" | "invalid_metadata" | "permanent";

const REASONS: Record<string, ErrorClass> = {
  quotaExceeded: "quota",
  uploadLimitExceeded: "channel_limit",
  rateLimitExceeded: "transient",
  userRateLimitExceeded: "transient",
  invalid_grant: "reauth",
  insufficientPermissions: "reauth",
  youtubeSignupRequired: "reauth",
  invalidTitle: "invalid_metadata",
  invalidDescription: "invalid_metadata",
  invalidTags: "invalid_metadata",
};

/** §4.5 error table, by reason code and status, never by message text. */
export function classify(error: unknown): ErrorClass {
  if (error instanceof GoogleApiError) {
    const byReason = error.reason ? REASONS[error.reason] : undefined;
    if (byReason) return byReason;
    // 308 on the upload PUT is "Resume Incomplete", not a failure: the handler's retry queries the
    // saved session and resumes from its Range offset (§4.5 step 1), same as a network error or 5xx.
    if (error.status === 429 || error.status === 308 || error.status >= 500) return "transient";
    // §4.3: a 401 that survives one token refresh means reconnect; callers refresh before classifying.
    // That only holds for Data API/upload calls. A 401 from the token endpoint itself (e.g.
    // invalid_client from a missing or wrong client secret) is a server misconfiguration, not an
    // expired user token, and must not mark the account reauth_required.
    if (error.status === 401 && !error.tokenEndpoint) return "reauth";
    return "permanent";
  }
  // fetch rejects with a TypeError on network failure, and with AbortError/TimeoutError when cut off.
  if (error instanceof TypeError) return "transient";
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return "transient";
  return isTransientError(error) ? "transient" : "permanent";
}

const PACIFIC = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

/** The Pacific wall-clock reading at `ms`, expressed as if it were UTC. */
function pacificWallClock(ms: number): number {
  const part = Object.fromEntries(PACIFIC.formatToParts(ms).map(({ type, value }) => [type, Number(value)]));
  return Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second);
}

/** When Google's daily quota resets: the next midnight in America/Los_Angeles, across DST. */
export function nextMidnightPacific(now: Date): Date {
  const today = new Date(pacificWallClock(now.getTime()));
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1);
  // US DST switches at 02:00 local, never between UTC midnight and Pacific midnight, so one offset lookup is exact.
  return new Date(midnight - (pacificWallClock(midnight) - midnight));
}
