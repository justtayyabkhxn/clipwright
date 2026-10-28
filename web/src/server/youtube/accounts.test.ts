/** @vitest-environment node */
// Accounts, encrypted tokens and OAuth state (design §4.2, §4.3). Fake Google fetch; no real calls.

import { MongoMemoryServer } from "mongodb-memory-server";
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { server as mockServer } from "@/test/setup";
import { closeDb, collections, ensureIndexes } from "../db";
import { resetEnv } from "../env";
import { decryptSetting, encryptSetting } from "../settings";
import { deleteAllUserData } from "../tasks";
import type { YoutubeAccountDoc, YoutubePostDoc } from "../types";
import {
  consumeOAuthState,
  createOAuthState,
  disconnectAccount,
  getAccessToken,
  getAccount,
  MissingRefreshTokenError,
  saveConnectedAccount,
  serializeAccount,
  setAccountStatus,
  updateAccountPrefs,
} from "./accounts";
import { GoogleApiError } from "./google";

let mongod: MongoMemoryServer;
const baseEnv = { ...process.env };

function useEnv(extra: Record<string, string | undefined> = {}) {
  process.env = {
    ...baseEnv,
    MONGODB_URI: mongod.getUri(),
    MONGODB_DB: "youtube_accounts",
    BETTER_AUTH_SECRET: "s".repeat(32),
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnv();
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  useEnv();
  await ensureIndexes();
});

afterAll(async () => {
  await closeDb();
  await mongod.stop();
  process.env = baseEnv;
  resetEnv();
});

beforeEach(async () => {
  useEnv();
  await collections().youtubeAccounts.deleteMany({});
  await collections().oauthStates.deleteMany({});
  await collections().youtubePosts.deleteMany({});
});

type Recorded = { url: string; init: RequestInit };

function fakeFetch(...responses: Response[]) {
  const requests: Recorded[] = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const CHANNEL = { channelId: "UC1", title: "My Channel", handle: "@mychannel", thumbnailUrl: "https://example.com/t.jpg" };
const CHANNEL_2 = { channelId: "UC2", title: "Other Channel", handle: undefined, thumbnailUrl: undefined };
const TOKENS = { accessToken: "at-1", refreshToken: "rt-1", expiresAt: new Date(Date.now() + 3600_000), scopes: ["scope-a"] };

describe("OAuth state", () => {
  it("is single-use, user-bound and expires", async () => {
    const { state } = await createOAuthState("u1");

    expect(await consumeOAuthState(state, "u2")).toBeNull(); // another user gets null
    expect(await consumeOAuthState(state, "u1")).toEqual({ codeVerifier: expect.any(String) });
    expect(await consumeOAuthState(state, "u1")).toBeNull(); // single-use: the second consume returns null

    const { state: state2 } = await createOAuthState("u1");
    const eleven = new Date(Date.now() - 11 * 60_000);
    await collections().oauthStates.updateOne({ _id: state2 }, { $set: { expiresAt: eleven } });
    expect(await consumeOAuthState(state2, "u1")).toBeNull();
  });

  it("creates a 32-byte base64url verifier and an S256 challenge", async () => {
    const { state, codeChallenge } = await createOAuthState("u1");
    const doc = await collections().oauthStates.findOne({ _id: state });
    expect(doc?.codeVerifier).toMatch(/^[\w-]{43}$/); // 32 bytes, base64url, no padding
    expect(codeChallenge).toMatch(/^[\w-]{43}$/);
    expect(codeChallenge).not.toBe(doc?.codeVerifier);
  });
});

describe("account repository", () => {
  it("stores tokens encrypted and never serializes them", async () => {
    await saveConnectedAccount("u1", TOKENS, CHANNEL);

    const raw = await collections().youtubeAccounts.findOne({ _id: "u1" });
    expect(raw?.refreshToken).toMatch(/^v1:/);
    expect(raw?.accessToken).toMatch(/^v1:/);
    expect(raw?.refreshToken).not.toContain("rt-1");
    expect(raw?.accessToken).not.toContain("at-1");

    const serialized = JSON.stringify(serializeAccount(raw ?? null));
    expect(serialized).not.toContain("rt-1");
    expect(serialized).not.toContain("at-1");
    expect(serialized).not.toContain(raw?.refreshToken ?? "");
  });

  it("defaults a new connection to autoPost true, public, not made for kids", async () => {
    await saveConnectedAccount("u1", TOKENS, CHANNEL);
    const account = await getAccount("u1");
    expect(account).toMatchObject({ status: "active", autoPost: true, privacy: "public", madeForKids: false });
  });

  it("keeps the previous refresh token when Google sends none", async () => {
    await saveConnectedAccount("u1", TOKENS, CHANNEL);
    await saveConnectedAccount("u1", { ...TOKENS, accessToken: "at-2", refreshToken: undefined }, CHANNEL);

    const account = await getAccount("u1");
    expect(decryptSetting(account!.refreshToken)).toBe("rt-1");
    expect(decryptSetting(account!.accessToken!)).toBe("at-2");
  });

  it("refuses to insert a brand-new account when Google sends no refresh token", async () => {
    await expect(saveConnectedAccount("u1", { ...TOKENS, refreshToken: undefined }, CHANNEL)).rejects.toBeInstanceOf(
      MissingRefreshTokenError,
    );
    expect(await getAccount("u1")).toBeNull();
  });

  it("reports channelChanged when a different channel connects", async () => {
    expect((await saveConnectedAccount("u1", TOKENS, CHANNEL)).channelChanged).toBe(false); // first connect
    expect((await saveConnectedAccount("u1", TOKENS, CHANNEL)).channelChanged).toBe(false); // same channel
    expect((await saveConnectedAccount("u1", TOKENS, CHANNEL_2)).channelChanged).toBe(true); // switched channel

    // The new channel has no handle or thumbnail: the old channel's must not survive the switch.
    expect(serializeAccount(await getAccount("u1")).channel).toEqual({
      id: "UC2",
      title: "Other Channel",
      handle: null,
      thumbnail_url: null,
    });
  });

  it("keeps the §4.6 private-lock pause through a reconnect, same channel or a different one", async () => {
    await saveConnectedAccount("u1", TOKENS, CHANNEL);
    await setAccountStatus("u1", "paused", "private_lock");

    await saveConnectedAccount("u1", TOKENS, CHANNEL); // reconnect, same channel
    expect(await getAccount("u1")).toMatchObject({ status: "paused", warning: "private_lock" });

    await saveConnectedAccount("u1", TOKENS, CHANNEL_2); // reconnect, different channel
    expect(await getAccount("u1")).toMatchObject({ status: "paused", warning: "private_lock" });
  });

  it("updateAccountPrefs only touches the given fields", async () => {
    await saveConnectedAccount("u1", TOKENS, CHANNEL);
    await updateAccountPrefs("u1", { privacy: "unlisted" });
    expect(await getAccount("u1")).toMatchObject({ privacy: "unlisted", autoPost: true, madeForKids: false });
    await updateAccountPrefs("u1", { autoPost: false, madeForKids: true });
    expect(await getAccount("u1")).toMatchObject({ privacy: "unlisted", autoPost: false, madeForKids: true });
  });

  it("disconnectAccount deletes the doc and returns a thunk that revokes with the decrypted token, without calling it", async () => {
    await saveConnectedAccount("u1", TOKENS, CHANNEL);
    let revokedToken: string | null = null;
    mockServer.use(
      http.post("https://oauth2.googleapis.com/revoke", async ({ request }) => {
        revokedToken = new URLSearchParams(await request.text()).get("token");
        return new HttpResponse(null, { status: 200 });
      }),
    );

    const revoke = await disconnectAccount("u1");

    // The doc is gone, and the network call has not happened yet: the caller decides when (design
    // §4.3: delete -> cancel posts -> revoke), so disconnectAccount itself must never block on it.
    expect(await getAccount("u1")).toBeNull();
    expect(revokedToken).toBeNull();

    await revoke!();
    expect(revokedToken).toBe("rt-1");
  });

  it("disconnectAccount returns null when there is no account to disconnect", async () => {
    expect(await disconnectAccount("ghost")).toBeNull();
  });

  it("disconnectAccount's revoke thunk resolves without throwing when the revoke returns 500", async () => {
    await saveConnectedAccount("u1", TOKENS, CHANNEL);
    mockServer.use(http.post("https://oauth2.googleapis.com/revoke", () => new HttpResponse(null, { status: 500 })));

    const revoke = await disconnectAccount("u1");
    await expect(revoke!()).resolves.toBeUndefined();
    expect(await getAccount("u1")).toBeNull();
  });

  it("disconnectAccount's revoke thunk resolves without throwing when the revoke request itself fails", async () => {
    await saveConnectedAccount("u1", TOKENS, CHANNEL);
    mockServer.use(http.post("https://oauth2.googleapis.com/revoke", () => HttpResponse.error()));

    const revoke = await disconnectAccount("u1");
    await expect(revoke!()).resolves.toBeUndefined();
    expect(await getAccount("u1")).toBeNull();
  });

  it("setAccountStatus sets a warning, leaves it alone when omitted, and clears it with null", async () => {
    await saveConnectedAccount("u1", TOKENS, CHANNEL);
    await setAccountStatus("u1", "paused", "private_lock");
    expect(await getAccount("u1")).toMatchObject({ status: "paused", warning: "private_lock" });

    await setAccountStatus("u1", "reauth_required");
    expect(await getAccount("u1")).toMatchObject({ status: "reauth_required", warning: "private_lock" });

    await setAccountStatus("u1", "active", null);
    expect(await getAccount("u1")).toMatchObject({ status: "active" });
    expect((await getAccount("u1"))?.warning).toBeUndefined();
  });
});

describe("getAccessToken", () => {
  function accountWith(overrides: Partial<YoutubeAccountDoc> = {}): YoutubeAccountDoc {
    const now = new Date();
    return {
      _id: "u1",
      channelId: "UC1",
      channelTitle: "My Channel",
      refreshToken: encryptSetting("refresh-1"),
      scopes: [],
      status: "active",
      autoPost: true,
      privacy: "public",
      madeForKids: false,
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  it("refreshes an access token that expires within 5 minutes", async () => {
    await saveConnectedAccount("u1", TOKENS, CHANNEL);
    const stored = (await getAccount("u1"))!;
    const account = { ...stored, accessTokenExpiresAt: new Date(Date.now() + 60_000) };
    const fake = fakeFetch(json({ access_token: "fresh-token", expires_in: 3600 }));

    const token = await getAccessToken(account, fake.fetchImpl);

    expect(token).toBe("fresh-token");
    expect(fake.requests).toHaveLength(1);
    const body = fake.requests[0].init.body as URLSearchParams;
    expect(body.get("refresh_token")).toBe("rt-1");
    expect(body.get("grant_type")).toBe("refresh_token");
    const refreshed = await getAccount("u1");
    expect(refreshed?.accessToken).toMatch(/^v1:/);
    expect(refreshed?.accessToken).not.toContain("fresh-token");
    expect(refreshed?.accessTokenExpiresAt?.getTime()).toBeGreaterThan(Date.now() + 3500_000);
  });

  it("does not let a stale account snapshot overwrite a reconnected account's token or status", async () => {
    await saveConnectedAccount("u1", TOKENS, CHANNEL);
    const stale = (await getAccount("u1"))!; // snapshot: channel UC1, refresh token rt-1
    const staleExpiring = { ...stale, accessTokenExpiresAt: new Date(Date.now() + 60_000) };

    // The user reconnects with a new refresh token and a different channel.
    await saveConnectedAccount("u1", { ...TOKENS, accessToken: "at-new", refreshToken: "rt-new" }, CHANNEL_2);

    // A stale refresh that still succeeds at Google must not overwrite the reconnected account's token.
    const succeeds = fakeFetch(json({ access_token: "stale-refreshed", expires_in: 3600 }));
    await getAccessToken(staleExpiring, succeeds.fetchImpl);
    const afterSuccess = await getAccount("u1");
    expect(decryptSetting(afterSuccess!.accessToken!)).toBe("at-new");

    // A stale refresh that fails with invalid_grant (the old token was revoked) must not flag the fresh account.
    const fails = fakeFetch(json({ error: "invalid_grant" }, 400));
    await expect(getAccessToken(staleExpiring, fails.fetchImpl)).rejects.toBeInstanceOf(GoogleApiError);
    expect((await getAccount("u1"))?.status).toBe("active");
  });

  it("does not refresh when the access token still has plenty of time left", async () => {
    await saveConnectedAccount("u1", TOKENS, CHANNEL);
    const stored = (await getAccount("u1"))!;
    const fake = fakeFetch(); // throws if called

    const token = await getAccessToken(stored, fake.fetchImpl);

    expect(token).toBe("at-1");
    expect(fake.requests).toHaveLength(0);
  });

  it("marks the account reauth_required on invalid_grant", async () => {
    const account = accountWith({ accessTokenExpiresAt: new Date(Date.now() - 1000) });
    await collections().youtubeAccounts.insertOne(account);
    const fake = fakeFetch(json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400));

    const error = await getAccessToken(account, fake.fetchImpl).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GoogleApiError);
    expect(error).toMatchObject({ reason: "invalid_grant" });
    expect(await getAccount("u1")).toMatchObject({ status: "reauth_required" });
  });
});

describe("serializeAccount", () => {
  it("never includes tokens and reports configured/connected/defaults", async () => {
    expect(serializeAccount(null)).toEqual({
      configured: true,
      connected: false,
      channel: null,
      status: null,
      warning: null,
      auto_post: false,
      privacy: "public",
      made_for_kids: false,
    });

    await saveConnectedAccount("u1", TOKENS, CHANNEL);
    const account = await getAccount("u1");
    expect(serializeAccount(account)).toEqual({
      configured: true,
      connected: true,
      channel: { id: "UC1", title: "My Channel", handle: "@mychannel", thumbnail_url: "https://example.com/t.jpg" },
      status: "active",
      warning: null,
      auto_post: true,
      privacy: "public",
      made_for_kids: false,
    });
  });

  it("adds a setup_hint naming both env vars when Google OAuth is not configured", () => {
    useEnv({ GOOGLE_OAUTH_CLIENT_ID: undefined, GOOGLE_OAUTH_CLIENT_SECRET: undefined });
    const result = serializeAccount(null);
    expect(result.configured).toBe(false);
    expect(result.setup_hint).toContain("GOOGLE_OAUTH_CLIENT_ID");
    expect(result.setup_hint).toContain("GOOGLE_OAUTH_CLIENT_SECRET");
  });
});

describe("deleteAllUserData", () => {
  it("removes the YouTube account, posts and OAuth states", async () => {
    await saveConnectedAccount("u1", TOKENS, CHANNEL);
    await createOAuthState("u1");
    const post: YoutubePostDoc = {
      _id: "post-1",
      userId: "u1",
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
    mockServer.use(http.post("https://oauth2.googleapis.com/revoke", () => new HttpResponse(null, { status: 200 })));

    // Another user's account, posts and OAuth state must survive u1's deletion.
    await saveConnectedAccount("u2", TOKENS, CHANNEL_2);
    await createOAuthState("u2");
    const otherPost: YoutubePostDoc = { ...post, _id: "post-2", userId: "u2", lineageId: "clip-2", channelId: "UC2" };
    await collections().youtubePosts.insertOne(otherPost);

    await deleteAllUserData("u1");

    expect(await getAccount("u1")).toBeNull();
    expect(await collections().youtubePosts.countDocuments({ userId: "u1" })).toBe(0);
    expect(await collections().oauthStates.countDocuments({ userId: "u1" })).toBe(0);

    expect(await getAccount("u2")).not.toBeNull();
    expect(await collections().youtubePosts.countDocuments({ userId: "u2" })).toBe(1);
    expect(await collections().oauthStates.countDocuments({ userId: "u2" })).toBe(1);
  });
});
