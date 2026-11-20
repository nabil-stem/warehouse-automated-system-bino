import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.PROMO_URL || "http://127.0.0.1:5173/simulator/";
const OUT_DIR = path.resolve("promo");
const RECORD_DIR = path.join(OUT_DIR, "recordings");
const VIEWPORT = { width: 1280, height: 720 };

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function pause(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function installOverlay(page) {
  await page.addStyleTag({
    content: `
      #solo-shade {
        position: fixed;
        inset: 0;
        z-index: 9994;
        pointer-events: none;
        background:
          linear-gradient(90deg, rgba(0,0,0,.58), transparent 46%, rgba(0,0,0,.08)),
          radial-gradient(circle at 18% 78%, rgba(31,122,224,.25), transparent 30%);
      }
      #solo-title {
        position: fixed;
        left: 32px;
        bottom: 26px;
        z-index: 9995;
        width: min(640px, calc(100vw - 64px));
        padding: 18px 22px;
        border-left: 4px solid #5aa9ff;
        background: linear-gradient(90deg, rgba(6,12,18,.93), rgba(6,12,18,.62));
        box-shadow: 0 18px 60px rgba(0,0,0,.42);
        transform: translateY(16px);
        opacity: 0;
        transition: opacity .28s ease, transform .28s ease;
        pointer-events: none;
      }
      #solo-title.show { opacity: 1; transform: translateY(0); }
      #solo-kicker {
        color: #5aa9ff;
        font: 850 13px/1 Inter, system-ui, sans-serif;
        letter-spacing: .12em;
        text-transform: uppercase;
        margin-bottom: 9px;
      }
      #solo-head {
        color: white;
        font: 850 34px/1.04 Inter, system-ui, sans-serif;
        margin-bottom: 9px;
        letter-spacing: 0;
      }
      #solo-body {
        color: #dce8f2;
        font: 520 17px/1.36 Inter, system-ui, sans-serif;
      }
      #solo-progress {
        position: fixed;
        left: 32px;
        top: 28px;
        z-index: 9995;
        width: 380px;
        padding: 12px 14px;
        border: 1px solid rgba(90,169,255,.34);
        border-radius: 7px;
        background: rgba(5, 12, 18, .86);
        color: #eef7ff;
        font: 760 13px/1.25 Inter, system-ui, sans-serif;
        pointer-events: none;
      }
      #solo-progress .rail {
        height: 7px;
        margin-top: 8px;
        border-radius: 99px;
        background: rgba(255,255,255,.13);
        overflow: hidden;
      }
      #solo-progress .fill {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #1f7ae0, #5aa9ff, #50f1cf);
        transition: width .34s ease;
      }
      #solo-badge {
        position: fixed;
        right: 34px;
        top: 28px;
        z-index: 9995;
        padding: 10px 14px;
        border-radius: 6px;
        background: #5aa9ff;
        color: #05111c;
        font: 850 15px/1 Inter, system-ui, sans-serif;
        box-shadow: 0 10px 34px rgba(90,169,255,.28);
        pointer-events: none;
      }
    `,
  });

  await page.evaluate(() => {
    const shade = document.createElement("div");
    shade.id = "solo-shade";
    const badge = document.createElement("div");
    badge.id = "solo-badge";
    badge.textContent = "Warehouse Swarm Lab";
    const progress = document.createElement("div");
    progress.id = "solo-progress";
    progress.innerHTML = `<div id="solo-progress-text">Ready</div><div class="rail"><div class="fill"></div></div>`;
    const title = document.createElement("div");
    title.id = "solo-title";
    title.innerHTML = `
      <div id="solo-kicker">one robot mission</div>
      <div id="solo-head"></div>
      <div id="solo-body"></div>
    `;
    document.body.append(shade, badge, progress, title);
  });
}

async function caption(page, head, body, progressText, pct, ms = 2800) {
  await page.evaluate(({ head, body, progressText, pct }) => {
    document.querySelector("#solo-head").textContent = head;
    document.querySelector("#solo-body").textContent = body;
    document.querySelector("#solo-progress-text").textContent = progressText;
    document.querySelector("#solo-progress .fill").style.width = `${Math.max(0, Math.min(100, pct))}%`;
    document.querySelector("#solo-title").classList.add("show");
  }, { head, body, progressText, pct });
  await pause(ms);
  await page.evaluate(() => document.querySelector("#solo-title")?.classList.remove("show"));
  await pause(350);
}

async function showTab(page, tab) {
  await page.click(`button.tab-btn[data-tab="${tab}"]`);
  await page.waitForTimeout(450);
}

async function setControl(page, selector, value) {
  await page.evaluate(({ selector, value }) => {
    const el = document.querySelector(selector);
    if (!el) return;
    el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, { selector, value });
}

async function clickIfPresent(page, selector, timeout = 1200) {
  const handle = await page.waitForSelector(selector, { timeout }).catch(() => undefined);
  if (!handle) return false;
  await page.evaluate(el => el.click(), handle);
  await handle.dispose();
  await page.waitForTimeout(250);
  return true;
}

async function phaseText(page) {
  return page.evaluate(() =>
    document.querySelector(".mission-row-v2")?.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? ""
  );
}

async function waitForPhase(page, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    text = await phaseText(page);
    if (predicate(text)) return text;
    await page.waitForTimeout(400);
  }
  return text;
}

async function promoState(page) {
  return page.evaluate(() => window.__warehousePromo?.state?.() ?? null);
}

async function waitForRobot(page, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await promoState(page);
    const robot = state?.robots?.find(r => r.id === 1);
    const mission = state?.missions?.[0];
    if (robot && predicate(robot, mission, state)) return { robot, mission, state };
    await page.waitForTimeout(250);
  }
  return { state };
}

async function setPromoCamera(page, mode, robotId = 1) {
  await page.evaluate(({ mode, robotId }) => window.__warehousePromo?.camera?.(robotId, mode), { mode, robotId });
  await page.waitForTimeout(250);
}

async function setPromoOverview(page) {
  await page.evaluate(() => window.__warehousePromo?.overview?.());
  await page.waitForTimeout(250);
}

async function dragScene(page, dx, dy) {
  const box = await page.locator("canvas").first().boundingBox();
  if (!box) return;
  const x = box.x + box.width * 0.46;
  const y = box.y + box.height * 0.45;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 26 });
  await page.mouse.up();
  await page.waitForTimeout(500);
}

async function main() {
  await ensureDir(RECORD_DIR);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: RECORD_DIR, size: VIEWPORT },
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("console", msg => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector("canvas", { timeout: 15000 });
  await page.waitForTimeout(1600);
  await installOverlay(page);

  await showTab(page, "missions");
  await setControl(page, 'select[data-field="routing"]', "reservation-table");
  await setControl(page, 'select[data-field="allocator"]', "eta-optimal");
  await setControl(page, 'input[data-field="timeScale"]', 3.2);
  await setControl(page, 'input[data-field="maxActiveMissions"]', 1);
  await clickIfPresent(page, 'button[data-cam="aisle"]');
  await dragScene(page, -120, -30);

  await caption(
    page,
    "One robot. One complete warehouse mission.",
    "A blue scissor-lift AMR receives a high-shelf pickup, reserves a route, lifts the tote, and delivers it safely.",
    "Mission profile loaded",
    8,
    3200
  );

  await page.click('button[data-action="dispatch-highest"]');
  await setPromoCamera(page, "follow-close", 1);
  await caption(
    page,
    "Mission dispatched",
    "The camera locks onto the assigned blue AMR while it starts moving toward the rack.",
    "Follow camera active",
    18,
    2200
  );

  await waitForRobot(page, robot => robot.state === "to-pick", 7000);
  await caption(
    page,
    "Driving while the camera follows",
    "The robot stays in motion while the camera tracks its heading and reserved route through the warehouse lanes.",
    "Moving to source slot",
    34,
    4200
  );

  await waitForRobot(page, robot => robot.state === "picking", 18000);
  await setControl(page, 'input[data-field="timeScale"]', 1.2);
  await setPromoCamera(page, "lift-close", 1);
  await caption(
    page,
    "Close-up: scissor lift opening",
    "The camera cuts beside the robot so the multi-stage lift extension is visible at the shelf face.",
    "Lift close-up",
    56,
    6400
  );

  await waitForRobot(page, robot => robot.carryingSlotId || robot.state === "to-drop", 18000);
  await setControl(page, 'input[data-field="timeScale"]', 3.0);
  await setPromoCamera(page, "payload-side", 1);
  await caption(
    page,
    "Payload secured, robot moving",
    "The dark tote is now on the lift deck, and the robot drives toward the station without changing the box style.",
    "Payload in motion",
    70,
    5200
  );

  await setPromoCamera(page, "robot-camera", 1);
  await caption(
    page,
    "Onboard camera view",
    "Now the view switches to the robot camera while it is still travelling, so the aisle and QR lane move through frame.",
    "Robot camera online",
    78,
    3600
  );
  await setPromoCamera(page, "payload-side", 1);

  await waitForRobot(page, robot => robot.state === "placing" || robot.state === "returning" || robot.state === "idle", 22000);
  await setPromoCamera(page, "lift-close", 1);
  await caption(
    page,
    "Delivery and placement",
    "The robot reaches the station, lowers the mechanism, and places the tote before releasing the mission.",
    "Drop-off in progress",
    90,
    4400
  );

  await waitForRobot(page, robot => robot.state === "returning" || robot.state === "idle", 24000);
  await setPromoOverview(page);
  await showTab(page, "missions");
  await caption(
    page,
    "Mission accomplished",
    "The mission completes with route distance, wait time, lift telemetry, and exportable trace data ready for review.",
    "Mission complete",
    100,
    4700
  );

  if (consoleErrors.length > 0) {
    console.warn(`Browser console errors (${consoleErrors.length}):`);
    for (const err of consoleErrors.slice(0, 5)) console.warn(err);
  }

  const video = page.video();
  await page.close();
  await context.close();
  await browser.close();

  const rawVideoPath = await video.path();
  const datedPath = path.join(OUT_DIR, "warehouse-swarm-lab-one-robot-mission.webm");
  const latestPath = path.join(OUT_DIR, "warehouse-swarm-lab-promo.webm");
  await fs.copyFile(rawVideoPath, datedPath);
  await fs.copyFile(rawVideoPath, latestPath);
  console.log(`One-robot promo video saved: ${datedPath}`);
  console.log(`Updated latest promo video saved: ${latestPath}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
