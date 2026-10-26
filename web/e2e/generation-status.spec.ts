import { expect, test } from "@playwright/test";

const queuedTask = {
  id: "new-task", user_id: "user", source_id: "new-task", source_title: "YouTube Video", source_type: "youtube",
  source_url: "https://www.youtube.com/watch?v=abcdefghijk", status: "queued", progress: 0, progress_message: "",
  clips_count: 0, created_at: "2026-10-26T10:00:00Z", updated_at: "2026-10-26T10:00:00Z",
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/get-session**", route => route.fulfill({ json: {
    session: { id: "session", userId: "user", expiresAt: "2099-01-01T00:00:00Z" },
    user: { id: "user", name: "Alex", email: "alex@example.com", emailVerified: true },
  } }));
  await page.route(/\/api\/tasks\/?(\?.*)?$/, route => route.fulfill({ json: { tasks: [] } }));
  await page.route("**/api/fonts", route => route.fulfill({ json: { fonts: [] } }));
  await page.route("**/api/caption-templates", route => route.fulfill({ json: { templates: [] } }));
  await page.route("**/api/preferences", route => route.fulfill({ json: { fontFamily: "TikTokSans-Regular", fontSize: 24, fontColor: "#FFFFFF", clipLength: "auto" } }));
  await page.route("**/api/ai/provider", route => route.fulfill({ json: { provider: "anthropic", model: "claude-opus-5", configured: true, transcription_configured: true } }));
  await page.route("**/api/tasks/create", route => route.fulfill({ json: { task_id: "new-task", job_id: "job", message: "queued", worker_online: false } }));
  await page.route("**/api/tasks/new-task", route => route.fulfill({ json: queuedTask }));
});

for (const viewport of [{ name: "desktop", width: 1440, height: 900 }, { name: "mobile", width: 390, height: 844 }]) {
  test(`starts a generation and explains a stopped worker on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Good .*Alex|Up late, Alex/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.locator("#youtube-url").fill("https://www.youtube.com/watch?v=abcdefghijk");
    await page.getByRole("button", { name: "Generate clips" }).click();

    await page.waitForURL("**/tasks/new-task");
    await expect(page.getByText("The Clipwright worker isn't running. Start it with pnpm dev (or pnpm worker).")).toBeVisible();
    await expect(page.getByText("Waiting in queue")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
