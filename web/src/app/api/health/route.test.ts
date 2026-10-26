/** @vitest-environment node */
import net from "node:net";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { closeDb, collections, ensureIndexes, getDb } from "@/server/db";
import { resetEnv } from "@/server/env";
import { writeWorkerHeartbeat } from "@/server/jobs";
import { GET } from "./route";

let mongod: MongoMemoryServer;
const baseEnv = { ...process.env };
const useDatabase = async (uri: string) => {
  await closeDb();
  process.env = { ...baseEnv, MONGODB_URI: uri, MONGODB_DB: "health", BETTER_AUTH_SECRET: "s".repeat(32) };
  resetEnv();
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await useDatabase(mongod.getUri());
  await ensureIndexes();
});

afterAll(async () => {
  await closeDb();
  await mongod.stop();
  process.env = baseEnv;
});

it("reports the database and the worker heartbeat", async () => {
  const idle = await GET();
  expect(idle.status).toBe(503);
  expect(await idle.json()).toEqual({ ok: false, db: true, worker: { online: false, heartbeatAt: null } });

  await writeWorkerHeartbeat({ workerId: "w1", startedAt: new Date(), version: "test" });
  const healthy = await GET();
  expect(healthy.status).toBe(200);
  const body = await healthy.json();
  expect(body).toEqual({ ok: true, db: true, worker: { online: true, heartbeatAt: expect.any(String) } });
  expect(Date.now() - Date.parse(body.worker.heartbeatAt)).toBeLessThan(5000);

  await collections().workerStatus.updateOne({ _id: "worker" }, { $set: { heartbeatAt: new Date(Date.now() - 60_000) } });
  expect(await (await GET()).json()).toMatchObject({ ok: false, worker: { online: false } });
});

it("reports an unreachable database without throwing", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await useDatabase("mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=300");
  const response = await GET();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ ok: false, db: false, worker: { online: false, heartbeatAt: null } });
  warn.mockRestore();
});

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer().once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

it("answers within its 5 s limit while a cold client is still connecting", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // No serverSelectionTimeoutMS: the driver alone would wait 30 s.
  await useDatabase(`mongodb://127.0.0.1:${await freePort()}/`);
  const started = Date.now();
  expect(await (await GET()).json()).toMatchObject({ db: false });
  expect(Date.now() - started).toBeLessThan(8000);
  warn.mockRestore();
}, 20_000);

it("recovers once the database is back after a failed first connect", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const port = await freePort();
  await useDatabase(`mongodb://127.0.0.1:${port}/?serverSelectionTimeoutMS=300`);
  expect(await (await GET()).json()).toMatchObject({ db: false });

  const late = await MongoMemoryServer.create({ instance: { port, ip: "127.0.0.1" } });
  try {
    expect(await (await GET()).json()).toMatchObject({ db: true });
    // The same cached client serves other routes again.
    expect(await getDb().command({ ping: 1 })).toMatchObject({ ok: 1 });
  } finally {
    await ensureIndexes().catch(() => {});
    await closeDb();
    await late.stop();
    warn.mockRestore();
  }
}, 60_000);
