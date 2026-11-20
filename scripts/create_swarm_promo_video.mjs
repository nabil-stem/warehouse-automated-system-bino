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

async function installOverlay(page) {
  await page.addStyleTag({
    content: `
      #swarm-vignette {
        position: fixed;
        inset: 0;
        z-index: 9994;
        pointer-events: none;
        background:
          linear-gradient(180deg, rgba(0,0,0,.30), transparent 20%, transparent 78%, rgba(0,0,0,.42)),
          linear-gradient(90deg, rgba(0,0,0,.54), transparent 40%, rgba(0,0,0,.18)),
          radial-gradient(circle at 18% 80%, rgba(31,122,224,.22), transparent 30%);
      }
      #swarm-card {
        position: fixed;
        left: 36px;
        bottom: 34px;
        z-index: 9995;
        width: min(760px, calc(100vw - 82px));
        padding: 22px 26px 24px;
        border-left: 4px solid #5aa9ff;
        background: linear-gradient(90deg, rgba(5,12,18,.94), rgba(5,12,18,.58));
        box-shadow: 0 18px 60px rgba(0,0,0,.44);
        transform: translateY(14px);
        opacity: 0;
        transition: opacity .22s ease, transform .22s ease;
        pointer-events: none;
      }
      #swarm-card.show { opacity: 1; transform: translateY(0); }
      #swarm-kicker {
        color: #5aa9ff;
        font: 850 13px/1 Inter, system-ui, sans-serif;
        letter-spacing: .13em;
        text-transform: uppercase;
        margin-bottom: 7px;
      }
      #swarm-title {
        color: white;
        font: 850 42px/1.02 Inter, system-ui, sans-serif;
        letter-spacing: 0;
        margin-bottom: 7px;
      }
      #swarm-copy {
        color: #dce8f2;
        font: 520 19px/1.38 Inter, system-ui, sans-serif;
      }
      #swarm-badge {
        position: fixed;
        top: 30px;
        right: 36px;
        z-index: 9995;
        color: #05111c;
        background: #5aa9ff;
        border-radius: 6px;
        padding: 9px 13px;
        font: 850 16px/1 Inter, system-ui, sans-serif;
        box-shadow: 0 10px 34px rgba(90,169,255,.28);
        pointer-events: none;
      }
      #swarm-metrics {
        position: fixed;
        left: 36px;
        top: 30px;
        z-index: 9995;
        width: 430px;
        padding: 14px 16px;
        border: 1px solid rgba(90,169,255,.34);
        border-radius: 7px;
        background: rgba(5,12,18,.88);
        color: #edf7ff;
        font: 760 15px/1.24 Inter, system-ui, sans-serif;
        pointer-events: none;
      }
      #swarm-metrics .line {
        display: flex;
        justify-content: space-between;
        gap: 14px;
        margin-bottom: 6px;
      }
      #swarm-metrics .bar {
        height: 8px;
        border-radius: 99px;
        background: rgba(255,255,255,.14);
        overflow: hidden;
      }
      #swarm-metrics .fill {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #1f7ae0, #5aa9ff, #50f1cf);
        transition: width .28s ease;
      }
      #swarm-final {
        position: fixed;
        inset: 0;
        z-index: 9998;
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        pointer-events: none;
        opacity: 0;
        transition: opacity .45s ease;
        background: radial-gradient(ellipse at 50% 45%, rgba(31,122,224,.20), rgba(5,10,15,.96) 68%);
      }
      #swarm-final.show { opacity: 1; }
      #swarm-final h1 {
        color: #fff;
        font: 900 58px/1 Inter, system-ui, sans-serif;
        margin: 0 0 14px;
      }
      #swarm-final p {
        color: #a8c3d9;
        font: 500 22px/1.35 Inter, system-ui, sans-serif;
        max-width: 820px;
        margin: 0 auto;
      }
    `,
  });

  await page.evaluate(() => {
    const shade = document.createElement("div");
    shade.id = "swarm-vignette";
    const badge = document.createElement("div");
    badge.id = "swarm-badge";
    badge.textContent = "Warehouse Swarm Lab";
    const metrics = document.createElement("div");
    metrics.id = "swarm-metrics";
    metrics.innerHTML = `
      <div class="line"><span id="swarm-metric-label">Swarm launch</span><span id="swarm-metric-value">0%</span></div>
      <div class="bar"><div class="fill"></div></div>
    `;
    const card = document.createElement("div");
    card.id = "swarm-card";
    card.innerHTML = `
      <div id="swarm-kicker">swarm robotics</div>
      <div id="swarm-title"></div>
      <div id="swarm-copy"></div>
    `;
    const final = document.createElement("div");
    final.id = "swarm-final";
    final.innerHTML = `<div><h1>Warehouse Swarm Lab</h1><p>Multi-robot missions, lift handling, traffic supervision, and organized autonomous parking.</p></div>`;
    document.body.append(shade, badge, metrics, card, final);
  });
}

async function caption(page, title, copy, label, pct, ms = 1700) {
  await page.evaluate(({ title, copy, label, pct }) => {
    document.querySelector("#swarm-title").textContent = title;
    document.querySelector("#swarm-copy").textContent = copy;
    document.querySelector("#swarm-metric-label").textContent = label;
    document.querySelector("#swarm-metric-value").textContent = `${Math.round(pct)}%`;
    document.querySelector("#swarm-metrics .fill").style.width = `${Math.max(0, Math.min(100, pct))}%`;
    document.querySelector("#swarm-card").classList.add("show");
  }, { title, copy, label, pct });
  await page.waitForTimeout(ms);
  await page.evaluate(() => document.querySelector("#swarm-card")?.classList.remove("show"));
  await page.waitForTimeout(180);
}

async function showTab(page, tab) {
  await page.click(`button.tab-btn[data-tab="${tab}"]`);
  await page.waitForTimeout(250);
}

async function setControl(page, selector, value) {
  await page.evaluate(({ selector, value }) => {
    const el = document.querySelector(selector);
    if (!el) return;
    if (el.type === "checkbox") {
      el.checked = Boolean(value);
    } else {
      el.value = String(value);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, { selector, value });
}

async function state(page) {
  return page.evaluate(() => window.__warehousePromo?.state?.() ?? null);
}

async function waitFor(page, predicate, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  let s = null;
  while (Date.now() < end) {
    s = await state(page);
    if (s && predicate(s)) return s;
    await page.waitForTimeout(250);
  }
  return s;
}

async function waitForCleanFinish(page, timeoutMs = 60000) {
  return waitFor(page, s => {
    const allDone = s.missions.length > 0 && s.missions.every(m => m.status === "done" || m.status === "failed");
    const allParked = s.robots.every(r =>
      (r.state === "idle" || r.state === "charging") &&
      !r.missionId &&
      !r.carryingSlotId
    );
    const parkingClean = (s.parking ?? []).every(p => p.distance <= 0.45);
    return allDone && allParked && parkingClean;
  }, timeoutMs);
}

async function setCamera(page, mode, robotId = 1) {
  await page.evaluate(({ mode, robotId }) => window.__warehousePromo?.camera?.(robotId, mode), { mode, robotId });
  await page.waitForTimeout(180);
}

async function overview(page) {
  await page.evaluate(() => window.__warehousePromo?.overview?.());
  await page.waitForTimeout(180);
}

async function dragScene(page, dx, dy) {
  const box = await page.locator("canvas").first().boundingBox();
  if (!box) return;
  const x = box.x + box.width * 0.45;
  const y = box.y + box.height * 0.42;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 18 });
  await page.mouse.up();
  await page.waitForTimeout(250);
}

async function main() {
  await ensureDir(RECORD_DIR);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    recordVideo: { dir: RECORD_DIR, size: VIEWPORT },
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", msg => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector("canvas", { timeout: 15000 });
  await page.waitForTimeout(1000);
  await installOverlay(page);

  await showTab(page, "missions");
  await setControl(page, 'select[data-field="routing"]', "reservation-table");
  await setControl(page, 'select[data-field="allocator"]', "eta-optimal");
  await setControl(page, 'select[data-field="parkingStrategy"]', "balanced-sides");
  await setControl(page, 'input[data-field="missionCount"]', 12);
  await setControl(page, 'input[data-field="maxActiveMissions"]', 8);
  await setControl(page, 'input[data-field="timeScale"]', 5);
  await setControl(page, 'input[data-field="collision"]', true);
  await setControl(page, 'input[data-field="showRoutes"]', true);
  await overview(page);
  await dragScene(page, -130, -35);

  await caption(
    page,
    "Swarm launch in seconds",
    "Twelve blue scissor-lift AMRs are staged in a closed warehouse with QR lanes, rack geometry, stations, and dynamic parking.",
    "Fleet staging",
    8,
    2100
  );

  await page.click('button[data-action="generate"]');
  await page.click('button[data-action="toggle"]');
  await waitFor(page, s => s.robots.filter(r => r.state !== "idle" && r.state !== "charging").length >= 4, 5000);
  await caption(
    page,
    "Multiple robots, one shared map",
    "Reservation routing starts multiple missions at once while the supervisor protects station exits and parking corridors.",
    "Swarm active",
    24,
    2500
  );

  await page.waitForTimeout(1900);
  await caption(
    page,
    "Parallel missions under control",
    "Robots leave staging together, choose safe orthogonal paths, and keep moving without colliding with racks or each other.",
    "Traffic scaling",
    38,
    2300
  );

  const liftState = await waitFor(page, s => s.robots.some(r => r.state === "picking"), 12000);
  const liftRobot = liftState?.robots?.find(r => r.state === "picking")?.id ?? 1;
  await setControl(page, 'input[data-field="timeScale"]', 1.4);
  await setCamera(page, "lift-close", liftRobot);
  await caption(
    page,
    "Lift action inside the swarm",
    "While the fleet keeps moving, one robot opens its scissor lift at the rack face and secures a high-level tote.",
    "Scissor lift close-up",
    55,
    5200
  );

  await setControl(page, 'input[data-field="timeScale"]', 5);
  const loadedState = await waitFor(page, s => s.robots.some(r => r.carryingSlotId && r.state === "to-drop"), 12000);
  const loadedRobot = loadedState?.robots?.find(r => r.carryingSlotId && r.state === "to-drop")?.id ?? liftRobot;
  await setCamera(page, "payload-side", loadedRobot);
  await caption(
    page,
    "Payloads move while traffic adapts",
    "Loaded robots get priority, empty robots yield, and the fleet keeps the most urgent mission moving.",
    "Payload in traffic",
    68,
    3300
  );

  await setCamera(page, "robot-camera", loadedRobot);
  await caption(
    page,
    "Robot camera at speed",
    "The onboard view shows the aisle moving through frame: QR track, rack edges, and clearance zones pass in real time.",
    "Onboard view",
    78,
    2700
  );

  await overview(page);
  await showTab(page, "debug");
  await caption(
    page,
    "Traffic proof for the jury",
    "Debug panels expose reservations, conflicts, supervisor decisions, queue states, and route efficiency.",
    "Supervisor telemetry",
    88,
    2400
  );

  await showTab(page, "missions");
  await waitFor(page, s => s.missions.filter(m => m.status === "done").length >= 4, 18000);
  await caption(
    page,
    "Fast proof of throughput",
    "Several missions complete while others are still moving, showing a live warehouse swarm instead of a scripted single robot.",
    "Throughput rising",
    96,
    2700
  );

  await setControl(page, 'input[data-field="timeScale"]', 5);
  await overview(page);
  await caption(
    page,
    "Autonomous cleanup after the wave",
    "After the work is complete, robots reserve open bays and return to an organized parking formation instead of stopping in traffic.",
    "Dynamic parking",
    98,
    2600
  );

  const cleanFinish = await waitForCleanFinish(page, 70000);
  await overview(page);
  await page.waitForTimeout(1200);
  await caption(
    page,
    "Wave complete. Fleet parked.",
    cleanFinish
      ? "The final frame shows the complete warehouse wave: missions finished, payloads delivered, and robots parked in assigned bays."
      : "The final frame waits for cleanup and shows the fleet returning into assigned parking bays.",
    "Final organized state",
    100,
    3300
  );

  await showTab(page, "export");
  await caption(
    page,
    "Ready for analysis and export",
    "Mission logs, traces, screenshots, GLB, SDF world, and Text-to-CAD prompts turn the demo into engineering evidence.",
    "Exportable evidence",
    100,
    2200
  );

  await page.evaluate(() => document.querySelector("#swarm-final")?.classList.add("show"));
  await page.waitForTimeout(3300);

  if (consoleErrors.length > 0) {
    console.warn(`Browser console errors (${consoleErrors.length}):`);
    for (const err of consoleErrors.slice(0, 5)) console.warn(err);
  }

  const video = page.video();
  await page.close();
  await context.close();
  await browser.close();

  const rawVideo = await video.path();
  const swarmPath = path.join(OUT_DIR, "warehouse-swarm-lab-swarm-promo.webm");
  const proSwarmPath = path.join(OUT_DIR, "warehouse-swarm-lab-professional-swarm.webm");
  const latestPath = path.join(OUT_DIR, "warehouse-swarm-lab-promo.webm");
  await fs.copyFile(rawVideo, swarmPath);
  await fs.copyFile(rawVideo, proSwarmPath);
  await fs.copyFile(rawVideo, latestPath);
  console.log(`Swarm promo video saved: ${swarmPath}`);
  console.log(`Professional swarm promo saved: ${proSwarmPath}`);
  console.log(`Updated latest promo video saved: ${latestPath}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
