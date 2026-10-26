/** @vitest-environment node */
import net from "node:net";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, expect, it, vi } from "vitest";
import { closeDb, collections } from "./db";
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
