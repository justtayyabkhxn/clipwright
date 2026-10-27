/** @vitest-environment node */
// Google OAuth, Data API and resumable upload client (design §4.3, §4.5, §4.6). Fake fetch; no
// real Google calls.

import { Readable } from "node:stream";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetEnv } from "../env";
import {
  classify,
  exchangeCode,
  GoogleApiError,
  googleUrls,
  listVideoStatus,
  nextMidnightPacific,
  querySession,
  startUploadSession,
  uploadFrom,
  type VideoInsertBody,
} from "./google";

const baseEnv = { ...process.env };

function useEnv(extra: Record<string, string> = {}) {
  process.env = {
    ...baseEnv,
    MONGODB_URI: "mongodb://127.0.0.1:1/unused",
    BETTER_AUTH_SECRET: "s".repeat(32),
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
  };
  delete process.env.GOOGLE_BASE_URL_OVERRIDE;
  Object.assign(process.env, extra);
  resetEnv();
}

beforeEach(() => useEnv());
afterAll(() => {
  process.env = baseEnv;
  resetEnv();
});

type Recorded = { url: string; init: RequestInit; headers: Headers };

function fakeFetch(...responses: Response[]) {
  const requests: Recorded[] = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(url), init, headers: new Headers(init.headers) });
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const apiError = (status: number, reason: string) =>
  new GoogleApiError("test call", status, reason);

const BODY: VideoInsertBody = {
  snippet: {
    title: "Why index funds beat stock picking",
    description: "A short breakdown.\n\n#investing #indexfunds",
    tags: ["index funds", "passive investing"],
    categoryId: "22",
    defaultLanguage: "en",
    defaultAudioLanguage: "en",
  },
  status: { privacyStatus: "public", selfDeclaredMadeForKids: false, containsSyntheticMedia: false },
};
const SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=abc";
const VIDEO = { id: "VID", status: { privacyStatus: "public", uploadStatus: "uploaded" } };

describe("resumable upload", () => {
  it("starts a resumable session with the exact body", async () => {
    const fake = fakeFetch(new Response(null, { status: 200, headers: { Location: SESSION } }));

    const uri = await startUploadSession("access-1", BODY, 2000, false, fake.fetchImpl);

    expect(uri).toBe(SESSION);
    const [request] = fake.requests;
    expect(request.init.method).toBe("POST");
    expect(request.url).toBe(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=false",
    );
    expect(request.headers.get("authorization")).toBe("Bearer access-1");
    expect(request.headers.get("x-upload-content-length")).toBe("2000");
    expect(request.headers.get("x-upload-content-type")).toBe("video/mp4");
    expect(JSON.parse(String(request.init.body))).toEqual(BODY);
  });

  it("querySession maps 200/201, 308 with and without Range, and 404/410", async () => {
    const fake = fakeFetch(
      json(VIDEO, 200),
      json(VIDEO, 201),
      new Response(null, { status: 308, headers: { Range: "bytes=0-999" } }),
      new Response(null, { status: 308 }),
      new Response(null, { status: 404 }),
      new Response(null, { status: 410 }),
    );
    const query = () => querySession(SESSION, 2000, fake.fetchImpl);

    expect(await query()).toEqual({ done: VIDEO });
    expect(await query()).toEqual({ done: VIDEO });
    expect(await query()).toEqual({ nextByte: 1000 });
    expect(await query()).toEqual({ nextByte: 0 });
    expect(await query()).toEqual({ gone: true });
    expect(await query()).toEqual({ gone: true });

    const [request] = fake.requests;
    expect(request.url).toBe(SESSION);
    expect(request.init.method).toBe("PUT");
    expect(request.headers.get("content-length")).toBe("0");
    expect(request.headers.get("content-range")).toBe("bytes */2000");
  });

  it("uploadFrom sends Content-Range for a resumed upload", async () => {
    const fake = fakeFetch(json(VIDEO, 200), json(VIDEO, 201));
    const signal = new AbortController().signal;

    const resumed = await uploadFrom(SESSION, 2000, 1000, Readable.from([Buffer.alloc(1000, 1)]), signal, fake.fetchImpl);
    await uploadFrom(SESSION, 2000, 0, Readable.from([Buffer.alloc(2000, 1)]), signal, fake.fetchImpl);

    expect(resumed).toEqual(VIDEO);
    const [first, second] = fake.requests;
    expect(first.url).toBe(SESSION);
    expect(first.init.method).toBe("PUT");
    expect(first.init.signal).toBe(signal);
    expect((first.init as { duplex?: string }).duplex).toBe("half");
    expect(first.headers.get("content-length")).toBe("1000");
    expect(first.headers.get("content-range")).toBe("bytes 1000-1999/2000");
    expect(first.headers.get("content-type")).toBe("video/mp4");
    const sent = Buffer.from(await new Response(first.init.body as ReadableStream).arrayBuffer());
    expect(sent.length).toBe(1000);
    expect(second.headers.get("content-length")).toBe("2000");
    expect(second.headers.has("content-range")).toBe(false);
  });

  it("uploadFrom raises the Data API reason", async () => {
    const fake = fakeFetch(json({ error: { code: 403, errors: [{ reason: "quotaExceeded", message: "quota" }] } }, 403));
    const error = await uploadFrom(SESSION, 10, 0, Readable.from([Buffer.alloc(10)]), new AbortController().signal, fake.fetchImpl).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GoogleApiError);
    expect(error).toMatchObject({ status: 403, reason: "quotaExceeded" });
  });
});

describe("errors", () => {
  it("classify maps reasons", () => {
    expect(classify(apiError(403, "quotaExceeded"))).toBe("quota");
    expect(classify(apiError(400, "uploadLimitExceeded"))).toBe("channel_limit");
    expect(classify(apiError(403, "rateLimitExceeded"))).toBe("transient");
    expect(classify(apiError(403, "userRateLimitExceeded"))).toBe("transient");
    expect(classify(new GoogleApiError("test call", 503))).toBe("transient");
    expect(classify(new GoogleApiError("test call", 429))).toBe("transient");
    expect(classify(apiError(400, "invalid_grant"))).toBe("reauth");
    expect(classify(apiError(403, "insufficientPermissions"))).toBe("reauth");
    expect(classify(apiError(401, "youtubeSignupRequired"))).toBe("reauth");
    expect(classify(apiError(400, "invalidTitle"))).toBe("invalid_metadata");
    expect(classify(apiError(400, "invalidDescription"))).toBe("invalid_metadata");
    expect(classify(apiError(400, "invalidTags"))).toBe("invalid_metadata");
    expect(classify(apiError(403, "forbiddenPrivacySetting"))).toBe("permanent");
    expect(classify(new GoogleApiError("test call", 400))).toBe("permanent");
    expect(classify(new DOMException("aborted", "AbortError"))).toBe("transient");
    expect(classify(new TypeError("fetch failed"))).toBe("transient");
    expect(classify(new Error("something else"))).toBe("permanent");
  });

  it("GoogleApiError messages never include tokens or bodies", async () => {
    const fake = fakeFetch(json({ error: "invalid_grant", error_description: "Bad code secret-token" }, 400));

    const error = await exchangeCode("secret-token", "verifier", "http://localhost:3000/cb", fake.fetchImpl).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GoogleApiError);
    expect(error).toMatchObject({ status: 400, reason: "invalid_grant" });
    const message = (error as Error).message;
    expect(message).not.toContain("secret-token");
    expect(message).not.toContain("http");
    expect(message).not.toContain("Bad code");
  });
});

describe("OAuth and Data API", () => {
  it("exchangeCode sends the PKCE verifier and returns the granted scopes", async () => {
    const fake = fakeFetch(
      json({
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3599,
        scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
        token_type: "Bearer",
      }),
    );
    const before = Date.now();

    const tokens = await exchangeCode("code-1", "verifier-1", "http://localhost:3000/api/youtube/callback", fake.fetchImpl);

    expect(tokens).toMatchObject({
      accessToken: "at",
      refreshToken: "rt",
      scopes: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"],
    });
    expect(tokens.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3599_000);
    const [request] = fake.requests;
    expect(request.url).toBe("https://oauth2.googleapis.com/token");
    expect(Object.fromEntries(new URLSearchParams(String(request.init.body)))).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      code_verifier: "verifier-1",
      redirect_uri: "http://localhost:3000/api/youtube/callback",
      client_id: "client-id",
      client_secret: "client-secret",
    });
  });

  it("listVideoStatus batches ids by 50", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `v${i}`);
    const fake = fakeFetch(
      json({ items: [{ id: "v0", status: { privacyStatus: "public", uploadStatus: "processed" } }] }),
      json({ items: [{ id: "v50", status: { privacyStatus: "private", uploadStatus: "rejected", rejectionReason: "duplicate" } }] }),
    );

    const statuses = await listVideoStatus("at", ids, fake.fetchImpl);

    expect(fake.requests).toHaveLength(2);
    expect(new URL(fake.requests[0].url).searchParams.get("id")?.split(",")).toEqual(ids.slice(0, 50));
    expect(new URL(fake.requests[1].url).searchParams.get("id")).toBe("v50");
    expect(statuses.get("v0")).toEqual({ privacyStatus: "public", uploadStatus: "processed" });
    expect(statuses.get("v50")).toEqual({ privacyStatus: "private", uploadStatus: "rejected", rejectionReason: "duplicate" });
  });
});

describe("nextMidnightPacific", () => {
  it("handles both DST transitions", () => {
    const next = (iso: string) => nextMidnightPacific(new Date(iso)).toISOString();
    expect(next("2026-03-08T09:30:00Z")).toBe("2026-03-09T07:00:00.000Z");
    expect(next("2026-11-01T06:30:00Z")).toBe("2026-11-01T07:00:00.000Z");
    expect(next("2026-11-01T08:30:00Z")).toBe("2026-11-02T08:00:00.000Z");
  });
});

describe("googleUrls", () => {
  it("GOOGLE_BASE_URL_OVERRIDE replaces every Google origin", async () => {
    expect(googleUrls()).toEqual({
      authorize: "https://accounts.google.com/o/oauth2/v2/auth",
      token: "https://oauth2.googleapis.com/token",
      revoke: "https://oauth2.googleapis.com/revoke",
      api: "https://www.googleapis.com/youtube/v3",
      upload: "https://www.googleapis.com/upload/youtube/v3",
    });

    useEnv({ GOOGLE_BASE_URL_OVERRIDE: "http://127.0.0.1:4010" });
    const urls = googleUrls();
    for (const url of Object.values(urls)) expect(url.startsWith("http://127.0.0.1:4010/")).toBe(true);
    expect(urls.upload).toBe("http://127.0.0.1:4010/upload/youtube/v3");

    const fake = fakeFetch(new Response(null, { status: 200, headers: { Location: SESSION } }));
    await startUploadSession("at", BODY, 1, true, fake.fetchImpl);
    expect(fake.requests[0].url).toBe(
      "http://127.0.0.1:4010/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=true",
    );
  });
});
