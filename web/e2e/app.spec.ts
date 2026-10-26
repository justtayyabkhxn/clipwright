import fs from "fs";
import path from "path";

import { expect, test } from "@playwright/test";

const seed = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".seed.json"), "utf8"),
);

async function signIn(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/sign-in");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL("**/");
}

test("signed-out visitors are sent to sign in", async ({ page }) => {
  await page.goto("/");
  await page.waitForURL("**/sign-in");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Based on SupoClip/ })).toBeVisible();
});

test("regular user can browse seeded tasks and save caption defaults", async ({ page }) => {
  // This flow compiles several routes (list, task, settings) on its first visit to the dev server.
  test.setTimeout(120_000);
  await signIn(page, seed.regular.email, seed.regular.password);

  await page.goto("/list");
  await expect(page.getByText(seed.completedSourceTitle)).toBeVisible();

  await page.goto(`/tasks/${seed.completedTaskId}`);
  await page.getByRole("button", { name: "Preview Clip 1", exact: true }).click();
  const preview = page.getByRole("dialog");
  await expect(preview.getByText("This is a seeded clip", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(preview).not.toBeVisible();

  await page.goto("/settings");
  await expect(page.getByText("Only an administrator can change these keys.")).toBeVisible();
  await page.getByRole("button", { name: "Caption color #FFD700" }).click();
  await page.getByRole("button", { name: /save preferences/i }).click();
  await expect(page.getByText(/preferences saved/i)).toBeVisible();
});

test("admin user can configure the Claude and AssemblyAI keys", async ({ page }) => {
  await signIn(page, seed.admin.email, seed.admin.password);

  await page.goto("/settings");
  await expect(page.getByLabel("Anthropic API key")).toBeVisible();
  await expect(page.getByLabel("AssemblyAI API key")).toBeVisible();
});
