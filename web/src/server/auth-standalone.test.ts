/** @vitest-environment node */
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getAuth } from "./auth";
import { closeDb, collections } from "./db";
import { resetEnv } from "./env";

// A standalone mongod has no transactions; MONGODB_TRANSACTIONS=false keeps sign-up working there.
let server: MongoMemoryServer;
const baseEnv = { ...process.env };

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  process.env = {
    ...baseEnv,
    MONGODB_URI: server.getUri(),
    MONGODB_DB: "auth_standalone",
    MONGODB_TRANSACTIONS: "false",
    BETTER_AUTH_SECRET: "a-very-long-test-secret-for-better-auth-0002",
    BETTER_AUTH_URL: "http://localhost:3000",
  };
  resetEnv();
}, 60_000);

afterAll(async () => {
  await closeDb();
  await server.stop();
  process.env = baseEnv;
});

it("signs up on a standalone mongod with transactions off", async () => {
  const { user } = await getAuth().api.signUpEmail({
    body: { email: "solo@example.com", password: "correct horse battery", name: "solo" },
  });
  expect(user.is_admin).toBe(true);
  expect(await collections().users.countDocuments({ email: "solo@example.com" })).toBe(1);
});
