import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5";

// Lenient like the Python config: unknown values fall back to the default.
function flag(fallback: boolean) {
  return z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.toLowerCase();
      if (normalized && ["1", "true", "yes", "on"].includes(normalized)) return true;
      if (normalized && ["0", "false", "no", "off"].includes(normalized)) return false;
      return fallback;
    });
}

const int = (fallback: number, min = 0) => z.coerce.number().int().min(min).default(fallback);

const schema = z.object({
  MONGODB_URI: z.string({ error: "MONGODB_URI is required" }),
  MONGODB_DB: z.string().default("clipwright"),
  // Better Auth wraps multi-step writes in transactions; a standalone mongod has none.
  MONGODB_TRANSACTIONS: flag(true),
  BETTER_AUTH_SECRET: z
    .string({ error: "BETTER_AUTH_SECRET is required" })
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.string().default("http://localhost:3000"),
  BETTER_AUTH_TRUSTED_ORIGINS: z.string().default(""),
  APP_SETTINGS_ENCRYPTION_KEY: z.string().optional(),
  ADMIN_EMAILS: z.string().default(""),
  DISABLE_SIGN_UP: flag(false),
  ANTHROPIC_API_KEY: z.string().optional(),
  ASSEMBLY_AI_API_KEY: z.string().optional(),
  // AssemblyAI API host, e.g. https://api.eu.assemblyai.com for the EU region. Unset uses the SDK default.
  ASSEMBLYAI_BASE_URL: z.url().optional(),
  // Unset stays undefined: settings precedence needs to know whether the env set it.
  CLAUDE_MODEL: z.string().optional(),
  CLAUDE_RERANK_MODEL: z.string().optional(),
  DATA_DIR: z.string().optional(),
  STORAGE_DRIVER: z.enum(["local"]).default("local"),
  ENGINE_DIR: z.string().optional(),
  ENGINE_PYTHON: z.string().optional(),
  WORKER_CONCURRENCY: int(1, 1),
  MAX_VIDEO_DURATION: int(5400, 1),
  MAX_VIDEO_UPLOAD_BYTES: int(4_000_000_000, 1),
  MAX_CLIPS: int(10, 1),
  CLIP_DURATION: z.coerce.number().positive().default(30),
  TRANSCRIPTION_LANGUAGE: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = (value ?? "").toLowerCase().replace(/-/g, "_");
      return normalized === "auto" ? "" : normalized;
    }),
  ASSEMBLY_AI_HTTP_TIMEOUT_SECONDS: int(900, 1),
  SPEAKER_FRAMING: flag(true),
  HOOK_FIRST_TEASER: flag(false),
  YOUTUBE_MAX_HEIGHT: int(1080, 144),
  // YouTube auto-post (docs/youtube.md): unset disables the feature.
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  CLAUDE_METADATA_MODEL: z.string().default("claude-haiku-4-5"),
  // Overrides the Google API base URL; tests and e2e only.
  GOOGLE_BASE_URL_OVERRIDE: z.url().optional(),
});

export type Env = z.infer<typeof schema>;

export type Paths = {
  repoRoot: string;
  webRoot: string;
  dataDir: string;
  storageRoot: string;
  workRoot: string;
  engineDir: string;
  enginePython: string;
  bundledFontsDir: string;
};

let envCache: Env | null = null;
let pathsCache: Paths | null = null;

// Parsed on first use, not at import: `next build` loads route modules without a runtime env.
export function loadEnv(): Env {
  if (!envCache) {
    const raw: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      const trimmed = value?.trim();
      if (trimmed) raw[key] = trimmed;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
      throw new Error(`Invalid environment configuration: ${problems.join("; ")}`);
    }
    envCache = parsed.data;
  }
  return envCache;
}

function loadPaths(): Paths {
  if (!pathsCache) {
    const current = loadEnv();
    // `next dev`, `tsx src/worker/main.ts` and vitest all run from web/; tolerate the repo root too.
    const cwd = process.cwd();
    const webRoot = existsSync(path.join(cwd, "web", "package.json")) ? path.join(cwd, "web") : cwd;
    const repoRoot = path.dirname(webRoot);
    const dataDir = path.resolve(repoRoot, current.DATA_DIR ?? "data");
    const engineDir = path.resolve(repoRoot, current.ENGINE_DIR ?? "engine");
    // A path is relative to the repo (runEngine spawns with cwd=engineDir); a bare name is a PATH lookup.
    const configured = current.ENGINE_PYTHON;
    const enginePython = configured
      ? /[\\/]/.test(configured)
        ? path.resolve(repoRoot, configured)
        : configured
      : process.platform === "win32"
        ? path.join(engineDir, ".venv", "Scripts", "python.exe")
        : path.join(engineDir, ".venv", "bin", "python");
    pathsCache = {
      repoRoot,
      webRoot,
      dataDir,
      storageRoot: path.join(dataDir, "storage"),
      workRoot: path.join(dataDir, "work"),
      engineDir,
      enginePython,
      bundledFontsDir: path.join(webRoot, "fonts"),
    };
  }
  return pathsCache;
}

/** Forget the parsed env so the next read sees process.env again (tests). */
export function resetEnv() {
  envCache = null;
  pathsCache = null;
}

function lazy<T extends object>(load: () => T): T {
  return new Proxy({} as T, { get: (_target, key) => load()[key as keyof T] });
}

export const env: Env = lazy(loadEnv);
export const paths: Paths = lazy(loadPaths);
