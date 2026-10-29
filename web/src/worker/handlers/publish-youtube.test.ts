/** @vitest-environment node */
// publish_youtube (design §4.5): claim, checks, Claude metadata, the resumable upload and the error
// table. One fake fetch answers both Anthropic and Google; no real calls.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorResponse, messageResponse } from "../../server/ai/__fixtures__/fake-anthropic";
import { collections } from "../../server/db";
import { encryptSetting } from "../../server/settings";
import { getStorage } from "../../server/storage";
import type { TaskDoc, YoutubeAccountDoc, YoutubePostDoc } from "../../server/types";
import { nextMidnightPacific } from "../../server/youtube/google";
import { claimPost, markUploaded } from "../../server/youtube/posts";
import { FAILURE_HOOKS, runJob } from "../run-job";
import { claimed, clipFixture, fakeEngine, seedTask, setupWorkerTestEnv, writeFile } from "../test-utils";
import { uploadTiming } from "./publish-youtube";

// The real repository, with markUploaded spied so one test can make the database fail after the PUT.
vi.mock("../../server/youtube/posts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/youtube/posts")>();
  return { ...actual, markUploaded: vi.fn(actual.markUploaded) };
});

setupWorkerTestEnv("publish", { env: { ANTHROPIC_API_KEY: "sk-ant-test-key-1234" } });

const USER = "user-1";
const MINUTE = 60_000;
const SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=s1";

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  for (const level of ["warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  // The session URI is a capability URL: like the tokens, it never reaches a log line.
  for (const secret of [SESSION, "upload_id", "access-1", "refresh-1", "fresh-token"]) {
    expect(logs.join("\n")).not.toContain(secret);
  }
});
const FILE = "0123456789";
// The lineage's current clip is a restyled render: its id is not the lineage id.
const CLIP = clipFixture("c1v2", "t1", { lineageId: "c1" });
const METADATA = {
  title: "The habit that doubled my output",
  description: "One small habit, explained.",
  hashtags: ["habits", "productivity"],
  tags: ["habits", "productivity tips"],
  language: "en",
};
const STORED_METADATA = { ...METADATA, model: "claude-sonnet-5" };
const SAVED_SESSION = { sessionUri: SESSION, storageKey: CLIP.storageKey, size: FILE.length, startedAt: new Date() };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const googleError = (status: number, reason: string) =>
  json(status, { error: { code: status, errors: [{ reason, message: "Google's own words, never stored" }] } });
const video = (privacyStatus = "public") => ({ id: "VID", status: { privacyStatus, uploadStatus: "uploaded" } });

type Kind = "claude" | "token" | "initiate" | "query" | "upload";
type Call = { kind: Kind; url: string; headers: Headers; json?: any; bytes?: string }; // eslint-disable-line @typescript-eslint/no-explicit-any
type Responder = (call: Call, index: number) => Response | Promise<Response>;

const DEFAULTS: Record<Kind, Responder> = {
  claude: () => messageResponse(METADATA),
  token: () => json(200, { access_token: "fresh-token", expires_in: 3600 }),
  initiate: () => new Response(null, { status: 200, headers: { Location: SESSION } }),
  query: () => new Response(null, { status: 404 }),
  upload: () => json(200, video()),
};

function kindOf(url: string, headers: Headers): Kind {
  const { pathname, searchParams } = new URL(url);
  if (pathname.endsWith("/v1/messages")) return "claude";
  if (pathname === "/token") return "token";
  if (url === SESSION) return headers.get("content-range")?.startsWith("bytes */") ? "query" : "upload";
  if (pathname === "/upload/youtube/v3/videos" && searchParams.get("uploadType") === "resumable") return "initiate";
  throw new Error(`Unexpected request to ${url}`);
}

/** Anthropic and Google behind one fetch: each kind of request answers from `overrides` or the happy path. */
function services(overrides: Partial<Record<Kind, Responder>> = {}) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init.headers);
    const call: Call = { kind: kindOf(url, headers), url, headers };
    if (typeof init.body === "string") call.json = JSON.parse(init.body);
    // Read the streamed clip to the end, as Google would, so the file is never left open.
    if (init.body instanceof ReadableStream) call.bytes = await new Response(init.body).text();
    const index = calls.filter((c) => c.kind === call.kind).length;
    calls.push(call);
    return (overrides[call.kind] ?? DEFAULTS[call.kind])(call, index);
  }) as typeof globalThis.fetch;
  return { fetch, calls, kinds: () => calls.map((call) => call.kind), of: (kind: Kind) => calls.filter((call) => call.kind === kind) };
}

function postDoc(overrides: Partial<YoutubePostDoc> = {}): YoutubePostDoc {
  const now = new Date();
  return {
    _id: "p1",
    userId: USER,
    taskId: "t1",
    lineageId: "c1",
    channelId: "UC1",
    state: "queued",
    attempts: 0,
    insertCalls: 0,
    insertCap: 3,
    privacy: "public",
    madeForKids: false,
    notifySubscribers: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** The account (unless null), a completed task whose clip of lineage c1 is on disk, and post p1 queued for it. */
async function setup(
  options: { post?: Partial<YoutubePostDoc>; task?: Partial<TaskDoc>; account?: Partial<YoutubeAccountDoc> | null } = {},
) {
  if (options.account !== null) {
    const now = new Date();
    await collections().youtubeAccounts.insertOne({
      _id: USER,
      channelId: "UC1",
      channelTitle: "Mine",
      refreshToken: encryptSetting("refresh-1"),
      accessToken: encryptSetting("access-1"),
      accessTokenExpiresAt: new Date(Date.now() + 60 * MINUTE),
      scopes: [],
      status: "active",
      autoPost: true,
      privacy: "public",
      madeForKids: false,
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
      ...options.account,
    });
  }
  await seedTask({ _id: "t1", userId: USER, status: "completed", progress: 100, clips: [CLIP], ...options.task });
  await writeFile(await getStorage().localPath(CLIP.storageKey), FILE);
  await collections().youtubePosts.insertOne(postDoc(options.post));
}

const publishJob = () =>
  claimed({ type: "publish_youtube", taskId: "t1", userId: USER, activeKey: "youtube:p1", payload: { postId: "p1" } });

async function run(fake: ReturnType<typeof services>) {
  return runJob(await publishJob(), { runEngine: fakeEngine({}).runEngine, fetch: fake.fetch });
}

const storedPost = async (id = "p1") => (await collections().youtubePosts.findOne({ _id: id }))!;
const storedAccount = async () => (await collections().youtubeAccounts.findOne({ _id: USER }))!;

/** `notBefore` is `ms` after some moment of the run that started at `before`. */
function expectWait(notBefore: Date | undefined, ms: number, before: number) {
  expect(notBefore!.getTime()).toBeGreaterThanOrEqual(before + ms);
  expect(notBefore!.getTime()).toBeLessThanOrEqual(Date.now() + ms);
}

describe("publish_youtube", () => {
  it("writes metadata, uploads and records the video", async () => {
    await setup();
    let metadataAtInitiation: unknown;
    const fake = services({
      initiate: async (call, index) => {
        metadataAtInitiation = (await storedPost()).metadata;
        return DEFAULTS.initiate(call, index);
      },
    });

    expect(await run(fake)).toEqual({ status: "succeeded" });

    const post = await storedPost();
    expect(post).toMatchObject({
      state: "uploaded",
      videoId: "VID",
      videoUrl: "https://www.youtube.com/watch?v=VID",
      privacyStatus: "public",
      uploadStatus: "uploaded",
      insertCalls: 1,
      metadata: STORED_METADATA,
    });
    for (const field of ["upload", "claimedBy", "phase", "error", "warning"] as const) expect(post[field]).toBeUndefined();
    expect(metadataAtInitiation).toEqual(STORED_METADATA);
    expect(fake.kinds()).toEqual(["claude", "initiate", "upload"]);

    const [claude] = fake.of("claude");
    expect(claude.json.model).toBe("claude-sonnet-5");
    expect(claude.json.messages[0].content).toContain(
      JSON.stringify({ source_title: "Talk", hook_title: "Hook c1v2", transcript: "words of c1v2" }),
    );
    const [initiate] = fake.of("initiate");
    expect(new URL(initiate.url).searchParams.get("notifySubscribers")).toBe("true");
    expect(initiate.headers.get("authorization")).toBe("Bearer access-1");
    expect(initiate.headers.get("x-upload-content-length")).toBe(String(FILE.length));
    expect(initiate.json).toEqual({
      snippet: {
        title: METADATA.title,
        description: "One small habit, explained.\n\n#habits #productivity",
        tags: METADATA.tags,
        categoryId: "22",
        defaultLanguage: "en",
        defaultAudioLanguage: "en",
      },
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false, containsSyntheticMedia: false },
    });
    const [upload] = fake.of("upload");
    expect(upload.bytes).toBe(FILE);
    expect(upload.headers.has("content-range")).toBe(false);
  });

  it("recovers a completed upload from the saved session without a second insert", async () => {
    await setup({ post: { metadata: STORED_METADATA, insertCalls: 1, upload: SAVED_SESSION } });
    const fake = services({ query: () => json(200, video()) });

    await run(fake);

    expect(fake.kinds()).toEqual(["query"]);
    expect(fake.of("query")[0].headers.get("content-range")).toBe(`bytes */${FILE.length}`);
    expect(await storedPost()).toMatchObject({ state: "uploaded", videoId: "VID", insertCalls: 1 });
  });

  it("resumes from the Range offset after a dropped connection", async () => {
    const sleep = vi.spyOn(uploadTiming, "sleep").mockResolvedValue(undefined);
    await setup({ post: { metadata: STORED_METADATA } });
    const fake = services({
      upload: (_call, index) => (index === 0 ? Promise.reject(new TypeError("fetch failed")) : json(200, video())),
      query: () => new Response(null, { status: 308, headers: { Range: "bytes=0-3" } }),
    });

    await run(fake);

    expect(fake.kinds()).toEqual(["initiate", "upload", "query", "upload"]);
    const resumed = fake.of("upload")[1];
    expect(resumed.headers.get("content-range")).toBe(`bytes 4-9/${FILE.length}`);
    expect(resumed.bytes).toBe("456789");
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000]);
    expect(await storedPost()).toMatchObject({ state: "uploaded", insertCalls: 1 });
  });

  // A session saved for an older render (a restyle changed the file since): queried once with its own size.
  const OLDER_SESSION = { ...SAVED_SESSION, storageKey: "clips/t1/c1.mp4", size: 7 };

  it.each([
    ["is gone", () => new Response(null, { status: 404 })],
    ["is incomplete", () => new Response(null, { status: 308, headers: { Range: "bytes=0-3" } })],
  ] as const)("starts a new session for the current file when an older render's saved session %s", async (_name, query) => {
    await setup({ post: { metadata: STORED_METADATA, insertCalls: 1, upload: OLDER_SESSION } });
    const fake = services({ query });

    await run(fake);

    expect(fake.kinds()).toEqual(["query", "initiate", "upload"]);
    expect(fake.of("query")[0].headers.get("content-range")).toBe("bytes */7");
    // Never resumed: the whole current file goes into the new session.
    const [upload] = fake.of("upload");
    expect(upload.bytes).toBe(FILE);
    expect(upload.headers.has("content-range")).toBe(false);
    expect(await storedPost()).toMatchObject({ state: "uploaded", insertCalls: 2 });
  });

  it("recovers an older render that finished at Google from its saved session, without an insert", async () => {
    await setup({ post: { metadata: STORED_METADATA, insertCalls: 1, upload: OLDER_SESSION } });
    const fake = services({ query: () => json(200, video()) });

    await run(fake);

    expect(fake.kinds()).toEqual(["query"]);
    expect(await storedPost()).toMatchObject({ state: "uploaded", videoId: "VID", insertCalls: 1 });
  });

  it("never initiates while an older render's saved session cannot be read", async () => {
    const sleep = vi.spyOn(uploadTiming, "sleep").mockResolvedValue(undefined);
    await setup({ post: { metadata: STORED_METADATA, insertCalls: 1, upload: OLDER_SESSION } });
    const fake = services({ query: () => Promise.reject(new TypeError("fetch failed")) });

    await run(fake);

    expect(fake.kinds()).toEqual(Array(5).fill("query"));
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000, 8000]);
    const post = await storedPost();
    expect(post).toMatchObject({ state: "queued", waitReason: "retry", attempts: 1, insertCalls: 1 });
    expect(post.upload).toEqual(OLDER_SESSION);
  });

  it.each([404, 410])("starts a new session when the saved one is gone (%i)", async (status) => {
    await setup({ post: { metadata: STORED_METADATA, insertCalls: 1, upload: SAVED_SESSION } });
    const fake = services({ query: () => new Response(null, { status }) });

    await run(fake);

    expect(fake.kinds()).toEqual(["query", "initiate", "upload"]);
    expect(await storedPost()).toMatchObject({ state: "uploaded", insertCalls: 2 });
  });

  it.each([
    ["a rate limit", () => googleError(403, "rateLimitExceeded"), "rateLimitExceeded"],
    ["a 429", () => new Response(null, { status: 429 }), "HTTP 429"],
    ["a 5xx", () => new Response(null, { status: 503 }), "HTTP 503"],
    ["a network error", () => Promise.reject(new TypeError("fetch failed")), "TypeError"],
  ] as const)("a failed session start (%s) goes back to the queue without a second insert", async (_name, initiate, code) => {
    const sleep = vi.spyOn(uploadTiming, "sleep").mockResolvedValue(undefined);
    await setup({ post: { metadata: STORED_METADATA } });
    const fake = services({ initiate });
    const before = Date.now();

    await run(fake);

    expect(fake.kinds()).toEqual(["initiate"]);
    expect(sleep).not.toHaveBeenCalled();
    const post = await storedPost();
    expect(post).toMatchObject({ state: "queued", waitReason: "retry", attempts: 1, insertCalls: 1, error: `YouTube could not be reached (${code}).` });
    expectWait(post.notBefore, MINUTE, before);
  });

  it("a 5xx on the upload is retried in the job on the same session", async () => {
    const sleep = vi.spyOn(uploadTiming, "sleep").mockResolvedValue(undefined);
    await setup({ post: { metadata: STORED_METADATA } });
    const fake = services({
      upload: (_call, index) => (index === 0 ? new Response(null, { status: 503 }) : json(200, video())),
      query: () => new Response(null, { status: 308 }),
    });

    await run(fake);

    expect(fake.kinds()).toEqual(["initiate", "upload", "query", "upload"]);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000]);
    expect(await storedPost()).toMatchObject({ state: "uploaded", insertCalls: 1 });
  });

  it("a rate limit on the upload goes back to the queue, keeping the session", async () => {
    const sleep = vi.spyOn(uploadTiming, "sleep").mockResolvedValue(undefined);
    await setup({ post: { metadata: STORED_METADATA } });
    const fake = services({ upload: () => googleError(403, "userRateLimitExceeded") });

    await run(fake);

    expect(fake.kinds()).toEqual(["initiate", "upload"]);
    expect(sleep).not.toHaveBeenCalled();
    const post = await storedPost();
    expect(post).toMatchObject({ state: "queued", waitReason: "retry", insertCalls: 1, error: "YouTube could not be reached (userRateLimitExceeded)." });
    expect(post.upload?.sessionUri).toBe(SESSION);
  });

  it("never initiates more than the insert cap", async () => {
    await setup({ post: { metadata: STORED_METADATA, insertCalls: 3 } });
    const fake = services();

    await run(fake);

    expect(fake.calls).toEqual([]);
    expect(await storedPost()).toMatchObject({ state: "failed", insertCalls: 3, errorReason: "insertCap" });
  });

  it("quotaExceeded defers every queued post to the next midnight Pacific + 5 min", async () => {
    await setup({ post: { metadata: STORED_METADATA } });
    await collections().youtubePosts.insertOne(postDoc({ _id: "p2", lineageId: "other", userId: "user-2" }));
    const fake = services({ initiate: () => googleError(403, "quotaExceeded") });

    await run(fake);

    const until = new Date(nextMidnightPacific(new Date()).getTime() + 5 * MINUTE);
    const post = await storedPost();
    // Refused with an explicit limit: no session, so no video, can exist, and the call is given back.
    expect(post).toMatchObject({ state: "queued", waitReason: "quota", notBefore: until, attempts: 0, insertCalls: 0 });
    expect(post.error).toContain("quotaExceeded");
    expect(post.error).not.toContain("Google's own words");
    expect(await storedPost("p2")).toMatchObject({ state: "queued", waitReason: "quota", notBefore: until });
    expect(fake.of("initiate")).toHaveLength(1);
  });

  it("uploadLimitExceeded holds every queued post of the channel 6 h, giving the refused call back", async () => {
    await setup({ post: { metadata: STORED_METADATA } });
    await collections().youtubePosts.insertMany([
      postDoc({ _id: "p2", lineageId: "c2", metadata: STORED_METADATA }),
      postDoc({ _id: "p3", lineageId: "c3", metadata: STORED_METADATA }),
      postDoc({ _id: "elsewhere", lineageId: "c4", userId: "user-2", channelId: "UC9" }),
    ]);
    const fake = services({ initiate: () => googleError(400, "uploadLimitExceeded") });
    const before = Date.now();

    await run(fake);
    // The siblings' jobs then find their posts not due: none spends a refused call.
    for (const id of ["p2", "p3"]) {
      const job = await claimed({ type: "publish_youtube", taskId: "t1", userId: USER, activeKey: `youtube:${id}`, payload: { postId: id } });
      expect(await runJob(job, { runEngine: fakeEngine({}).runEngine, fetch: fake.fetch })).toEqual({ status: "cancelled" });
    }

    expect(fake.of("initiate")).toHaveLength(1);
    const post = await storedPost();
    expect(post).toMatchObject({ state: "queued", waitReason: "channel_limit", attempts: 0, insertCalls: 0 });
    expectWait(post.notBefore, 6 * 60 * MINUTE, before);
    for (const id of ["p2", "p3"]) {
      expect(await storedPost(id)).toMatchObject({ state: "queued", waitReason: "channel_limit", notBefore: post.notBefore, insertCalls: 0 });
    }
    const elsewhere = await storedPost("elsewhere");
    expect(elsewhere.waitReason).toBeUndefined();
    expect(elsewhere.notBefore).toBeUndefined();
  });

  it("transient errors back off 1, 5, 15 min, then fail", async () => {
    const sleep = vi.spyOn(uploadTiming, "sleep").mockResolvedValue(undefined);
    await setup({ post: { metadata: STORED_METADATA } });
    const fake = services({ upload: () => new Response(null, { status: 503 }), query: () => new Response(null, { status: 308 }) });

    for (const [attempt, minutes] of [1, 5, 15].entries()) {
      const before = Date.now();
      await run(fake);
      const post = await storedPost();
      expect(post).toMatchObject({ state: "queued", waitReason: "retry", attempts: attempt + 1 });
      expectWait(post.notBefore, minutes * MINUTE, before);
      await collections().youtubePosts.updateOne({ _id: "p1" }, { $set: { notBefore: new Date(0) } });
    }
    await run(fake);

    expect(await storedPost()).toMatchObject({ state: "failed", attempts: 3, insertCalls: 1, errorReason: "HTTP 503" });
    // Five tries per job, 1/2/4/8 s apart; every retry resumes the saved session instead of a new insert.
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(Array(4).fill([1000, 2000, 4000, 8000]).flat());
    expect(fake.of("initiate")).toHaveLength(1);
    expect(fake.of("upload")).toHaveLength(20);
  });

  it("invalid_grant blocks the post and marks the account reauth_required", async () => {
    await setup({ account: { accessTokenExpiresAt: new Date(Date.now() - 1000) } });
    const fake = services({ token: () => json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }) });

    await run(fake);

    expect(fake.kinds()).toEqual(["claude", "token"]);
    const post = await storedPost();
    expect(post).toMatchObject({ state: "blocked", waitReason: "reconnect", insertCalls: 0 });
    expect(post.error).toContain("invalid_grant");
    expect(post.error).not.toContain("expired or revoked");
    expect((await storedAccount()).status).toBe("reauth_required");
  });

  it("a revoked grant after a disconnect mid-run cancels the post instead of waiting for a reconnect", async () => {
    await setup({ account: { accessTokenExpiresAt: new Date(Date.now() - 1000) } });
    const fake = services({
      // The user disconnects while Claude writes the metadata: the account doc goes, the grant is revoked.
      claude: async (call, index) => {
        await collections().youtubeAccounts.deleteOne({ _id: USER });
        return DEFAULTS.claude(call, index);
      },
      token: () => json(400, { error: "invalid_grant" }),
    });

    await run(fake);

    expect(fake.kinds()).toEqual(["claude", "token"]);
    expect(await storedPost()).toMatchObject({ state: "cancelled", error: "YouTube account was disconnected.", insertCalls: 0 });
  });

  it("a refused OAuth client is worded as the server's configuration, not the clip's upload", async () => {
    await setup({ post: { metadata: STORED_METADATA }, account: { accessTokenExpiresAt: new Date(Date.now() - 1000) } });
    const fake = services({ token: () => json(401, { error: "invalid_client", error_description: "The OAuth client was not found." }) });

    await run(fake);

    expect(fake.kinds()).toEqual(["token"]);
    expect(await storedPost()).toMatchObject({
      state: "failed",
      errorReason: "invalid_client",
      insertCalls: 0,
      error: "Google rejected the server's OAuth client (invalid_client). Check GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.",
    });
    expect((await storedAccount()).status).toBe("active");
  });

  it("a 401 refreshes the token once and retries", async () => {
    await setup({ post: { metadata: STORED_METADATA } });
    const fake = services({ initiate: (call, index) => (index === 0 ? googleError(401, "authError") : DEFAULTS.initiate(call, index)) });

    await run(fake);

    expect(fake.kinds()).toEqual(["initiate", "token", "initiate", "upload"]);
    expect(fake.of("initiate")[1].headers.get("authorization")).toBe("Bearer fresh-token");
    expect(await storedPost()).toMatchObject({ state: "uploaded" });
    expect((await storedAccount()).status).toBe("active");
  });

  it("a 401 that survives the refresh blocks the post and marks the account reauth_required", async () => {
    await setup({ post: { metadata: STORED_METADATA } });
    const fake = services({ initiate: () => googleError(401, "authError") });

    await run(fake);

    expect(fake.kinds()).toEqual(["initiate", "token", "initiate"]);
    expect(await storedPost()).toMatchObject({ state: "blocked", waitReason: "reconnect" });
    expect((await storedAccount()).status).toBe("reauth_required");
  });

  it("later session starts in the job reuse the token a 401 refreshed", async () => {
    await setup({ post: { metadata: STORED_METADATA } });
    const fake = services({
      initiate: (call, index) =>
        index === 0 ? googleError(401, "authError") : index === 1 ? googleError(400, "invalidTitle") : DEFAULTS.initiate(call, index),
    });

    await run(fake);

    expect(fake.kinds()).toEqual(["initiate", "token", "initiate", "claude", "initiate", "upload"]);
    expect(fake.of("initiate")[2].headers.get("authorization")).toBe("Bearer fresh-token");
    expect(await storedPost()).toMatchObject({ state: "uploaded", insertCalls: 3 });
  });

  it.each([
    ["the saved session's query", { query: () => new Response(null, { status: 401 }) }, { upload: SAVED_SESSION, insertCalls: 1 }, ["query"]],
    ["an older render's saved session", { query: () => new Response(null, { status: 401 }) }, { upload: OLDER_SESSION, insertCalls: 1 }, ["query"]],
    ["the upload", { upload: () => new Response(null, { status: 401 }) }, {}, ["initiate", "upload"]],
  ] as const)("a 401 from %s fails the post without a refresh or a reconnect", async (_name, overrides, post, kinds) => {
    await setup({ post: { metadata: STORED_METADATA, ...post } });
    const fake = services(overrides);

    await run(fake);

    expect(fake.kinds()).toEqual(kinds);
    const stored = await storedPost();
    expect(stored).toMatchObject({ state: "failed", errorReason: "HTTP 401", insertCalls: 1 });
    // Kept, so a manual "Try again" asks this session before spending another insert call.
    expect(stored.upload?.sessionUri).toBe(SESSION);
    expect((await storedAccount()).status).toBe("active");
  });

  it("a database error after the upload re-queues the post, and the next run recovers the video from the session", async () => {
    await setup({ post: { metadata: STORED_METADATA } });
    vi.mocked(markUploaded).mockRejectedValueOnce(Object.assign(new Error("connection reset"), { name: "MongoNetworkError" }));
    const fake = services({ query: () => json(200, video()) });

    expect(await run(fake)).toMatchObject({ status: "failed" });
    const requeued = await storedPost();
    expect(requeued).toMatchObject({ state: "queued", waitReason: "retry", attempts: 1, insertCalls: 1 });
    expect(requeued.upload?.sessionUri).toBe(SESSION);

    await collections().youtubePosts.updateOne({ _id: "p1" }, { $set: { notBefore: new Date(0) } });
    await run(fake);

    expect(fake.kinds()).toEqual(["initiate", "upload", "query"]);
    expect(await storedPost()).toMatchObject({ state: "uploaded", videoId: "VID", insertCalls: 1 });
  });

  it("invalidTitle clears metadata and retries once, then fails", async () => {
    await setup();
    const fake = services({ initiate: () => googleError(400, "invalidTitle") });

    await run(fake);

    expect(fake.kinds()).toEqual(["claude", "initiate", "claude", "initiate"]);
    const post = await storedPost();
    expect(post).toMatchObject({ state: "failed", errorReason: "invalidTitle", insertCalls: 2 });
    expect(post.metadata).toBeUndefined();
  });

  it("a returned private status trips the circuit breaker", async () => {
    await setup({ post: { metadata: STORED_METADATA } });
    await collections().youtubePosts.insertOne(postDoc({ _id: "p2", lineageId: "c2" }));
    const fake = services({ upload: () => json(200, video("private")) });

    await run(fake);

    expect(await storedPost()).toMatchObject({ state: "uploaded", privacyStatus: "private", warning: "private_lock" });
    expect(await storedAccount()).toMatchObject({ status: "paused", warning: "private_lock" });
    expect(await storedPost("p2")).toMatchObject({ state: "blocked", waitReason: "private_lock" });
  });

  it.each([
    ["the account is gone", null, { state: "cancelled", error: "YouTube account was disconnected." }],
    ["the account needs a reconnect", { status: "reauth_required" }, { state: "blocked", waitReason: "reconnect" }],
    ["the private lock is set", { status: "active", warning: "private_lock" }, { state: "blocked", waitReason: "private_lock" }],
    ["the lock is set on a reauth_required account", { status: "reauth_required", warning: "private_lock" }, { state: "blocked", waitReason: "private_lock" }],
    ["the account is paused", { status: "paused" }, { state: "blocked", waitReason: "private_lock" }],
    ["a different channel is connected", { channelId: "UC2" }, { state: "cancelled", error: "Not posted: a different channel was connected." }],
    ["auto-post was turned off", { autoPost: false }, { state: "cancelled", error: "Auto-post was turned off." }],
  ] as const)("does not upload when %s", async (_name, account, expected) => {
    await setup({ account: account as Partial<YoutubeAccountDoc> | null });
    const fake = services();

    await run(fake);

    expect(fake.calls).toEqual([]);
    expect(await storedPost()).toMatchObject(expected);
  });

  it("cancels when the clip's lineage is gone", async () => {
    await setup({ task: { clips: [clipFixture("c2", "t1")] } });
    const fake = services();

    await run(fake);

    expect(fake.calls).toEqual([]);
    expect(await storedPost()).toMatchObject({ state: "cancelled", error: expect.any(String) });
  });

  it("fails when the clip file is missing", async () => {
    await setup();
    await getStorage().delete(CLIP.storageKey);
    const fake = services();

    await run(fake);

    expect(fake.calls).toEqual([]);
    expect(await storedPost()).toMatchObject({ state: "failed" });
  });

  it("defers 2 min while a restyle is processing", async () => {
    await setup({ task: { status: "processing" } });
    const fake = services();
    const before = Date.now();

    await run(fake);

    expect(fake.calls).toEqual([]);
    const post = await storedPost();
    expect(post).toMatchObject({ state: "queued", waitReason: "restyle", attempts: 0 });
    expectWait(post.notBefore, 2 * MINUTE, before);
  });

  it("does not re-ask Claude when metadata is stored", async () => {
    await setup({ post: { metadata: { ...STORED_METADATA, title: "Stored title" } } });
    const fake = services();

    await run(fake);

    expect(fake.kinds()).toEqual(["initiate", "upload"]);
    expect(fake.of("initiate")[0].json.snippet.title).toBe("Stored title");
    expect(await storedPost()).toMatchObject({ state: "uploaded" });
  });

  it("Claude failure defers without uploading anything", async () => {
    await setup();
    const fake = services({ claude: () => errorResponse(400, "bad request") });
    const before = Date.now();

    await run(fake);

    expect(fake.kinds()).toEqual(["claude"]);
    const post = await storedPost();
    expect(post).toMatchObject({ state: "queued", waitReason: "retry", attempts: 1, insertCalls: 0 });
    expect(post.metadata).toBeUndefined();
    expectWait(post.notBefore, MINUTE, before);
  });

  it("does nothing for a post it cannot claim", async () => {
    await setup({ post: { state: "cancelled" } });
    const fake = services();

    expect(await run(fake)).toEqual({ status: "cancelled" });
    expect(fake.calls).toEqual([]);
    expect(await storedPost()).toMatchObject({ state: "cancelled" });
  });

  it("the failure hook defers the post 2 min while it has attempts left, else fails it", async () => {
    await setup();
    const job = await publishJob();
    await claimPost("p1", job._id);
    const before = Date.now();

    await FAILURE_HOOKS.publish_youtube(job);
    const deferred = await storedPost();
    expect(deferred).toMatchObject({ state: "queued", waitReason: "retry", attempts: 1 });
    expectWait(deferred.notBefore, 2 * MINUTE, before);

    await collections().youtubePosts.updateOne({ _id: "p1" }, { $set: { state: "working", claimedBy: job._id, attempts: 3 } });
    await FAILURE_HOOKS.publish_youtube(job);
    expect(await storedPost()).toMatchObject({ state: "failed" });

    // A post another job holds is left alone.
    await collections().youtubePosts.updateOne({ _id: "p1" }, { $set: { state: "working", claimedBy: "other-job", attempts: 0 } });
    await FAILURE_HOOKS.publish_youtube(job);
    expect(await storedPost()).toMatchObject({ state: "working", claimedBy: "other-job" });
  });
});
