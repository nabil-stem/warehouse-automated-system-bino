import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.LANDING_URL || "http://127.0.0.1:5173/";
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  page.on("console", message => {
    if (message.type() === "error") errors.push(message.text());
  });

  const response = await page.goto(base, { waitUntil: "networkidle" });
  assert.equal(response.status(), 200);
  assert.match(await page.title(), /BINO/);
  assert.match(await page.locator("footer").innerText(), /June 2026.*Nabil ES-SAADI/s);
  assert.match(await page.locator("footer").innerText(), /Capgemini competition/);

  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const state = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      imageLoaded: document.querySelector(".hero-visual img").naturalWidth > 0,
      simulatorLoaded: performance.getEntriesByType("resource")
        .some(resource => /\/models\/|\/assets\/simulator-|\/src\/main\.ts/.test(resource.name)),
    }));
    assert.ok(state.scrollWidth <= width, `Horizontal overflow at ${width}px`);
    assert.ok(state.imageLoaded, "Preview image did not load");
    assert.equal(state.simulatorLoaded, false, "Homepage loaded simulator resources");
    console.log(`PASS homepage at ${width}px: no overflow, image loaded, simulator deferred`);
    if (width === 390) await page.screenshot({ path: "scripts/landing-mobile.png", fullPage: true });
  }
  await page.screenshot({ path: "scripts/landing-desktop.png", fullPage: true });

  const brokenAnchors = await page.locator('a[href^="#"]').evaluateAll(links =>
    links.filter(link => !document.querySelector(link.getAttribute("href")))
      .map(link => link.getAttribute("href"))
  );
  assert.deepEqual(brokenAnchors, []);
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(":focus").innerText(), "Skip to content");

  await page.getByRole("link", { name: "Launch the simulator", exact: true }).click();
  await page.waitForSelector(".viewport canvas");
  assert.equal(new URL(page.url()).pathname.replace(/\/$/, ""), "/simulator");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector(".status-bar")?.textContent?.includes("Loaded STEP"));
  console.log("PASS simulator launch, direct refresh, and CAD reference loading");

  await page.getByRole("link", { name: "BINO project home" }).click();
  await page.getByRole("link", { name: "Run the jury demo", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#cmd-toggle-lbl")?.textContent === "Pause"
    && document.querySelector(".comp-kpi-val")?.textContent !== "0/0");
  const collisions = await page.locator(".comp-kpi").filter({
    has: page.locator(".comp-kpi-label", { hasText: /^Collisions$/ }),
  }).locator(".comp-kpi-val").innerText();
  assert.equal(collisions.trim(), "0", "Expected zero physical collisions after demo startup");
  assert.deepEqual(errors, [], "Browser errors were reported");
  console.log("PASS homepage return, automatic jury demo, zero startup collisions, and no browser errors");
} finally {
  await browser.close();
}
