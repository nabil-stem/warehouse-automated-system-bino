import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = (process.env.PREVIEW_URL || "http://127.0.0.1:4174/simulator/").replace(/\/simulator\/?$/, "");
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1476, height: 1068 }, deviceScaleFactor: 1 });
  await page.goto(`${baseUrl}/simulator/?demo=jury`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector(".status-bar")?.textContent?.includes("Jury Demo"));
  await page.waitForTimeout(3200);

  // Select Robot R01 so the telemetry inspector card with battery/lift bars is shown
  const quickChip = await page.$('[data-quick-robot="1"]');
  if (quickChip) await quickChip.click();
  await page.waitForTimeout(300);

  // 1. Capture 3D scene-workspace preview image (1476x1068 aspect)
  await page.locator(".scene-workspace").screenshot({
    path: "public/images/warehouse-preview.jpg",
    type: "jpeg",
    quality: 92,
  });
  console.log("Saved public/images/warehouse-preview.jpg");

  // 2. Capture full 1440x900 desktop simulator workspace during live Jury Demo (Operations tab)
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click('button.tab-btn[data-tab="operations"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: "public/images/simulator-workspace-live.png", fullPage: false });
  console.log("Saved public/images/simulator-workspace-live.png");

  // 3. Switch to Aisle camera + Missions tab for aisle & mission control inspection view
  await page.click('button[data-cam="aisle"]');
  await page.click('button.tab-btn[data-tab="missions"]');
  await page.waitForTimeout(800);
  await page.screenshot({ path: "public/images/simulator-aisle-inspection.png", fullPage: false });
  console.log("Saved public/images/simulator-aisle-inspection.png");

  // 4. Verify mobile simulator layout at 390x844
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(mobileOverflow, false, "Mobile simulator has horizontal overflow");
  const isOpen = await page.evaluate(() => document.getElementById("app-shell")?.classList.contains("drawer-open"));
  if (isOpen) {
    await page.click('[data-cmd="toggle-drawer"]');
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: "scripts/simulator-mobile.png", fullPage: false });
  console.log("Verified and saved scripts/simulator-mobile.png");

  await page.close();
} finally {
  await browser.close();
}
