import { defineConfig } from "@playwright/test";

// The full stack (in-memory Mongo, fake Anthropic + AssemblyAI, next dev, the worker and the Python
// engine) is started by e2e/global-setup.ts; it needs engine/.venv and ffmpeg on PATH, no API keys.
// The spec reads the app URL from E2E_BASE_URL, which global setup sets.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // One long journey: about 8 min on an idle machine, much more when the CPU is shared.
  timeout: 1_500_000,
  // `next dev` compiles each route on first visit.
  expect: { timeout: 30_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    locale: "en-US",
    acceptDownloads: true,
    navigationTimeout: 120_000,
    actionTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium", headless: true } }],
});
