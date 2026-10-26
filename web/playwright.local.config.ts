import { defineConfig } from "@playwright/test";
import base, { serverEnv } from "./playwright.config";

const port = process.env.PLAYWRIGHT_PORT ?? "3100";

// Opt-in: runs the real worker, so it needs the Python engine, ffmpeg and Anthropic + AssemblyAI keys.
export default defineConfig(base, {
  testMatch: "local-workflow.spec.ts",
  testIgnore: [],
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  use: { locale: "en-US", video: "off" },
  webServer: {
    command: `pnpm exec concurrently -k -n web,worker "next dev --hostname 127.0.0.1 --port ${port}" "tsx src/worker/main.ts"`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    env: serverEnv,
  },
});
