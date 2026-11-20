import { chromium } from "playwright";
import path from "node:path";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 1 });

await page.goto("http://127.0.0.1:5173/simulator/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1200);

await page.getByRole("button", { name: "Missions" }).click();
await page.locator('input[data-field="timeScale"]').fill("5");
await page.getByText("Dispatch Highest Shelf", { exact: true }).click();
await page.waitForTimeout(8500);

const out = path.resolve("scripts/blue_robot_dark_tote_preview.png");
await page.screenshot({ path: out, fullPage: false });
console.log(out);

await browser.close();
