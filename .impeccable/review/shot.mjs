import { chromium } from "@playwright/test";
const browser = await chromium.launch();
for (const [name, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]]) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto("http://localhost:3000/", { waitUntil: "networkidle" });
  await page.waitForSelector("#posting", { timeout: 60000 });
  await page.locator("#posting ol").scrollIntoViewIfNeeded();
  await page.waitForTimeout(8000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);
  await page.screenshot({ path: `../.impeccable/review/${name}.png`, fullPage: true });
}
await browser.close();
