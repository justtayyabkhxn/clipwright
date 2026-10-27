// One user journey through the real stack (see global-setup.ts): sign up, configure keys, upload,
// generate, play, export, edit, autosave, server export, library, delete.
import { execFileSync } from "node:child_process";
import { expect, test, type Download, type Page } from "@playwright/test";
import { FAKE_HOOK_TITLES } from "./fakes/anthropic";

test.use({ baseURL: process.env.E2E_BASE_URL });

type Clip = { id: string; filename: string; duration: number; start_time: string; end_time: string; hook_title: string | null };

const videoStream = (file: string) => {
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8" }));
  return { video: probe.streams.find((s: { codec_type: string }) => s.codec_type === "video"), duration: Number(probe.format.duration) };
};

async function savedFile(download: Download, name: string) {
  const file = test.info().outputPath(name);
  await download.saveAs(file);
  return file;
}

async function readyState(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((v) => (v as HTMLVideoElement).readyState);
}

test("upload to clips, export, edit, autosave, server export, library and delete", async ({ page }) => {
  const step = async <T>(name: string, body: () => Promise<T>) => {
    const t0 = Date.now();
    const result = await test.step(name, body);
    console.log(`[e2e] ${name}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return result;
  };

  await step("sign up (first user becomes admin)", async () => {
    await page.goto("/sign-up");
    await page.getByPlaceholder("Full Name").fill("E2E Admin");
    await page.getByPlaceholder("Email").fill(`e2e-${Date.now()}@clipwright.test`);
    await page.getByPlaceholder("Password").fill("E2ePassword123!");
    await page.getByRole("button", { name: "Sign Up", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 120_000 });
  });

  await step("settings: save keys, test connection", async () => {
    await page.goto("/settings");
    const anthropicKey = page.locator("#anthropic-key");
    const connected = page.getByRole("status").filter({ hasText: "Connected. Connected to Anthropic." });
    await anthropicKey.fill("sk-ant-e2e-dummy-key-0000");
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(connected).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Claude settings saved.")).toBeVisible();
    await expect(page.locator("#anthropic-key-status")).toHaveText("Ready");
    await page.locator("#assemblyai-key").fill("e2e-dummy-assemblyai-key");
    await page.getByRole("button", { name: "Save key", exact: true }).click();
    await expect(page.getByText("AssemblyAI key saved.")).toBeVisible();
    await expect(page.locator("#assemblyai-key-status")).toHaveText("Ready");
    // The saved key (not the form value) passes the test too.
    await page.reload();
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(connected).toBeVisible();
  });

  const taskId = await step("home: upload and generate", async () => {
    await page.goto("/");
    await page.locator("#video-upload").setInputFiles(process.env.E2E_VIDEO!);
    await page.getByRole("button", { name: "Generate clips", exact: true }).click();
    await page.waitForURL(/\/tasks\/[^/]+$/, { timeout: 120_000 });
    return new URL(page.url()).pathname.split("/").pop()!;
  });

  const clips = await step("task page: progress until 2 clips", async () => {
    // The processing panel appears while the worker runs, then the finished wall replaces it.
    await expect(page.getByText(/% complete|Waiting in queue/).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: /^Download / })).toHaveCount(2, { timeout: 300_000 });
    await expect(page.getByRole("link", { name: "Open Editor" })).toBeVisible();
    const task = await (await page.request.get(`/api/tasks/${taskId}`)).json();
    expect(task.status).toBe("completed");
    const body = await (await page.request.get(`/api/tasks/${taskId}/clips`)).json();
    const list = body.clips as Clip[];
    expect(list).toHaveLength(2);
    for (const clip of list) expect(clip.duration).toBeGreaterThanOrEqual(14);
    expect(list.map((clip) => clip.hook_title).sort()).toEqual([...FAKE_HOOK_TITLES].sort());
    return list;
  });

  await step("clip plays; original download is video/mp4", async () => {
    await page.getByRole("button", { name: /^Preview / }).first().click();
    const dialogVideo = '[role="dialog"] video';
    await expect.poll(() => readyState(page, dialogVideo), { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    await page.keyboard.press("Escape");
    const response = await page.request.get(`/api/tasks/${taskId}/clips/${clips[0].id}/file?download=true`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("video/mp4");
    // The "Original" format downloads through the browser too.
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: /^Download / }).first().click();
    const file = await savedFile(await download, "original.mp4");
    expect(videoStream(file).video).toBeTruthy();
  });

  await step("tiktok preset export downloads", async () => {
    await page.getByRole("combobox", { name: "Download format" }).click();
    await page.getByRole("option", { name: "TikTok" }).click();
    const download = page.waitForEvent("download", { timeout: 240_000 });
    await page.getByRole("button", { name: /^Download / }).first().click();
    const file = await savedFile(await download, "tiktok.mp4");
    expect((await download).suggestedFilename()).toMatch(/_tiktok\.mp4$/);
    expect(videoStream(file).video).toMatchObject({ width: 1080, height: 1920 });
  });

  const clipId = clips[0].id;
  const editorUrl = `/tasks/${taskId}/edit?clip=${clipId}`;
  const hookTitle = page.getByRole("textbox", { name: "Hook title" });
  const size = page.getByRole("slider", { name: "Subtitle size", exact: true });
  const saved = page.getByRole("status").filter({ hasText: "All changes saved" });
  let sizeAfter = "";

  await step("editor: preview ready", async () => {
    await page.goto(editorUrl);
    await expect(hookTitle).toBeVisible({ timeout: 240_000 });
    await expect.poll(() => readyState(page, "video"), { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
  });

  await step("editor: edit hook title and caption size, autosave, reload", async () => {
    await hookTitle.fill("Edited by the e2e test");
    const before = Number(await size.getAttribute("aria-valuenow"));
    await size.focus();
    for (let i = 0; i < 4; i++) await size.press("ArrowRight");
    sizeAfter = (await size.getAttribute("aria-valuenow"))!;
    expect(Number(sizeAfter)).toBeGreaterThan(before);
    await expect(saved).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await expect(hookTitle).toHaveValue("Edited by the e2e test", { timeout: 120_000 });
    await expect(size).toHaveAttribute("aria-valuenow", sizeAfter);
  });

  await step("editor: server export completes and downloads", async () => {
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await page.getByRole("button", { name: /Background export/ }).click();
    await page.getByRole("button", { name: "Export clip", exact: true }).click();
    const link = page.getByRole("link", { name: "Download" });
    await expect(link).toBeVisible({ timeout: 300_000 });
    const download = page.waitForEvent("download");
    await link.click();
    const file = await savedFile(await download, "editor-export.mp4");
    const media = videoStream(file);
    expect(media.video).toBeTruthy();
    expect(media.duration).toBeGreaterThan(10);
  });

  await step("library lists the task", async () => {
    await page.goto("/list");
    await expect(page.locator(`a[href="/tasks/${taskId}"]`).first()).toBeVisible();
  });

  await step("delete a clip", async () => {
    await page.goto(`/tasks/${taskId}`);
    await expect(page.getByRole("button", { name: /^Download / })).toHaveCount(2);
    await page.getByRole("button", { name: "Delete clip" }).first().click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Download / })).toHaveCount(1);
    const body = await (await page.request.get(`/api/tasks/${taskId}/clips`)).json();
    expect(body.clips).toHaveLength(1);
  });

  await step("delete the task", async () => {
    await page.getByRole("button", { name: "Delete generation" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click();
    await page.waitForURL((url) => !url.pathname.startsWith(`/tasks/${taskId}`));
    expect((await page.request.get(`/api/tasks/${taskId}`)).status()).toBe(404);
  });
});
