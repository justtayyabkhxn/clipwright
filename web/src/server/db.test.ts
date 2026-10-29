/** @vitest-environment node */
import net from "node:net";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, collections, ensureIndexes, getDb } from "./db";
import { resetEnv } from "./env";

const baseEnv = { ...process.env };

afterAll(async () => {
  await closeDb();
  process.env = baseEnv;
  resetEnv();
});

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer().once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

it("serves operations again once the database is back after a failed first connect", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const port = await freePort();
  process.env = { ...baseEnv, MONGODB_URI: `mongodb://127.0.0.1:${port}/?serverSelectionTimeoutMS=300`, MONGODB_DB: "db_test", BETTER_AUTH_SECRET: "s".repeat(32) };
  resetEnv();
  await expect(collections().tasks.findOne({})).rejects.toThrow();

  const late = await MongoMemoryServer.create({ instance: { port, ip: "127.0.0.1" } });
  try {
    // Without an explicit reconnect the driver keeps answering "Topology is closed".
    await expect(collections().tasks.findOne({})).resolves.toBeNull();
  } finally {
    await closeDb();
    await late.stop();
    error.mockRestore();
  }
}, 60_000);

describe("YouTube indexes", () => {
  let mongod: MongoMemoryServer;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    process.env = { ...baseEnv, MONGODB_URI: mongod.getUri(), MONGODB_DB: "db_test_youtube", BETTER_AUTH_SECRET: "s".repeat(32) };
    resetEnv();
  });

  afterAll(async () => {
    await closeDb();
    await mongod.stop();
    process.env = baseEnv;
    resetEnv();
  });

  it("creates the YouTube indexes", async () => {
    await ensureIndexes();
    const db = getDb();

    const postIndexes = await db.collection("youtube_posts").indexes();
    const lineageIdIndex = postIndexes.find((index) => JSON.stringify(index.key) === JSON.stringify({ lineageId: 1 }));
    expect(lineageIdIndex?.unique).toBe(true);
    expect(postIndexes.some((index) => JSON.stringify(index.key) === JSON.stringify({ taskId: 1 }))).toBe(true);
    expect(postIndexes.some((index) => JSON.stringify(index.key) === JSON.stringify({ userId: 1, createdAt: -1 }))).toBe(true);
    expect(postIndexes.some((index) => JSON.stringify(index.key) === JSON.stringify({ state: 1, notBefore: 1 }))).toBe(true);

    const oauthStateIndexes = await db.collection("oauth_states").indexes();
    const ttlIndex = oauthStateIndexes.find((index) => JSON.stringify(index.key) === JSON.stringify({ expiresAt: 1 }));
    expect(ttlIndex?.expireAfterSeconds).toBe(0);

    const taskIndexes = await db.collection("tasks").indexes();
    const autopostIndex = taskIndexes.find((index) => JSON.stringify(index.key) === JSON.stringify({ autopost: 1 }));
    expect(autopostIndex?.partialFilterExpression).toEqual({ autopost: "pending" });
  });
});
