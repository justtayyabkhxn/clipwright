/** @vitest-environment node */
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getAuth } from "./auth";
import { closeDb, collections, ensureIndexes } from "./db";
import { resetEnv } from "./env";
import { getSessionUser, requireAdmin, requireUser } from "./session";
import { createTask, settingsFromCreateRequest } from "./tasks";

// Better Auth's Mongo adapter uses transactions when given the client, which needs a replica set (Atlas is one).
let replSet: MongoMemoryReplSet;
const baseEnv = { ...process.env };
const PASSWORD = "correct horse battery";

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env = {
    ...baseEnv,
    MONGODB_URI: replSet.getUri(),
    MONGODB_DB: "auth",
    BETTER_AUTH_SECRET: "a-very-long-test-secret-for-better-auth-0001",
    BETTER_AUTH_URL: "http://localhost:3000",
    ADMIN_EMAILS: " Boss@Example.com , other@example.com",
  };
  resetEnv();
  await ensureIndexes();
}, 60_000);

afterAll(async () => {
  await closeDb();
  await replSet.stop();
  process.env = baseEnv;
});

const signUp = (email: string, extra: Record<string, unknown> = {}) =>
  getAuth().api.signUpEmail({ body: { email, password: PASSWORD, name: email.split("@")[0], ...extra } });

const isAdmin = async (id: string) => (await collections().users.findOne({ _id: new ObjectId(id) }))?.is_admin;

describe("admin bootstrap", () => {
  it("makes the first user an admin, then only ADMIN_EMAILS", async () => {
    const first = await signUp("first@example.com");
    expect(first.user.is_admin).toBe(true);
    expect(await isAdmin(first.user.id)).toBe(true);

    const second = await signUp("second@example.com");
    expect(second.user.is_admin).toBe(false);
    expect(await isAdmin(second.user.id)).toBe(false);

    const boss = await signUp("boss@example.com");
    expect(await isAdmin(boss.user.id)).toBe(true);
  });

  it("does not let a user set is_admin", async () => {
    const sneaky = await signUp("sneaky@example.com", { is_admin: true });
    expect(await isAdmin(sneaky.user.id)).toBe(false);

    // update-user skips the create hook, so this is what input:false guards.
    const signIn = await getAuth().api.signInEmail({ body: { email: "sneaky@example.com", password: PASSWORD }, asResponse: true });
    const cookie = signIn.headers.get("set-cookie")!.split(";")[0];
    await expect(
      getAuth().api.updateUser({ body: { is_admin: true } as never, headers: new Headers({ cookie }) }),
    ).rejects.toMatchObject({ body: { code: "FIELD_NOT_ALLOWED" } });
    const response = await getAuth().handler(
      new Request("http://localhost:3000/api/auth/update-user", {
        method: "POST",
        headers: { cookie, "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ is_admin: true }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await isAdmin(sneaky.user.id)).toBe(false);
  });

  it("exposes is_admin on the session", async () => {
    const response = await getAuth().api.signInEmail({
      body: { email: "first@example.com", password: PASSWORD },
      asResponse: true,
    });
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    const session = await getAuth().api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user).toMatchObject({ email: "first@example.com", is_admin: true });
  });
});

describe("session helpers", () => {
  const requestFor = async (email: string) => {
    const response = await getAuth().api.signInEmail({ body: { email, password: PASSWORD }, asResponse: true });
    return new Request("http://localhost:3000/api/x", { headers: { cookie: response.headers.get("set-cookie")!.split(";")[0] } });
  };

  it("resolves the user and gates admin routes", async () => {
    const admin = await requestFor("first@example.com");
    expect(await getSessionUser(admin)).toEqual({ id: expect.stringMatching(/^[0-9a-f]{24}$/), email: "first@example.com", name: "first", isAdmin: true });
    expect((await requireAdmin(admin)).email).toBe("first@example.com");

    const member = await requestFor("second@example.com");
    expect((await requireUser(member)).isAdmin).toBe(false);
    await expect(requireAdmin(member)).rejects.toMatchObject({ status: 403 });

    const anonymous = new Request("http://localhost:3000/api/x");
    expect(await getSessionUser(anonymous)).toBeNull();
    await expect(requireUser(anonymous)).rejects.toMatchObject({ status: 401, detail: "Unauthorized" });
  });
});

describe("account lifecycle", () => {
  it("logs the password reset link to the console", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await getAuth().api.requestPasswordReset({ body: { email: "second@example.com", redirectTo: "/reset-password" } });
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[auth\] Password reset link for second@example\.com: http:\/\/localhost:3000\//)),
    );
    log.mockRestore();
  });

  it("deletes the user's data before deleting the user", async () => {
    const { user } = await signUp("leaving@example.com");
    await createTask({ userId: user.id, source: { type: "youtube", url: "https://youtu.be/x", title: "Mine" }, settings: settingsFromCreateRequest({}) });
    const signIn = await getAuth().api.signInEmail({ body: { email: "leaving@example.com", password: PASSWORD }, asResponse: true });
    const cookie = signIn.headers.get("set-cookie")!.split(";")[0];

    await getAuth().api.deleteUser({ body: { password: PASSWORD }, headers: new Headers({ cookie }) });
    expect(await collections().tasks.countDocuments({ userId: user.id })).toBe(0);
    expect(await collections().users.countDocuments({ email: "leaving@example.com" })).toBe(0);
  });
});
