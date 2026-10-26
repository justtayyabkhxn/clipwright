/** @vitest-environment node */
import { MongoMemoryServer } from "mongodb-memory-server";
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as provider } from "@/app/api/ai/provider/route";
import { getAuth } from "@/server/auth";
import { closeDb, collections, ensureIndexes } from "@/server/db";
import { resetEnv } from "@/server/env";
import { server as mockServer } from "@/test/setup";
import { POST as testConnection } from "./ai/test-connection/route";
import { GET as getSettings, PATCH as patchSettings } from "./runtime-settings/route";

let mongod: MongoMemoryServer;
const baseEnv = { ...process.env };
const testEnv = () => ({
  ...baseEnv,
  MONGODB_URI: mongod.getUri(),
  MONGODB_DB: "admin_routes",
  MONGODB_TRANSACTIONS: "false",
  BETTER_AUTH_SECRET: "a-very-long-test-secret-for-admin-routes-001",
  BETTER_AUTH_URL: "http://localhost:3000",
  ANTHROPIC_API_KEY: "",
  ASSEMBLY_AI_API_KEY: "",
  CLAUDE_MODEL: "",
});

type User = { id: string; cookie: string };
let admin: User;
let member: User;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env = testEnv();
  resetEnv();
  await ensureIndexes();
  admin = await signUp("admin@example.com"); // the first user becomes admin
  member = await signUp("member@example.com");
}, 60_000);

afterAll(async () => {
  await closeDb();
  await mongod.stop();
  process.env = baseEnv;
});

beforeEach(async () => {
  process.env = testEnv();
  resetEnv();
  await collections().appSettings.deleteMany({});
});

async function signUp(email: string): Promise<User> {
  const response = await getAuth().api.signUpEmail({
    body: { email, password: "correct horse battery", name: email.split("@")[0] },
    asResponse: true,
  });
  const { user } = (await response.json()) as { user: { id: string } };
  return { id: user.id, cookie: response.headers.get("set-cookie")!.split(";")[0] };
}

function request(user: User | null, method = "GET", body?: unknown) {
  const headers: Record<string, string> = {};
  if (user) headers.cookie = user.cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request("http://localhost:3000/api/admin", {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const ADMIN_KEY = "sk-ant-api03-admin-secret-value-1234";
const ENV_KEY = "sk-ant-api03-env-secret-value-9999";
const ASSEMBLY_KEY = "assembly-secret-value-5678";

const settingsOf = async (response: Response) => {
  const { settings } = (await response.json()) as { settings: { key: string }[] };
  return Object.fromEntries(settings.map((setting) => [setting.key, setting])) as Record<string, Record<string, unknown>>;
};
const patch = (body: unknown, user: User = admin) => patchSettings(request(user, "PATCH", body));

describe("runtime settings", () => {
  it("is admin only", async () => {
    expect((await getSettings(request(null))).status).toBe(401);
    const forbidden = await getSettings(request(member));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ detail: "Admin access required" });
    expect((await patch({ updates: { CLAUDE_MODEL: "claude-sonnet-5" } }, member)).status).toBe(403);
    expect(await collections().appSettings.countDocuments()).toBe(0);
  });

  it("saves encrypted values and returns them masked", async () => {
    const initial = await settingsOf(await getSettings(request(admin)));
    expect(Object.keys(initial)).toEqual(["ANTHROPIC_API_KEY", "ASSEMBLY_AI_API_KEY", "CLAUDE_MODEL"]);
    expect(initial.ANTHROPIC_API_KEY).toMatchObject({ source: "unset", configured: false, value_hint: null, input_type: "password" });
    expect(initial.CLAUDE_MODEL).toMatchObject({ source: "unset", value_hint: null, input_type: "text" }); // the default is not a setting

    const response = await patch({ updates: { ANTHROPIC_API_KEY: ` ${ADMIN_KEY} `, CLAUDE_MODEL: "claude-sonnet-5", ASSEMBLY_AI_API_KEY: "  " } });
    expect(response.status).toBe(200);
    const text = await response.clone().text();
    expect(text).not.toContain(ADMIN_KEY);
    const saved = await settingsOf(response);
    expect(saved.ANTHROPIC_API_KEY).toMatchObject({ source: "admin", configured: true, value_hint: "sk-ant-…1234", has_admin_value: true });
    expect(saved.CLAUDE_MODEL).toMatchObject({ source: "admin", value_hint: "claude-sonnet-5" });
    expect(saved.ASSEMBLY_AI_API_KEY).toMatchObject({ source: "unset", has_admin_value: false }); // blank values are skipped

    const row = await collections().appSettings.findOne({ _id: "ANTHROPIC_API_KEY" });
    expect(row).toMatchObject({ encryptedValue: expect.stringMatching(/^v1:/), preferAdminValue: false, updatedBy: admin.id });
    expect(row?.encryptedValue).not.toContain(ADMIN_KEY);
  });

  it("applies the environment-vs-admin precedence", async () => {
    await patch({ updates: { ANTHROPIC_API_KEY: ADMIN_KEY } });
    process.env.ANTHROPIC_API_KEY = ENV_KEY;
    resetEnv();

    const envWins = await settingsOf(await getSettings(request(admin)));
    expect(envWins.ANTHROPIC_API_KEY).toMatchObject({
      source: "environment",
      value_hint: "sk-ant-…9999",
      has_env_value: true,
      has_admin_value: true,
      overridden_by_env: true,
    });

    const preferred = await settingsOf(await patch({ prefer_admin_values: { ANTHROPIC_API_KEY: true } }));
    expect(preferred.ANTHROPIC_API_KEY).toMatchObject({ source: "admin", value_hint: "sk-ant-…1234", overridden_by_env: false });

    const removed = await settingsOf(await patch({ delete_keys: ["ANTHROPIC_API_KEY"] }));
    expect(removed.ANTHROPIC_API_KEY).toMatchObject({ source: "environment", has_admin_value: false, value_hint: "sk-ant-…9999" });
  });

  it("validates the body", async () => {
    const unknown = await patch({ updates: { LLM: "anthropic:claude-opus-5", OPENAI_API_KEY: "x" }, delete_keys: ["PEXELS_API_KEY"] });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ detail: "Unsupported setting key(s): LLM, OPENAI_API_KEY, PEXELS_API_KEY" });

    for (const model of ["anthropic:claude-opus-5", "gpt-5", "Claude-Opus-5", "claude-", "claude opus", `claude-${"x".repeat(100)}`]) {
      const response = await patch({ updates: { CLAUDE_MODEL: model } });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ detail: "CLAUDE_MODEL must be a plain Claude model id such as claude-opus-5" });
    }
    for (const model of ["claude-opus-5", "claude-sonnet-4-5-20250929", "claude-3.5-sonnet-latest"]) {
      expect((await patch({ updates: { CLAUDE_MODEL: model } })).status).toBe(200);
    }

    expect((await patch({ updates: { ANTHROPIC_API_KEY: 42 } })).status).toBe(400);
    expect((await patch({ prefer_admin_values: { ANTHROPIC_API_KEY: "yes" } })).status).toBe(400);
    expect(await (await patch("{")).json()).toEqual({ detail: "Invalid JSON body" });
    expect(await (await patch([])).json()).toEqual({ detail: "Request body must be an object" });
  });
});

describe("GET /api/ai/provider", () => {
  it("reports which keys are configured, without auth and without secrets", async () => {
    const read = async () => {
      const response = await provider();
      const text = await response.text();
      expect(text).not.toMatch(/secret/);
      return JSON.parse(text);
    };
    expect(await read()).toEqual({
      provider: "anthropic",
      model: "claude-opus-5",
      configured: false,
      llm_configured: false,
      transcription_configured: false,
    });

    await patch({ updates: { ANTHROPIC_API_KEY: ADMIN_KEY, CLAUDE_MODEL: "claude-haiku-4-5" } });
    expect(await read()).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      configured: false,
      llm_configured: true,
      transcription_configured: false,
    });

    process.env.ASSEMBLY_AI_API_KEY = ASSEMBLY_KEY;
    resetEnv();
    expect(await read()).toMatchObject({ configured: true, llm_configured: true, transcription_configured: true });
  });
});

describe("POST /api/admin/ai/test-connection", () => {
  const MODELS = { data: [{ type: "model", id: "claude-opus-5", display_name: "Claude Opus 5", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: "claude-opus-5", last_id: "claude-opus-5" };
  let seenKeys: (string | null)[];

  beforeEach(() => {
    seenKeys = [];
    mockServer.use(
      http.get("https://api.anthropic.com/v1/models", ({ request }) => {
        // The SDK sends the key as a bearer token.
        const key = request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
        seenKeys.push(key);
        if (key === "sk-ant-revoked-key-0000") {
          return HttpResponse.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 });
        }
        return HttpResponse.json(MODELS);
      }),
      http.get("https://api.anthropic.com/v1/models/:model", ({ params }) =>
        HttpResponse.json({ type: "error", error: { type: "not_found_error", message: `model: ${params.model}` } }, { status: 404 }),
      ),
    );
  });

  const post = (body: unknown, user: User = admin) => testConnection(request(user, "POST", body));

  it("is admin only and anthropic only", async () => {
    expect((await post({ api_key: ADMIN_KEY }, member)).status).toBe(403);
    const other = await post({ provider: "openai", api_key: "x" });
    expect(other.status).toBe(400);
    expect(await other.json()).toEqual({ detail: "Only the anthropic provider can be tested here." });
    expect((await post({ api_key: "k".repeat(513) })).status).toBe(400);
    expect(seenKeys).toEqual([]);
  });

  it("tests a pasted key, else the saved key, and never echoes it", async () => {
    const pasted = await post({ provider: "anthropic", api_key: ` ${ADMIN_KEY} `, model: "claude-opus-5" });
    const text = await pasted.text();
    expect(text).not.toContain(ADMIN_KEY);
    expect(JSON.parse(text)).toEqual({
      ok: true,
      status: "ok",
      message: "Connected to Anthropic.",
      models: [{ id: "claude-opus-5", display_name: "Claude Opus 5" }],
    });
    expect(seenKeys).toEqual([ADMIN_KEY]);

    expect(await (await post({ api_key: null })).json()).toMatchObject({ ok: false, status: "missing_key" });

    await patch({ updates: { ANTHROPIC_API_KEY: "sk-ant-revoked-key-0000" } });
    expect(await (await post({ api_key: "" })).json()).toMatchObject({ ok: false, status: "invalid_key" });
    expect(seenKeys.at(-1)).toBe("sk-ant-revoked-key-0000");

    process.env.ANTHROPIC_API_KEY = ENV_KEY;
    resetEnv();
    expect(await (await post({})).json()).toMatchObject({ ok: true });
    expect(seenKeys.at(-1)).toBe(ENV_KEY); // the environment value wins unless the admin one is preferred

    const missingModel = await (await post({ api_key: ADMIN_KEY, model: "claude-imaginary-9" })).json();
    expect(missingModel).toMatchObject({ ok: false, status: "model_not_found", message: "The key works, but model 'claude-imaginary-9' is not available to it." });
  });
});
