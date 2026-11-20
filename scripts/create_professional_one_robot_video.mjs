import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.PROMO_URL || "http://127.0.0.1:5173/simulator/";
const OUT_DIR = path.resolve("promo");
const RECORD_DIR = path.join(OUT_DIR, "recordings");
const VIEWPORT = { width: 1920, height: 1080 };

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function pause(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Overlay ──────────────────────────────────────────────────────────

async function installOverlay(page) {
  await page.addStyleTag({
    content: `
      @keyframes overlayFadeIn {
        from { opacity: 0; transform: translateY(14px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      @keyframes overlayFadeOut {
        from { opacity: 1; transform: translateY(0); }
        to   { opacity: 0; transform: translateY(-6px); }
      }

      #pro-shade {
        position: fixed; inset: 0; z-index: 9993; pointer-events: none;
        background:
          linear-gradient(180deg, rgba(0,0,0,.32) 0%, transparent 18%, transparent 78%, rgba(0,0,0,.42) 100%),
          linear-gradient(90deg, rgba(0,0,0,.48), transparent 38%, transparent 85%, rgba(0,0,0,.22));
      }

      /* ── Product badge ── */
      #pro-badge {
        position: fixed; right: 32px; top: 26px; z-index: 9996;
        padding: 9px 16px; border-radius: 5px;
        background: linear-gradient(135deg, #1f7ae0, #5aa9ff);
        color: #fff; font: 800 14px/1 Inter, system-ui, sans-serif;
        letter-spacing: .03em;
        box-shadow: 0 6px 28px rgba(31,122,224,.35);
        pointer-events: none;
      }

      /* ── Mission chip ── */
      #pro-chip {
        position: fixed; right: 32px; top: 70px; z-index: 9996;
        padding: 6px 12px; border-radius: 4px;
        background: rgba(8,16,22,.88);
        border: 1px solid rgba(90,169,255,.3);
        color: #b4d4f0; font: 700 12px/1.2 Inter, system-ui, sans-serif;
        pointer-events: none; opacity: 0;
        transition: opacity .3s ease;
      }
      #pro-chip.show { opacity: 1; }

      /* ── Progress bar ── */
      #pro-progress {
        position: fixed; left: 32px; top: 26px; z-index: 9996;
        width: 340px; padding: 10px 14px;
        border: 1px solid rgba(90,169,255,.28);
        border-radius: 6px;
        background: rgba(6,12,18,.88);
        color: #d8e8f6; font: 700 12px/1.3 Inter, system-ui, sans-serif;
        pointer-events: none;
      }
      #pro-progress .rail {
        height: 5px; margin-top: 7px; border-radius: 99px;
        background: rgba(255,255,255,.1); overflow: hidden;
      }
      #pro-progress .fill {
        height: 100%; width: 0%;
        background: linear-gradient(90deg, #1f7ae0, #5aa9ff, #50f1cf);
        border-radius: 99px;
        transition: width .5s cubic-bezier(.4,0,.2,1);
      }

      /* ── Caption block ── */
      #pro-caption {
        position: fixed; left: 32px; bottom: 34px; z-index: 9996;
        width: min(660px, calc(100vw - 72px));
        padding: 20px 22px;
        border-left: 3px solid #5aa9ff;
        background: linear-gradient(90deg, rgba(6,12,18,.92), rgba(6,12,18,.58));
        box-shadow: 0 14px 50px rgba(0,0,0,.4);
        pointer-events: none;
        opacity: 0; transform: translateY(14px);
      }
      #pro-caption.entering {
        animation: overlayFadeIn .32s ease forwards;
      }
      #pro-caption.exiting {
        animation: overlayFadeOut .26s ease forwards;
      }
      #pro-caption-title {
        color: #fff; font: 800 34px/1.08 Inter, system-ui, sans-serif;
        margin-bottom: 7px;
      }
      #pro-caption-body {
        color: #c4d6e6; font: 500 17px/1.4 Inter, system-ui, sans-serif;
      }

      /* ── Final branded frame ── */
      #pro-finale {
        position: fixed; inset: 0; z-index: 9998;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        background: radial-gradient(ellipse at 50% 45%, rgba(31,122,224,.18), rgba(6,10,14,.97) 70%);
        opacity: 0; transition: opacity .6s ease;
        pointer-events: none;
      }
      #pro-finale.show { opacity: 1; }
      #pro-finale h1 {
        color: #fff; font: 900 52px/1.05 Inter, system-ui, sans-serif;
        margin: 0 0 12px; letter-spacing: -.01em;
      }
      #pro-finale p {
        color: #8eafc8; font: 500 20px/1.4 Inter, system-ui, sans-serif;
        max-width: 640px; text-align: center;
      }
    `,
  });

  await page.evaluate(() => {
    const shade = document.createElement("div");
    shade.id = "pro-shade";

    const badge = document.createElement("div");
    badge.id = "pro-badge";
    badge.textContent = "Warehouse Swarm Lab";

    const chip = document.createElement("div");
    chip.id = "pro-chip";

    const progress = document.createElement("div");
    progress.id = "pro-progress";
    progress.innerHTML = `<div id="pro-progress-text">Ready</div><div class="rail"><div class="fill"></div></div>`;

    const caption = document.createElement("div");
    caption.id = "pro-caption";
    caption.innerHTML = `<div id="pro-caption-title"></div><div id="pro-caption-body"></div>`;

    const finale = document.createElement("div");
    finale.id = "pro-finale";
    finale.innerHTML = `<h1>Warehouse Swarm Lab</h1><p>3D warehouse design, swarm traffic control, and scissor-lift AMR simulation</p>`;

    document.body.append(shade, badge, chip, progress, caption, finale);
  });
}

// ── Helpers ──────────────────────────────────────────────────────────

async function caption(page, title, body, progressText, pct, holdMs = 3200) {
  await page.evaluate(({ title, body, progressText, pct }) => {
    document.querySelector("#pro-caption-title").textContent = title;
    document.querySelector("#pro-caption-body").textContent = body;
    document.querySelector("#pro-progress-text").textContent = progressText;
    document.querySelector("#pro-progress .fill").style.width = `${Math.max(0, Math.min(100, pct))}%`;
    const c = document.querySelector("#pro-caption");
    c.classList.remove("exiting");
    c.style.opacity = "";
    c.classList.add("entering");
  }, { title, body, progressText, pct });
  await pause(holdMs);
  await page.evaluate(() => {
    const c = document.querySelector("#pro-caption");
    c.classList.remove("entering");
    c.classList.add("exiting");
  });
  await pause(320);
}

async function setChip(page, text) {
  await page.evaluate((text) => {
    const chip = document.querySelector("#pro-chip");
    if (!chip) return;
    chip.textContent = text;
    chip.classList.toggle("show", text.length > 0);
  }, text);
}

async function showTab(page, tab) {
  await page.click(`button.tab-btn[data-tab="${tab}"]`);
  await pause(500);
}

async function setControl(page, selector, value) {
  await page.evaluate(({ selector, value }) => {
    const el = document.querySelector(selector);
    if (!el) return;
    if (el.type === "checkbox") {
      el.checked = !!value;
    } else {
      el.value = String(value);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, { selector, value });
}

async function clickIfPresent(page, selector, timeout = 1500) {
  const handle = await page.waitForSelector(selector, { timeout }).catch(() => null);
  if (!handle) return false;
  await page.evaluate(el => el.click(), handle);
  await handle.dispose();
  await pause(300);
  return true;
}

async function phaseText(page) {
  return page.evaluate(() =>
    document.querySelector(".mission-row-v2")?.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? ""
  );
}

async function waitForPhase(page, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    text = await phaseText(page);
    if (predicate(text)) return text;
    await pause(350);
  }
  return text;
}

async function dragScene(page, dx, dy, steps = 24) {
  const box = await page.locator("canvas").first().boundingBox();
  if (!box) return;
  const x = box.x + box.width * 0.46;
  const y = box.y + box.height * 0.44;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps });
  await page.mouse.up();
  await pause(450);
}

async function scrollWheel(page, deltaY, count = 1) {
  const box = await page.locator("canvas").first().boundingBox();
  if (!box) return;
  const x = box.x + box.width * 0.5;
  const y = box.y + box.height * 0.5;
  for (let i = 0; i < count; i++) {
    await page.mouse.wheel(0, deltaY);
    await pause(100);
  }
}

async function hideSidebar(page) {
  await page.evaluate(() => {
    const sidebar = document.querySelector(".sidebar");
    if (sidebar) sidebar.style.transition = "opacity .3s ease";
    if (sidebar) sidebar.style.opacity = "0";
    if (sidebar) sidebar.style.pointerEvents = "none";
  });
  await pause(350);
}

async function showSidebar(page) {
  await page.evaluate(() => {
    const sidebar = document.querySelector(".sidebar");
    if (sidebar) sidebar.style.opacity = "1";
    if (sidebar) sidebar.style.pointerEvents = "";
  });
  await pause(350);
}

// ── Main ─────────────────────────────────────────────────────────────

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

  console.log("Loading app...");
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector("canvas", { timeout: 15000 });
  await pause(2000);
  await installOverlay(page);

  // Pre-configure controls before recording content
  await showTab(page, "missions");
  await setControl(page, 'select[data-field="routing"]', "reservation-table");
  await setControl(page, 'select[data-field="allocator"]', "eta-optimal");
  await setControl(page, 'input[data-field="timeScale"]', "5");
  await setControl(page, 'input[data-field="maxActiveMissions"]', "1");
  await setControl(page, 'input[data-field="collision"]', true);
  await setControl(page, 'input[data-field="showRoutes"]', true);

  // ── Scene 1: Hero overview ──────────────────────────────────────
  console.log("Scene 1: Hero overview");
  await hideSidebar(page);
  await clickIfPresent(page, 'button[data-cam="overview"]');
  await pause(600);
  await dragScene(page, -80, -20);

  await caption(
    page,
    "One robot. One complete warehouse mission.",
    "A blue scissor-lift AMR receives a high-shelf pickup, plans a safe route, lifts the tote, and completes delivery.",
    "Mission profile loaded",
    5,
    4000
  );

  // ── Scene 2: Mission configuration ──────────────────────────────
  console.log("Scene 2: Mission configuration");
  await showSidebar(page);
  await showTab(page, "missions");
  await pause(400);

  await caption(
    page,
    "Mission planner armed",
    "Reservation Table routing, ETA assignment, and collision avoidance prepare the robot before it moves.",
    "Routing configured",
    15,
    3400
  );

  // ── Scene 3: Dispatch ───────────────────────────────────────────
  console.log("Scene 3: Dispatch");
  await page.click('button[data-action="dispatch-highest"]');
  await pause(400);

  const missionText = await phaseText(page);
  const missionIdMatch = missionText.match(/m-\d+/i);
  const missionId = missionIdMatch ? missionIdMatch[0].toUpperCase() : "M-0001";
  await setChip(page, `Mission ${missionId}`);

  await hideSidebar(page);

  await caption(
    page,
    "High-shelf pickup dispatched",
    "The selected robot receives a shelf-level mission and a reserved route through the QR track.",
    `${missionId} dispatched`,
    25,
    3400
  );

  // ── Scene 4: Route execution ────────────────────────────────────
  console.log("Scene 4: Route execution");
  await waitForPhase(page, t => t.includes("drive to pick") || t.includes("wait clearance"), 8000);

  await clickIfPresent(page, 'button[data-cam="aisle"]');
  await pause(400);
  await dragScene(page, -140, -35);

  await caption(
    page,
    "Driving through protected lanes",
    "The robot follows orthogonal lanes and avoids racks, stations, parked robots, and blocked paths.",
    "Driving to pick slot",
    40,
    4200
  );

  // ── Scene 5: Scissor lift ───────────────────────────────────────
  console.log("Scene 5: Scissor lift");
  await waitForPhase(page, t => t.includes("lift") || t.includes("picking") || t.includes("lowering"), 18000);

  await clickIfPresent(page, 'button[data-cam="aisle"]');
  await pause(300);
  await scrollWheel(page, -200, 3);

  await caption(
    page,
    "Scissor lift opens only at the rack",
    "The lift extends to the required shelf level, secures the tote, then lowers before travel.",
    "Lift and pickup in progress",
    60,
    5500
  );

  // ── Scene 6: Payload carry / follow ─────────────────────────────
  console.log("Scene 6: Payload carry");
  await showSidebar(page);
  await showTab(page, "robots");
  await pause(300);
  await clickIfPresent(page, 'button[data-action="follow-robot"]');

  await caption(
    page,
    "Payload secured",
    "The carried tote matches the warehouse inventory model, keeping the simulation visually consistent.",
    "Payload loaded, driving to station",
    75,
    4200
  );

  // Brief robot camera shot
  await clickIfPresent(page, 'button[data-action="robot-camera"]');
  await pause(2800);
  await clickIfPresent(page, 'button[data-action="stop-robot-camera"]');
  await pause(400);

  // ── Scene 7: Delivery ──────────────────────────────────────────
  console.log("Scene 7: Delivery");
  await hideSidebar(page);
  await clickIfPresent(page, 'button[data-cam="overview"]');
  await pause(400);

  await waitForPhase(page, t => t.includes("placing") || t.includes("drive to drop") || t.includes("done"), 22000);

  await caption(
    page,
    "Delivery and placement",
    "The robot reaches the target station, places the tote, and releases the mission.",
    "Drop-off in progress",
    90,
    4500
  );

  await waitForPhase(page, t => t.includes("done"), 26000);

  // ── Scene 8: Completion / proof ─────────────────────────────────
  console.log("Scene 8: Completion");
  await showSidebar(page);
  await showTab(page, "missions");
  await pause(600);

  await caption(
    page,
    "Mission accomplished",
    "Route distance, wait time, lift telemetry, and mission traces are ready for analysis and export.",
    `${missionId} complete`,
    100,
    3800
  );

  // Brief debug proof
  await showTab(page, "debug");
  await pause(2200);

  // Brief export proof
  await showTab(page, "export");
  await pause(2200);

  // ── Finale branded frame ───────────────────────────────────────
  console.log("Finale");
  await hideSidebar(page);
  await page.evaluate(() => {
    document.querySelector("#pro-caption")?.classList.remove("entering", "exiting");
    document.querySelector("#pro-caption").style.opacity = "0";
    document.querySelector("#pro-chip")?.classList.remove("show");
    document.querySelector("#pro-progress").style.opacity = "0";
  });
  await pause(300);
  await page.evaluate(() => document.querySelector("#pro-finale")?.classList.add("show"));
  await pause(4200);

  // ── Cleanup ────────────────────────────────────────────────────
  if (consoleErrors.length > 0) {
    console.warn(`Browser console errors (${consoleErrors.length}):`);
    for (const err of consoleErrors.slice(0, 5)) console.warn("  " + err);
  }

  const video = page.video();

  // Take a thumbnail screenshot before closing
  const thumbPath = path.join(OUT_DIR, "warehouse-swarm-lab-professional-one-robot-thumbnail.png");
  await page.evaluate(() => document.querySelector("#pro-finale")?.classList.remove("show"));
  await pause(300);
  await showSidebar(page);
  await showTab(page, "missions");
  await clickIfPresent(page, 'button[data-cam="overview"]');
  await pause(800);
  await page.screenshot({ path: thumbPath });
  console.log(`Thumbnail: ${thumbPath}`);

  await page.close();
  await context.close();
  await browser.close();

  const rawVideoPath = await video.path();
  const professionalPath = path.join(OUT_DIR, "warehouse-swarm-lab-professional-one-robot.webm");
  const promoPath = path.join(OUT_DIR, "warehouse-swarm-lab-promo.webm");
  await fs.copyFile(rawVideoPath, professionalPath);
  await fs.copyFile(rawVideoPath, promoPath);
  console.log(`Professional video: ${professionalPath}`);
  console.log(`Promo video updated: ${promoPath}`);

  const stat = await fs.stat(professionalPath);
  console.log(`File size: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
  if (stat.size < 512 * 1024) {
    console.error("WARNING: Video file is suspiciously small (<512 KB)");
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
