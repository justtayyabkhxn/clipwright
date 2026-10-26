import { defineConfig } from "@playwright/test";

// Seeded specs need a MongoDB replica set (a local `mongod --replSet rs0` or an Atlas test database).
// Global setup reads these too, so the defaults live on process.env.
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017/?directConnection=true";
process.env.MONGODB_DB ??= "clipwright_e2e";

const port = process.env.PLAYWRIGHT_PORT ?? "3100";
const baseURL = `http://127.0.0.1:${port}`;

export const serverEnv = {
  ...process.env,
  MONGODB_URI: process.env.MONGODB_URI,
  MONGODB_DB: process.env.MONGODB_DB,
  BETTER_AUTH_URL: baseURL,
  NEXT_PUBLIC_APP_URL: baseURL,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "clipwright_e2e_better_auth_secret_0123456789",
} as Record<string, string>;

export default defineConfig({
  testDir: "./e2e",
  // editor-studio needs ffmpeg on PATH; local-workflow needs real keys (playwright.local.config.ts).
  testIgnore: ["editor-studio.spec.ts", "local-workflow.spec.ts"],
  fullyParallel: false,
  retries: 0,
  // `next dev` compiles each route on first visit, which can outlast the 5s default.
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    locale: "en-US",
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
  },
  webServer: {
    command: `pnpm exec next dev --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    env: serverEnv,
  },
});
