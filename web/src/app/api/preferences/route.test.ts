/** @vitest-environment node */
import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAuth } from "@/server/auth";
import { closeDb, collections, ensureIndexes } from "@/server/db";
import { resetEnv } from "@/server/env";
import { GET, PATCH } from "./route";

let mongod: MongoMemoryServer;
const baseEnv = { ...process.env };
type User = { id: string; cookie: string };
let user: User;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env = {
    ...baseEnv,
    MONGODB_URI: mongod.getUri(),
    MONGODB_DB: "preference_routes",
    MONGODB_TRANSACTIONS: "false",
    BETTER_AUTH_SECRET: "a-very-long-test-secret-for-preferences-0001",
    BETTER_AUTH_URL: "http://localhost:3000",
  };
  resetEnv();
  await ensureIndexes();
  const response = await getAuth().api.signUpEmail({
    body: { email: "prefs@example.com", password: "correct horse battery", name: "prefs" },
    asResponse: true,
  });
  const { user: created } = (await response.json()) as { user: { id: string } };
  user = { id: created.id, cookie: response.headers.get("set-cookie")!.split(";")[0] };
}, 60_000);

afterAll(async () => {
  await closeDb();
  await mongod.stop();
  process.env = baseEnv;
});

const get = (cookie: string | null = user.cookie) =>
  GET(new Request("http://localhost:3000/api/preferences", { headers: cookie ? { cookie } : {} }));
const patch = (body: unknown, cookie: string | null = user.cookie) =>
  PATCH(
    new Request("http://localhost:3000/api/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(cookie && { cookie }) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
const stored = async () => (await collections().users.findOne({ _id: new ObjectId(user.id) }))?.preferences;

describe("/api/preferences", () => {
  it("needs a session", async () => {
    expect((await get(null)).status).toBe(401);
    expect((await patch({ clipLength: "long" }, null)).status).toBe(401);
  });

  it("returns null caption fields and the auto clip length until something is saved", async () => {
    expect(await (await get()).json()).toEqual({
      fontFamily: null,
      fontSize: null,
      fontColor: null,
      clipLength: "auto",
      saved: false,
    });
    // An empty patch writes nothing.
    expect(await (await patch({})).json()).toMatchObject({ saved: false });
    expect(await stored()).toBeUndefined();
  });

  it.each([
    [{ clipLength: "custom" }, "Invalid clipLength"],
    [{ clipLength: null }, "Invalid clipLength"],
    [{ fontFamily: "  " }, "Invalid fontFamily"],
    [{ fontFamily: false }, "Invalid fontFamily"],
    [{ fontSize: 11 }, "Invalid fontSize (must be between 12 and 48)"],
    [{ fontSize: 24.5 }, "Invalid fontSize (must be between 12 and 48)"],
    [{ fontSize: "24" }, "Invalid fontSize (must be between 12 and 48)"],
    [{ fontColor: "red" }, "Invalid fontColor (must be hex format like #FFFFFF)"],
    [null, "Expected a preferences object"],
    [[], "Expected a preferences object"],
    ["{", "Expected a preferences object"],
  ])("rejects %j", async (body, detail) => {
    const response = await patch(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ detail });
    expect(await stored()).toBeUndefined();
  });

  it("refuses an oversized body with 413", async () => {
    const response = await patch(`{"fontFamily":"${"x".repeat(9 * 1024 * 1024)}"}`);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ detail: "Request body is too large" });
  });

  it("saves partial updates without touching other fields", async () => {
    const first = await patch({ clipLength: "long", notifyOnCompletion: false });
    // A clip length alone does not turn the unset caption fields into saved ones.
    expect(await first.json()).toEqual({ fontFamily: null, fontSize: null, fontColor: null, clipLength: "long", saved: true });
    expect(await stored()).toEqual({ clipLength: "long" });

    await patch({ fontFamily: "Inter", fontSize: 32, fontColor: "#12abef" });
    expect(await stored()).toEqual({ clipLength: "long", fontFamily: "Inter", fontSize: 32, fontColor: "#12abef" });
    expect(await (await get()).json()).toEqual({ fontFamily: "Inter", fontSize: 32, fontColor: "#12abef", clipLength: "long", saved: true });
  });
});
