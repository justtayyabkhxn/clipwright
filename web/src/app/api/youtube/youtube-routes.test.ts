/** @vitest-environment node */
// YouTube auto-post connection routes (design §4.3): connect, callback, account, account/resume.
// Real Better Auth sessions on a standalone mongod, msw for Google.

import { MongoMemoryServer } from "mongodb-memory-server";
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { server as mockServer } from "@/test/setup";
import { getAuth } from "@/server/auth";
import { closeDb, collections, ensureIndexes } from "@/server/db";
import { resetEnv } from "@/server/env";
import { decryptSetting } from "@/server/settings";
import type { YoutubePostDoc } from "@/server/types";

import * as connectRoute from "./connect/route";
import * as callbackRoute from "./callback/route";
import * as accountRoute from "./account/route";
import * as resumeRoute from "./account/resume/route";

let mongod: MongoMemoryServer;
const baseEnv = { ...process.env };
const users: Record<"alice" | "bob", { id: string; cookie: string }> = {} as never;

async function signUp(name: "alice" | "bob") {
  const response = await getAuth().api.signUpEmail({
    body: { email: `${name}@example.com`, password: "correct horse battery", name },
    asResponse: true,
  });
  const { user } = (await response.json()) as { user: { id: string } };
  users[name] = { id: user.id, cookie: response.headers.get("set-cookie")!.split(";")[0] };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env = {
    ...baseEnv,
    MONGODB_URI: mongod.getUri(),
    MONGODB_DB: "youtube_routes",
    MONGODB_TRANSACTIONS: "false",
    BETTER_AUTH_SECRET: "a-very-long-test-secret-for-yt-routes-01",
    BETTER_AUTH_URL: "http://localhost:3000",
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
  };
  resetEnv();
  await ensureIndexes();
  await signUp("alice");
  await signUp("bob");
}, 60_000);

afterAll(async () => {
  await closeDb();
  await mongod.stop();
  process.env = baseEnv;
  resetEnv();
});

beforeEach(async () => {
  const { youtubeAccounts, youtubePosts, oauthStates, jobs } = collections();
  await Promise.all([youtubeAccounts.deleteMany({}), youtubePosts.deleteMany({}), oauthStates.deleteMany({}), jobs.deleteMany({})]);
});

type Handler = (request: Request) => Promise<Response>;

function call(
  handler: unknown,
  url: string,
  init: { method?: string; as?: "alice" | "bob" | null; body?: unknown } = {},
) {
  const { method = "GET", as = "alice", body } = init;
  const request = new Request(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...(as && { cookie: users[as].cookie }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (handler as Handler)(request);
}

const BOTH_SCOPES = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";
const CHANNEL = {
  items: [{ id: "UC1", snippet: { title: "My Channel", customUrl: "@mychannel", thumbnails: { default: { url: "https://img/t.jpg" } } } }],
};

function mockTokenExchange(scope = BOTH_SCOPES) {
  mockServer.use(
    http.post("https://oauth2.googleapis.com/token", () =>
      HttpResponse.json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope }),
    ),
  );
}

function mockChannel(body: { items: unknown[] } = CHANNEL) {
  mockServer.use(http.get("https://www.googleapis.com/youtube/v3/channels", () => HttpResponse.json(body)));
}

/** Starts a connect flow for `as` and returns the `state` from the authorize URL. */
async function startConnect(as: "alice" | "bob" = "alice"): Promise<string> {
  const response = await call(connectRoute.POST, "/api/youtube/connect", { method: "POST", as });
  const { authorize_url } = (await response.json()) as { authorize_url: string };
  return new URL(authorize_url).searchParams.get("state")!;
}

function locationQuery(response: Response): URLSearchParams {
  const location = response.headers.get("location");
  if (!location) throw new Error("expected a redirect");
  return new URL(location).searchParams;
}

describe("POST /api/youtube/connect", () => {
  it("requires a session", async () => {
    const response = await call(connectRoute.POST, "/api/youtube/connect", { method: "POST", as: null });
    expect(response.status).toBe(401);
  });

  it("returns an authorize URL with the exact OAuth parameters", async () => {
    const response = await call(connectRoute.POST, "/api/youtube/connect", { method: "POST" });
    expect(response.status).toBe(200);
    const { authorize_url } = (await response.json()) as { authorize_url: string };
    const url = new URL(authorize_url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(BOTH_SCOPES);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/youtube/callback");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("code_challenge")).toBeTruthy();

    // The state really is usable: it decodes to a stored, user-bound PKCE verifier.
    const doc = await collections().oauthStates.findOne({ _id: url.searchParams.get("state")! });
    expect(doc?.userId).toBe(users.alice.id);
  });

  it("returns 409 not_configured when client env vars are missing", async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "";
    resetEnv();
    try {
      const response = await call(connectRoute.POST, "/api/youtube/connect", { method: "POST" });
      expect(response.status).toBe(409);
      const body = (await response.json()) as { detail: { code: string } };
      expect(body.detail.code).toBe("not_configured");
    } finally {
      process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
      process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
      resetEnv();
    }
  });
});

describe("GET /api/youtube/callback", () => {
  it("stores the channel and redirects to /settings?youtube=connected", async () => {
    const state = await startConnect("alice");
    mockTokenExchange();
    mockChannel();

    const response = await call(callbackRoute.GET, `/api/youtube/callback?code=abc&state=${state}`);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:3000/settings?youtube=connected");
    const account = await collections().youtubeAccounts.findOne({ _id: users.alice.id });
    expect(account?.channelId).toBe("UC1");
    expect(decryptSetting(account!.refreshToken)).toBe("rt-1");
  });

  it("rejects a callback that is missing a scope, and stores no account", async () => {
    const state = await startConnect("alice");
    mockTokenExchange("https://www.googleapis.com/auth/youtube.upload"); // readonly missing
    mockChannel();

    const response = await call(callbackRoute.GET, `/api/youtube/callback?code=abc&state=${state}`);

    expect(locationQuery(response).get("youtube_error")).toBe("missing_scope");
    expect(await collections().youtubeAccounts.findOne({ _id: users.alice.id })).toBeNull();
  });

  it("reports an account without a channel", async () => {
    const state = await startConnect("alice");
    mockTokenExchange();
    mockChannel({ items: [] });

    const response = await call(callbackRoute.GET, `/api/youtube/callback?code=abc&state=${state}`);

    expect(locationQuery(response).get("youtube_error")).toBe("no_channel");
    expect(await collections().youtubeAccounts.findOne({ _id: users.alice.id })).toBeNull();
  });

  it("redirects expired for a reused state", async () => {
    const state = await startConnect("alice");
    mockTokenExchange();
    mockChannel();
    await call(callbackRoute.GET, `/api/youtube/callback?code=abc&state=${state}`); // consumes it

    const response = await call(callbackRoute.GET, `/api/youtube/callback?code=abc&state=${state}`);

    expect(locationQuery(response).get("youtube_error")).toBe("expired");
  });

  it("redirects expired for a foreign state (started by another user)", async () => {
    const state = await startConnect("bob");

    const response = await call(callbackRoute.GET, `/api/youtube/callback?code=abc&state=${state}`, { as: "alice" });

    expect(locationQuery(response).get("youtube_error")).toBe("expired");
  });

  it("never echoes Google's own error text", async () => {
    const response = await call(
      callbackRoute.GET,
      "/api/youtube/callback?error=access_denied&error_description=The+user+denied+the+request",
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("location")!;
    expect(location).toBe("http://localhost:3000/settings?youtube_error=denied");
    expect(location).not.toContain("access_denied");
    expect(location).not.toContain("denied+the+request");
  });

  it("on a channel change, cancels the user's queued and blocked posts with the channel-change error", async () => {
    // First connection: channel A.
    let state = await startConnect("alice");
    mockTokenExchange();
    mockChannel({ items: [{ id: "UC-A", snippet: { title: "Channel A" } }] });
    await call(callbackRoute.GET, `/api/youtube/callback?code=abc&state=${state}`);

    const post: YoutubePostDoc = {
      _id: "post-1",
      userId: users.alice.id,
      taskId: "task-1",
      lineageId: "clip-1",
      channelId: "UC-A",
      state: "queued",
      attempts: 0,
      insertCalls: 0,
      insertCap: 3,
      privacy: "public",
      madeForKids: false,
      notifySubscribers: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await collections().youtubePosts.insertOne(post);

    // Reconnect with a different channel B.
    state = await startConnect("alice");
    mockTokenExchange();
    mockChannel({ items: [{ id: "UC-B", snippet: { title: "Channel B" } }] });
    const response = await call(callbackRoute.GET, `/api/youtube/callback?code=abc&state=${state}`);

    expect(locationQuery(response).has("youtube_error")).toBe(false);
    const cancelled = await collections().youtubePosts.findOne({ _id: "post-1" });
    expect(cancelled?.state).toBe("cancelled");
    expect(cancelled?.error).toBe("Not posted: a different channel was connected.");
  });

  it("on a same-channel reconnect, unblocks posts (but not the private-lock ones)", async () => {
    let state = await startConnect("alice");
    mockTokenExchange();
    mockChannel();
    await call(callbackRoute.GET, `/api/youtube/callback?code=abc&state=${state}`);

    const base: Omit<YoutubePostDoc, "_id" | "lineageId" | "waitReason"> = {
      userId: users.alice.id,
      taskId: "task-1",
      channelId: "UC1",
      state: "blocked",
      attempts: 0,
      insertCalls: 0,
      insertCap: 3,
      privacy: "public",
      madeForKids: false,
      notifySubscribers: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await collections().youtubePosts.insertMany([
      { ...base, _id: "post-reconnect", lineageId: "clip-r", waitReason: "reconnect" },
      { ...base, _id: "post-locked", lineageId: "clip-l", waitReason: "private_lock" },
    ]);

    state = await startConnect("alice");
    mockTokenExchange();
    mockChannel();
    await call(callbackRoute.GET, `/api/youtube/callback?code=abc&state=${state}`);

    expect((await collections().youtubePosts.findOne({ _id: "post-reconnect" }))?.state).toBe("queued");
    expect((await collections().youtubePosts.findOne({ _id: "post-locked" }))?.state).toBe("blocked");
  });
});

describe("GET/PATCH/DELETE /api/youtube/account", () => {
  async function connectAlice() {
    const state = await startConnect("alice");
    mockTokenExchange();
    mockChannel();
    await call(callbackRoute.GET, `/api/youtube/callback?code=abc&state=${state}`);
  }

  it("GET hides tokens", async () => {
    await connectAlice();
    const response = await call(accountRoute.GET, "/api/youtube/account");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ connected: true, channel: { id: "UC1" }, auto_post: true, privacy: "public", made_for_kids: false });
    const text = JSON.stringify(body);
    expect(text).not.toContain("rt-1");
    expect(text).not.toContain("at-1");
  });

  it("PATCH updates prefs, and turning auto_post off cancels queued posts", async () => {
    await connectAlice();
    const post: YoutubePostDoc = {
      _id: "post-1",
      userId: users.alice.id,
      taskId: "task-1",
      lineageId: "clip-1",
      channelId: "UC1",
      state: "queued",
      attempts: 0,
      insertCalls: 0,
      insertCap: 3,
      privacy: "public",
      madeForKids: false,
      notifySubscribers: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await collections().youtubePosts.insertOne(post);

    const response = await call(accountRoute.PATCH, "/api/youtube/account", {
      method: "PATCH",
      body: { auto_post: false, privacy: "unlisted" },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ auto_post: false, privacy: "unlisted" });
    const cancelled = await collections().youtubePosts.findOne({ _id: "post-1" });
    expect(cancelled?.state).toBe("cancelled");
  });

  it("PATCH rejects an invalid privacy value", async () => {
    await connectAlice();
    const response = await call(accountRoute.PATCH, "/api/youtube/account", { method: "PATCH", body: { privacy: "secret" } });
    expect(response.status).toBe(400);
  });

  it("DELETE disconnects and cancels queued and blocked posts", async () => {
    await connectAlice();
    mockServer.use(http.post("https://oauth2.googleapis.com/revoke", () => new HttpResponse(null, { status: 200 })));
    const base: Omit<YoutubePostDoc, "_id" | "lineageId" | "state"> = {
      userId: users.alice.id,
      taskId: "task-1",
      channelId: "UC1",
      attempts: 0,
      insertCalls: 0,
      insertCap: 3,
      privacy: "public",
      madeForKids: false,
      notifySubscribers: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await collections().youtubePosts.insertMany([
      { ...base, _id: "post-q", lineageId: "clip-q", state: "queued" },
      { ...base, _id: "post-b", lineageId: "clip-b", state: "blocked" },
    ]);

    const response = await call(accountRoute.DELETE, "/api/youtube/account", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await collections().youtubeAccounts.findOne({ _id: users.alice.id })).toBeNull();
    expect((await collections().youtubePosts.findOne({ _id: "post-q" }))?.state).toBe("cancelled");
    expect((await collections().youtubePosts.findOne({ _id: "post-b" }))?.state).toBe("cancelled");
  });
});

describe("POST /api/youtube/account/resume", () => {
  it("sets the account active and requeues private_lock posts", async () => {
    const state = await startConnect("alice");
    mockTokenExchange();
    mockChannel();
    await call(callbackRoute.GET, `/api/youtube/callback?code=abc&state=${state}`);
    await collections().youtubeAccounts.updateOne({ _id: users.alice.id }, { $set: { status: "paused", warning: "private_lock" } });
    const post: YoutubePostDoc = {
      _id: "post-1",
      userId: users.alice.id,
      taskId: "task-1",
      lineageId: "clip-1",
      channelId: "UC1",
      state: "blocked",
      waitReason: "private_lock",
      attempts: 0,
      insertCalls: 0,
      insertCap: 3,
      privacy: "public",
      madeForKids: false,
      notifySubscribers: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await collections().youtubePosts.insertOne(post);

    const response = await call(resumeRoute.POST, "/api/youtube/account/resume", { method: "POST" });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: "active", warning: null });
    const requeued = await collections().youtubePosts.findOne({ _id: "post-1" });
    expect(requeued?.state).toBe("queued");
    const job = await collections().jobs.findOne({ type: "publish_youtube", "payload.postId": "post-1" });
    expect(job).not.toBeNull();
  });

  it("404s when no account is connected", async () => {
    const response = await call(resumeRoute.POST, "/api/youtube/account/resume", { method: "POST" });
    expect(response.status).toBe(404);
  });
});
