/** @vitest-environment node */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { env, loadEnv, paths, resetEnv } from "./env";

const baseEnv = { ...process.env };
const REQUIRED = { NODE_ENV: "test" as const, MONGODB_URI: "mongodb://localhost/x", BETTER_AUTH_SECRET: "s".repeat(32) };

function useEnv(values: Record<string, string>) {
  process.env = { ...REQUIRED, ...values };
  resetEnv();
}

afterEach(() => {
  process.env = baseEnv;
  resetEnv();
});

describe("env", () => {
  it("applies the documented defaults", () => {
    useEnv({});
    expect(loadEnv()).toMatchObject({
      MONGODB_DB: "clipwright",
      MONGODB_TRANSACTIONS: true,
      BETTER_AUTH_URL: "http://localhost:3000",
      ADMIN_EMAILS: "",
      DISABLE_SIGN_UP: false,
      STORAGE_DRIVER: "local",
      WORKER_CONCURRENCY: 1,
      MAX_VIDEO_DURATION: 5400,
      MAX_VIDEO_UPLOAD_BYTES: 4_000_000_000,
      MAX_CLIPS: 10,
      CLIP_DURATION: 30,
      TRANSCRIPTION_LANGUAGE: "",
      ASSEMBLY_AI_HTTP_TIMEOUT_SECONDS: 900,
      SPEAKER_FRAMING: true,
      HOOK_FIRST_TEASER: false,
      YOUTUBE_MAX_HEIGHT: 1080,
    });
    expect(env.CLAUDE_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("trims values, treats blanks as unset and parses flags leniently", () => {
    useEnv({
      ANTHROPIC_API_KEY: "  ",
      CLAUDE_MODEL: " claude-sonnet-5 ",
      DISABLE_SIGN_UP: "yes",
      SPEAKER_FRAMING: "off",
      HOOK_FIRST_TEASER: "maybe",
      MAX_CLIPS: "4",
      TRANSCRIPTION_LANGUAGE: "en-US",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_MODEL).toBe("claude-sonnet-5");
    expect(env.DISABLE_SIGN_UP).toBe(true);
    expect(env.SPEAKER_FRAMING).toBe(false);
    expect(env.HOOK_FIRST_TEASER).toBe(false);
    expect(env.MAX_CLIPS).toBe(4);
    expect(env.TRANSCRIPTION_LANGUAGE).toBe("en_us");
    useEnv({ TRANSCRIPTION_LANGUAGE: "auto" });
    expect(env.TRANSCRIPTION_LANGUAGE).toBe("");
  });

  it("reports missing or weak required values on first use", () => {
    process.env = { NODE_ENV: "test" };
    resetEnv();
    expect(() => env.MONGODB_URI).toThrow(/MONGODB_URI is required/);
    useEnv({ BETTER_AUTH_SECRET: "short" });
    expect(() => loadEnv()).toThrow(/BETTER_AUTH_SECRET must be at least 32 characters/);
    useEnv({ MAX_CLIPS: "lots" });
    expect(() => loadEnv()).toThrow(/MAX_CLIPS/);
  });

  it("resolves paths from the repository root", () => {
    useEnv({});
    const repoRoot = path.dirname(process.cwd());
    expect(paths.repoRoot).toBe(repoRoot);
    expect(paths.dataDir).toBe(path.join(repoRoot, "data"));
    expect(paths.storageRoot).toBe(path.join(repoRoot, "data", "storage"));
    expect(paths.workRoot).toBe(path.join(repoRoot, "data", "work"));
    expect(paths.engineDir).toBe(path.join(repoRoot, "engine"));
    expect(paths.bundledFontsDir).toBe(path.join(process.cwd(), "fonts"));
    const venvPython = process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"];
    expect(paths.enginePython).toBe(path.join(repoRoot, "engine", ".venv", ...venvPython));

    const absolute = path.resolve("/opt/py/bin/python3");
    useEnv({ DATA_DIR: "scratch", ENGINE_PYTHON: absolute });
    expect(paths.dataDir).toBe(path.join(repoRoot, "scratch"));
    expect(paths.enginePython).toBe(absolute);
    useEnv({ ENGINE_PYTHON: "engine/.venv/Scripts/python.exe" });
    expect(paths.enginePython).toBe(path.join(repoRoot, "engine", ".venv", "Scripts", "python.exe"));
    useEnv({ ENGINE_PYTHON: "python3.12" });
    expect(paths.enginePython).toBe("python3.12");
  });
});
