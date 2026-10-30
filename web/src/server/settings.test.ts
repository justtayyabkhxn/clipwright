/** @vitest-environment node */
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, collections } from "./db";
import { resetEnv } from "./env";
import {
  decryptSetting,
  encryptSetting,
  getRuntimeSettings,
  getSettingStatuses,
  maskSecret,
  updateSettings,
} from "./settings";

const SECRET = "interop-secret-0123456789";
// Encrypted once with SECRET by the original Python implementation
// (`git show 29dc44b:backend/src/runtime_settings.py`, encrypt_setting_value).
const PYTHON_CIPHERTEXT = "v1:1xF1bgRWT4Y7alFy:VfjlpSYXT9aklcGxMMd8EQ:golRAh3ugbMoLguxbxXQP5ZT96o3";

let mongod: MongoMemoryServer;
const baseEnv = { ...process.env };

function setEnv(values: Record<string, string | undefined>) {
  process.env = { ...baseEnv, MONGODB_URI: mongod.getUri(), MONGODB_DB: "settings", BETTER_AUTH_SECRET: "b".repeat(32), APP_SETTINGS_ENCRYPTION_KEY: SECRET };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnv();
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
});

afterAll(async () => {
  await closeDb();
  await mongod.stop();
  process.env = baseEnv;
});

beforeEach(async () => {
  setEnv({ ANTHROPIC_API_KEY: undefined, ASSEMBLY_AI_API_KEY: undefined, CLAUDE_MODEL: undefined, CLAUDE_RERANK_MODEL: undefined });
  await collections().appSettings.deleteMany({});
});

describe("encryption", () => {
  it("round-trips and uses the v1 format", () => {
    const encrypted = encryptSetting("sk-ant-api03-é✓");
    expect(encrypted).toMatch(/^v1:[\w-]{16}:[\w-]{22}:[\w-]+$/);
    expect(decryptSetting(encrypted)).toBe("sk-ant-api03-é✓");
    expect(encryptSetting("same")).not.toBe(encryptSetting("same"));
  });

  it("rejects other formats and tampered values", () => {
    expect(() => decryptSetting("v2:a:b:c")).toThrow("Unsupported encrypted setting format");
    const [v, nonce, tag, ct] = encryptSetting("value").split(":");
    expect(() => decryptSetting([v, nonce, tag, `${ct}A`].join(":"))).toThrow();
    const shortTag = Buffer.from(tag, "base64url").subarray(0, 4).toString("base64url");
    expect(() => decryptSetting([v, nonce, shortTag, ct].join(":"))).toThrow("Unsupported encrypted setting format");
  });

  it("falls back to BETTER_AUTH_SECRET and refuses short keys", () => {
    setEnv({ APP_SETTINGS_ENCRYPTION_KEY: undefined });
    expect(decryptSetting(encryptSetting("x"))).toBe("x");
    setEnv({ APP_SETTINGS_ENCRYPTION_KEY: "too-short" });
    expect(() => encryptSetting("x")).toThrow(/APP_SETTINGS_ENCRYPTION_KEY must be set/);
  });

  it("decrypts a value written by the Python backend", () => {
    expect(decryptSetting(PYTHON_CIPHERTEXT)).toBe("sk-ant-from-python-ü");
  });
});

describe("maskSecret", () => {
  it("matches llm_connection.mask_secret", () => {
    expect(maskSecret(null)).toBeNull();
    expect(maskSecret("")).toBeNull();
    expect(maskSecret("abcd")).toBe("…");
    expect(maskSecret("abcdef")).toBe("…ef");
    expect(maskSecret("abcdefghijkl")).toBe("…kl");
    expect(maskSecret("sk-ant-api03-secretvalue-a1b2")).toBe("sk-ant-…a1b2");
    expect(maskSecret("  aai-0123456789abcdef  ")).toBe("aai…cdef");
  });
});

describe("runtime settings", () => {
  it("defaults the model and reports unset keys", async () => {
    expect(await getRuntimeSettings()).toEqual({
      anthropicApiKey: null,
      assemblyAiApiKey: null,
      claudeModel: "claude-opus-5",
      claudeRerankModel: "claude-opus-5",
    });
    const statuses = await getSettingStatuses();
    expect(statuses.map((s) => s.key)).toEqual(["ANTHROPIC_API_KEY", "ASSEMBLY_AI_API_KEY", "CLAUDE_MODEL"]);
    expect(statuses[0]).toEqual({
      key: "ANTHROPIC_API_KEY",
      label: "Anthropic API key",
      description: expect.any(String),
      input_type: "password",
      source: "unset",
      configured: false,
      value_hint: null,
      has_admin_value: false,
      has_env_value: false,
      prefer_admin_value: false,
      overridden_by_env: false,
      updated_at: null,
    });
  });

  it("uses the admin value when the environment has none", async () => {
    await updateSettings(
      { updates: { ANTHROPIC_API_KEY: " sk-ant-admin-key-9999 ", CLAUDE_MODEL: "claude-sonnet-5" }, delete_keys: [], prefer_admin_values: {} },
      "admin-1",
    );
    const settings = await getRuntimeSettings();
    expect(settings.anthropicApiKey).toBe("sk-ant-admin-key-9999");
    expect(settings.claudeModel).toBe("claude-sonnet-5");
    expect(settings.claudeRerankModel).toBe("claude-sonnet-5");
    const [anthropic, , model] = await getSettingStatuses();
    expect(anthropic).toMatchObject({ source: "admin", configured: true, value_hint: "sk-ant-…9999", has_admin_value: true });
    expect(anthropic.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(model).toMatchObject({ source: "admin", value_hint: "claude-sonnet-5", input_type: "text" });
    const row = await collections().appSettings.findOne({ _id: "ANTHROPIC_API_KEY" });
    expect(row).toMatchObject({ preferAdminValue: false, updatedBy: "admin-1" });
    expect(row?.encryptedValue).not.toContain("admin-key");
  });

  it("lets the environment win unless the admin value is preferred", async () => {
    setEnv({ ANTHROPIC_API_KEY: "sk-ant-env-key-0000", CLAUDE_RERANK_MODEL: "claude-haiku-4-5" });
    await updateSettings({ updates: { ANTHROPIC_API_KEY: "sk-ant-admin-key-9999" }, delete_keys: [], prefer_admin_values: {} }, "a");
    expect((await getRuntimeSettings()).anthropicApiKey).toBe("sk-ant-env-key-0000");
    expect((await getRuntimeSettings()).claudeRerankModel).toBe("claude-haiku-4-5");
    expect((await getSettingStatuses())[0]).toMatchObject({
      source: "environment",
      value_hint: "sk-ant-…0000",
      has_env_value: true,
      has_admin_value: true,
      overridden_by_env: true,
    });

    await updateSettings({ updates: {}, delete_keys: [], prefer_admin_values: { ANTHROPIC_API_KEY: true } }, "a");
    expect((await getRuntimeSettings()).anthropicApiKey).toBe("sk-ant-admin-key-9999");
    expect((await getSettingStatuses())[0]).toMatchObject({ source: "admin", prefer_admin_value: true, overridden_by_env: false });
  });

  it("skips blank updates, deletes keys and rejects unknown keys", async () => {
    await updateSettings({ updates: { ASSEMBLY_AI_API_KEY: "aai-key-123456789" }, delete_keys: [], prefer_admin_values: {} }, "a");
    await updateSettings({ updates: { ASSEMBLY_AI_API_KEY: "   " }, delete_keys: [], prefer_admin_values: {} }, "a");
    expect((await getRuntimeSettings()).assemblyAiApiKey).toBe("aai-key-123456789");
    await updateSettings({ updates: {}, delete_keys: ["ASSEMBLY_AI_API_KEY"], prefer_admin_values: {} }, "a");
    expect((await getRuntimeSettings()).assemblyAiApiKey).toBeNull();

    await expect(
      updateSettings({ updates: { LLM: "x", OPENAI_API_KEY: "y" }, delete_keys: ["LLM"], prefer_admin_values: {} }, "a"),
    ).rejects.toMatchObject({ status: 400, detail: "Unsupported setting key(s): LLM, OPENAI_API_KEY" });
  });

  it("ignores admin values it cannot decrypt", async () => {
    await collections().appSettings.insertOne({
      _id: "ANTHROPIC_API_KEY",
      encryptedValue: "v1:bad:bad:bad",
      preferAdminValue: true,
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect((await getRuntimeSettings()).anthropicApiKey).toBeNull();
    expect((await getSettingStatuses())[0]).toMatchObject({ has_admin_value: true, value_hint: null });
  });
});
