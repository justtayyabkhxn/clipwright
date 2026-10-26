import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { collections } from "./db";
import { DEFAULT_CLAUDE_MODEL, env } from "./env";
import { ApiError } from "./http";
import type { AppSettingDoc, RuntimeSettingKey } from "./types";

// --- AES-256-GCM, byte-compatible with backend/src/runtime_settings.py ---

function encryptionKey(): Buffer {
  const secret = env.APP_SETTINGS_ENCRYPTION_KEY ?? env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "APP_SETTINGS_ENCRYPTION_KEY must be set to save encrypted admin settings " +
        "(or provide a strong BETTER_AUTH_SECRET fallback).",
    );
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptSetting(value: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const parts = [nonce, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url"));
  return `v1:${parts.join(":")}`;
}

export function decryptSetting(encrypted: string): string {
  const parts = encrypted.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Unsupported encrypted setting format");
  const [nonce, tag, ciphertext] = parts.slice(1).map((part) => Buffer.from(part, "base64url"));
  // Full-length only, like Python's AESGCM: Node would otherwise accept a truncated tag.
  if (nonce.length !== 12 || tag.length !== 16) throw new Error("Unsupported encrypted setting format");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), nonce, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** A display hint such as `sk-ant-…a1b2`; never the full value (`llm_connection.mask_secret`). */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length <= 12) return trimmed.length > 4 ? `…${trimmed.slice(-2)}` : "…";
  const prefix = trimmed.startsWith("sk-ant-") ? "sk-ant-" : trimmed.slice(0, 3);
  return `${prefix}…${trimmed.slice(-4)}`;
}

// --- Runtime settings ---

export const SETTING_KEYS = ["ANTHROPIC_API_KEY", "ASSEMBLY_AI_API_KEY", "CLAUDE_MODEL"] as const;

const SETTING_METADATA: Record<RuntimeSettingKey, { label: string; description: string; input_type: "password" | "text" }> = {
  ANTHROPIC_API_KEY: {
    label: "Anthropic API key",
    description: "Used by Claude to find and score clips.",
    input_type: "password",
  },
  ASSEMBLY_AI_API_KEY: {
    label: "AssemblyAI API key",
    description: "Used for video transcription.",
    input_type: "password",
  },
  CLAUDE_MODEL: {
    label: "Claude model",
    description: "Model ID used for clip selection, for example claude-opus-5.",
    input_type: "text",
  },
};

type LoadedSetting = { row: AppSettingDoc | undefined; adminValue: string | null; envValue: string | null };

async function loadSettings(): Promise<Record<RuntimeSettingKey, LoadedSetting>> {
  const rows = await collections().appSettings.find({ _id: { $in: [...SETTING_KEYS] } }).toArray();
  const byKey = new Map(rows.map((row) => [row._id, row]));
  const loaded = {} as Record<RuntimeSettingKey, LoadedSetting>;
  for (const key of SETTING_KEYS) {
    const row = byKey.get(key);
    let adminValue: string | null = null;
    if (row?.encryptedValue) {
      try {
        adminValue = decryptSetting(row.encryptedValue).trim() || null;
      } catch (error) {
        console.warn(`[settings] Unable to decrypt runtime setting ${key}:`, (error as Error).message);
      }
    }
    loaded[key] = { row, adminValue, envValue: env[key] ?? null };
  }
  return loaded;
}

// The admin value wins when preferred or when the environment has none.
function effective({ row, adminValue, envValue }: LoadedSetting): string | null {
  if (adminValue && row?.preferAdminValue) return adminValue;
  return envValue || adminValue;
}

export type RuntimeSettings = {
  anthropicApiKey: string | null;
  assemblyAiApiKey: string | null;
  claudeModel: string;
  claudeRerankModel: string;
};

/** Read fresh on every call: the worker loads it at the start of each job. */
export async function getRuntimeSettings(): Promise<RuntimeSettings> {
  const settings = await loadSettings();
  const claudeModel = effective(settings.CLAUDE_MODEL) ?? DEFAULT_CLAUDE_MODEL;
  return {
    anthropicApiKey: effective(settings.ANTHROPIC_API_KEY),
    assemblyAiApiKey: effective(settings.ASSEMBLY_AI_API_KEY),
    claudeModel,
    claudeRerankModel: env.CLAUDE_RERANK_MODEL ?? claudeModel,
  };
}

export type RuntimeSetting = {
  key: RuntimeSettingKey;
  label: string;
  description: string;
  input_type: "password" | "text";
  source: "admin" | "environment" | "unset";
  configured: boolean;
  value_hint: string | null;
  has_admin_value: boolean;
  has_env_value: boolean;
  prefer_admin_value: boolean;
  overridden_by_env: boolean;
  updated_at: string | null;
};

/** Port of `admin._setting_status` for every key. */
export async function getSettingStatuses(): Promise<RuntimeSetting[]> {
  const settings = await loadSettings();
  return SETTING_KEYS.map((key) => {
    const setting = settings[key];
    const metadata = SETTING_METADATA[key];
    const hasEnv = Boolean(setting.envValue);
    const hasAdmin = Boolean(setting.row?.encryptedValue);
    const prefer = Boolean(setting.row?.preferAdminValue);
    const value = effective(setting);
    return {
      key,
      ...metadata,
      source: hasAdmin && (prefer || !hasEnv) ? "admin" : hasEnv ? "environment" : "unset",
      configured: hasEnv || hasAdmin,
      value_hint: metadata.input_type === "password" ? maskSecret(value) : value,
      has_admin_value: hasAdmin,
      has_env_value: hasEnv,
      prefer_admin_value: prefer,
      overridden_by_env: hasEnv && hasAdmin && !prefer,
      updated_at: setting.row?.updatedAt ? setting.row.updatedAt.toISOString() : null,
    };
  });
}

export const SettingsUpdateSchema = z.object({
  updates: z.record(z.string(), z.string()).default({}),
  delete_keys: z.array(z.string()).default([]),
  prefer_admin_values: z.record(z.string(), z.boolean()).default({}),
});

export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>;

/** A plausible Anthropic model id (`claude-opus-5`, `claude-sonnet-4-5-20250929`), with no `anthropic:` prefix. */
export function isClaudeModelId(value: string): boolean {
  return value.length <= 100 && /^claude-[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value);
}

export async function updateSettings(update: SettingsUpdate, userId: string): Promise<RuntimeSetting[]> {
  const allowed = new Set<string>(SETTING_KEYS);
  const invalid = [
    ...Object.keys(update.updates),
    ...update.delete_keys,
    ...Object.keys(update.prefer_admin_values),
  ].filter((key) => !allowed.has(key));
  if (invalid.length) {
    throw new ApiError(400, `Unsupported setting key(s): ${[...new Set(invalid)].sort().join(", ")}`);
  }
  const model = update.updates.CLAUDE_MODEL?.trim();
  if (model && !isClaudeModelId(model)) {
    throw new ApiError(400, `CLAUDE_MODEL must be a plain Claude model id such as ${DEFAULT_CLAUDE_MODEL}`);
  }

  const { appSettings } = collections();
  const now = new Date();
  for (const [key, raw] of Object.entries(update.updates)) {
    const value = raw.trim();
    if (!value) continue;
    await appSettings.updateOne(
      { _id: key as RuntimeSettingKey },
      {
        $set: { encryptedValue: encryptSetting(value), updatedBy: userId, updatedAt: now },
        $setOnInsert: { preferAdminValue: false, createdAt: now },
      },
      { upsert: true },
    );
  }
  for (const [key, prefer] of Object.entries(update.prefer_admin_values)) {
    await appSettings.updateOne(
      { _id: key as RuntimeSettingKey },
      { $set: { preferAdminValue: prefer, updatedBy: userId, updatedAt: now } },
    );
  }
  if (update.delete_keys.length) {
    await appSettings.deleteMany({ _id: { $in: update.delete_keys as RuntimeSettingKey[] } });
  }
  return getSettingStatuses();
}
