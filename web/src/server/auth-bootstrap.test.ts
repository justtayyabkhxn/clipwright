/** @vitest-environment node */
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getAuth } from "./auth";
import { closeDb, collections, ensureIndexes } from "./db";
import { resetEnv } from "./env";

let replSet: MongoMemoryReplSet;
const baseEnv = { ...process.env };

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env = {
    ...baseEnv,
    MONGODB_URI: replSet.getUri(),
    MONGODB_DB: "auth-bootstrap",
    BETTER_AUTH_SECRET: "a-very-long-test-secret-for-better-auth-0002",
    BETTER_AUTH_URL: "http://localhost:3000",
    ADMIN_EMAILS: "",
  };
  resetEnv();
  await ensureIndexes();
}, 60_000);

afterAll(async () => {
  await closeDb();
  await replSet.stop();
  process.env = baseEnv;
});

it("makes exactly one admin when the first sign-ups arrive together", async () => {
  await Promise.all(
    ["a", "b", "c", "d"].map((name) =>
      getAuth().api.signUpEmail({ body: { email: `${name}@example.com`, password: "correct horse battery", name } }),
    ),
  );
  expect(await collections().users.countDocuments({})).toBe(4);
  expect(await collections().users.countDocuments({ is_admin: true })).toBe(1);
});
