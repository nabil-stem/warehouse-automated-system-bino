import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.PROMO_URL || "http://127.0.0.1:5173/simulator/";
const OUT_DIR = path.resolve("promo");
const RECORD_DIR = path.join(OUT_DIR, "recordings");
const VIEWPORT = { width: 1600, height: 900 };

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function installPromoOverlay(page) {
  await page.addStyleTag({
    content: `
      #promo-vignette {
        position: fixed;
        inset: 0;
        z-index: 9996;
        pointer-events: none;
        background:
          linear-gradient(90deg, rgba(0, 0, 0, 0.68), transparent 46%, rgba(0, 0, 0, 0.1)),
          radial-gradient(circle at 18% 78%, rgba(80, 241, 207, 0.18), transparent 30%);
      }
      #promo-overlay {
        position: fixed;
        left: 34px;
        bottom: 34px;
        z-index: 9997;
        width: min(720px, calc(100vw - 76px));
        padding: 21px 24px 22px;
        border-left: 4px solid #50f1cf;
        background: linear-gradient(90deg, rgba(5, 12, 17, 0.91), rgba(5, 12, 17, 0.66));
        box-shadow: 0 18px 60px rgba(0, 0, 0, 0.38);
        opacity: 0;
        transform: translateY(18px);
        transition: opacity 320ms ease, transform 320ms ease;
        pointer-events: none;
      }
      #promo-overlay.show {
        opacity: 1;
        transform: translateY(0);
      }
      #promo-kicker {
        color: #50f1cf;
        font: 800 13px/1.1 Inter, system-ui, sans-serif;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        margin-bottom: 8px;
      }
      #promo-title {
        color: #fff;
        font: 850 44px/1.03 Inter, system-ui, sans-serif;
        letter-spacing: 0;
        margin-bottom: 9px;
      }
      #promo-subtitle {
        color: #dce7ee;
        font: 520 19px/1.36 Inter, system-ui, sans-serif;
      }
      #promo-badge {
        position: fixed;
        right: 34px;
        top: 28px;
        z-index: 9997;
        color: #061114;
        background: #50f1cf;
        border-radius: 6px;
        padding: 10px 14px;
        font: 850 15px/1 Inter, system-ui, sans-serif;
        box-shadow: 0 10px 34px rgba(80, 241, 207, 0.28);
      }
      #promo-progress {
        position: fixed;
        left: 34px;
        top: 28px;
        z-index: 9997;
        width: 360px;
        padding: 12px 14px;
        border: 1px solid rgba(80, 241, 207, 0.28);
        border-radius: 7px;
        background: rgba(7, 14, 19, 0.82);
        color: #eaf2f6;
        font: 700 13px/1.25 Inter, system-ui, sans-serif;
        opacity: 0;
        transition: opacity 280ms ease;
        pointer-events: none;
      }
      #promo-progress.show { opacity: 1; }
      #promo-progress .bar {
        height: 7px;
        margin-top: 8px;
        border-radius: 99px;
        background: rgba(255,255,255,0.13);
        overflow: hidden;
      }
      #promo-progress .fill {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #50f1cf, #f5c542);
        transition: width 360ms ease;
      }
      .mission-row-v2.done {
        outline: 1px solid rgba(80, 241, 207, 0.7);
        box-shadow: 0 0 22px rgba(80, 241, 207, 0.18);
      }
    `,
  });

  await page.evaluate(() => {
    const vignette = document.createElement("div");
    vignette.id = "promo-vignette";
    const badge = document.createElement("div");
    badge.id = "promo-badge";
    badge.textContent = "Warehouse Swarm Lab";
    const progress = document.createElement("div");
    progress.id = "promo-progress";
    progress.innerHTML = `<div id="promo-progress-label">Mission progress</div><div class="bar"><div class="fill"></div></div>`;
    const overlay = document.createElement("div");
    overlay.id = "promo-overlay";
    overlay.innerHTML = `
      <div id="promo-kicker">mission execution</div>
      <div id="promo-title"></div>
      <div id="promo-subtitle"></div>
    `;
    document.body.append(vignette, badge, progress, overlay);
  });
}

async function setCaption(page, title, subtitle = "") {
  await page.evaluate(({ title, subtitle }) => {
    const titleEl = document.querySelector("#promo-title");
    const subEl = document.querySelector("#promo-subtitle");
    const wrap = document.querySelector("#promo-overlay");
    if (!titleEl || !subEl || !wrap) return;
    titleEl.textContent = title;
    subEl.textContent = subtitle;
    wrap.classList.add("show");
  }, { title, subtitle });
}

async function clearCaption(page) {
  await page.evaluate(() => document.querySelector("#promo-overlay")?.classList.remove("show"));
}

async function setProgress(page, label, pct) {
  await page.evaluate(({ label, pct }) => {
    const progress = document.querySelector("#promo-progress");
    const labelEl = document.querySelector("#promo-progress-label");
    const fill = document.querySelector("#promo-progress .fill");
    if (!progress || !labelEl || !fill) return;
    labelEl.textContent = label;
    fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    progress.classList.add("show");
  }, { label, pct });
}

async function clickIfPresent(page, selector, timeout = 1800) {
  const handle = await page.waitForSelector(selector, { timeout }).catch(() => undefined);
  if (!handle) return false;
  await page.evaluate(el => el.click(), handle);
  await handle.dispose();
  await page.waitForTimeout(170);
  return true;
}

async function setControlValue(page, selector, value) {
  await page.evaluate(({ selector, value }) => {
    const el = document.querySelector(selector);
    if (!el) return;
    el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, { selector, value });
}

async function showTab(page, tab) {
  await clickIfPresent(page, `button.tab-btn[data-tab="${tab}"]`);
  await page.waitForTimeout(450);
}

async function dragScene(page, dx, dy) {
  const box = await page.locator("canvas").first().boundingBox();
  if (!box) return;
  const x = box.x + box.width * 0.45;
  const y = box.y + box.height * 0.46;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 28 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

async function missionPhaseText(page) {
  return page.evaluate(() => {
    const first = document.querySelector(".mission-row-v2");
    return first?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  });
}

async function waitUntilPhase(page, matcher, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await missionPhaseText(page);
    if (matcher(text.toLowerCase())) return text;
    await page.waitForTimeout(450);
  }
  return missionPhaseText(page);
}

async function main() {
  await ensureDir(RECORD_DIR);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: RECORD_DIR, size: VIEWPORT },
  });
  const page = await context.newPage();

  page.on("console", msg => {
    if (msg.type() === "error") console.error(`browser console error: ${msg.text()}`);
  });

  await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector("canvas", { timeout: 15000 });
  await page.waitForTimeout(1600);
  await installPromoOverlay(page);

  await setCaption(page, "From order to completion", "Watch one warehouse mission move through planning, navigation, lift pickup, delivery, and trace export.");
  await setProgress(page, "Mission M-0001 waiting for dispatch", 5);
  await wait(2600);
  await clearCaption(page);

  await showTab(page, "layout");
  await clickIfPresent(page, 'button[data-cam="aisle"]');
  await dragScene(page, -180, -45);
  await setCaption(page, "Aisles built for AMRs", "Grey totes stay inside the racks while QR lanes and yield bays keep the robot corridor clear.");
  await wait(2800);
  await clearCaption(page);

  await showTab(page, "missions");
  await setControlValue(page, 'select[data-field="routing"]', "reservation-table");
  await setControlValue(page, 'select[data-field="allocator"]', "eta-optimal");
  await setControlValue(page, 'input[data-field="timeScale"]', 5);
  await setControlValue(page, 'input[data-field="maxActiveMissions"]', 3);
  await setProgress(page, "ETA allocator and reservation routing armed", 12);
  await setCaption(page, "Mission selected", "The planner chooses an available scissor-lift robot and reserves a collision-safe route.");
  await wait(2600);
  await clearCaption(page);

  await clickIfPresent(page, 'button[data-action="dispatch-highest"]');
  await setProgress(page, "Dispatch: high shelf pickup assigned", 22);
  await setCaption(page, "Dispatch high shelf", "The source is on the upper rack level, so the scissor lift will extend only when the robot reaches the shelf.");
  await wait(2600);
  await clearCaption(page);

  await waitUntilPhase(page, text => text.includes("drive to pick") || text.includes("wait clearance"), 6000);
  await setProgress(page, "Driving to pick location", 35);
  await setCaption(page, "Route execution", "Predictive reservations and the traffic supervisor keep other robots out of the mission path.");
  await wait(4200);
  await clearCaption(page);

  await waitUntilPhase(page, text => text.includes("lift") || text.includes("picking") || text.includes("lowering"), 14000);
  await setProgress(page, "Scissor lift pickup in progress", 55);
  await setCaption(page, "Lift only when needed", "The robot aligns at the rack, opens the multi-stage scissor lift, picks the tote, then lowers for travel.");
  await wait(5200);
  await clearCaption(page);

  await showTab(page, "robots");
  await clickIfPresent(page, 'button[data-action="robot-camera"]');
  await setProgress(page, "Payload loaded: driving to drop-off", 72);
  await setCaption(page, "Robot camera", "Switch to the robot view to inspect the route from the AMR perspective during the live mission.");
  await wait(4600);
  await clickIfPresent(page, 'button[data-action="stop-robot-camera"]');
  await clearCaption(page);

  await showTab(page, "missions");
  await waitUntilPhase(page, text => text.includes("done") || text.includes("placing") || text.includes("drive to drop"), 18000);
  await setProgress(page, "Drop-off and placement", 88);
  await setCaption(page, "Delivery phase", "The robot reaches the target station, places the tote, and prepares to return to standby.");
  await wait(4300);
  await clearCaption(page);

  await waitUntilPhase(page, text => text.includes("done"), 22000);
  await setProgress(page, "Mission complete: trace recorded", 100);
  await setCaption(page, "Mission accomplished", "Completion time, wait ticks, route distance, lift telemetry, and mission trace are ready for analysis.");
  await wait(4300);
  await clearCaption(page);

  await showTab(page, "debug");
  await setCaption(page, "Traffic proof", "Deadlocks, queues, supervisor commands, reservations, and obstacle checks are visible for competition-level validation.");
  await wait(3600);
  await clearCaption(page);

  await showTab(page, "export");
  await setCaption(page, "Replay and export", "Download mission traces, logs, GLB, SDF world, screenshots, and the Text-to-CAD prompt.");
  await wait(3800);

  await showTab(page, "missions");
  await setCaption(page, "Warehouse Swarm Lab", "A mission-first 3D simulator for robot warehouse design, traffic control, and scissor-lift AMR operations.");
  await wait(4300);

  const video = page.video();
  await page.close();
  await context.close();
  await browser.close();

  const videoPath = await video.path();
  const missionPath = path.join(OUT_DIR, "warehouse-swarm-lab-mission-promo.webm");
  const legacyPath = path.join(OUT_DIR, "warehouse-swarm-lab-promo.webm");
  await fs.copyFile(videoPath, missionPath);
  await fs.copyFile(videoPath, legacyPath);
  console.log(`Mission promo video saved: ${missionPath}`);
  console.log(`Updated promo video saved: ${legacyPath}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
