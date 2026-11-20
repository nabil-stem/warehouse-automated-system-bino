import { initState, getState, subscribe, setStatus, setState } from "./app/appState";
import { initScene, rebuildScene, updateRobots, updateRouteLines, updateHeatmap, updateLaneGeometry, renderFrame, setRobotCamera, setCameraPreset, clearRobotCamera, getSceneState } from "./render/sceneManager";
import { loadReferenceWarehouseModelFromUrl } from "./render/loaders";
import { exportScreenshot } from "./render/exporters";
import { resetCollisionTracking, tickRobots } from "./domain/robotSimulation";
import { assignMissions, generateMissions } from "./domain/missionPlanner";
import { computeMetrics } from "./domain/metrics";
import { renderLayoutPanel } from "./ui/layoutPanel";
import { renderInventoryPanel } from "./ui/inventoryPanel";
import { renderRobotPanel } from "./ui/robotPanel";
import { renderMissionPanel, updateMissionTable } from "./ui/missionPanel";
import { renderExportPanel } from "./ui/exportPanel";
import { renderDebugPanel, updateDebugPanel } from "./ui/debugPanel";
import { renderOperationsPanel, updateOperationsPanel } from "./ui/operationsPanel";
import { renderAnalyticsPanel, updateAnalyticsPanel } from "./ui/analyticsPanel";
import { renderTrafficPanel, updateTrafficPanel } from "./ui/trafficPanel";
import { renderDashboard } from "./ui/dashboard";
import { createOperationsMapPanel, updateOperationsMap } from "./ui/operationsMap";
import { createSceneToolbar, updateSceneInspector } from "./ui/sceneToolbar";
import { renderCompetitionOverlay, startJuryDemo } from "./ui/competitionPanel";
import "./styles.css";

initState();

const app = document.querySelector<HTMLDivElement>("#root")!;
app.innerHTML = `
  <div class="app-shell">
    <header class="command-bar">
      <a class="home-link" href="/" title="Back to the BINO project homepage" aria-label="BINO project home"><span aria-hidden="true">←</span> Home</a>
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">◆</span>
        <div class="brand-text">
          <span class="brand-name">BINO · Swarm Lab</span>
          <span class="brand-sub" id="cmd-scenario"></span>
        </div>
      </div>
      <div class="cmd-cluster cmd-sim">
        <button class="cmd-btn cmd-primary" data-cmd="toggle"><span class="cmd-ico" id="cmd-toggle-ico">▶</span><span id="cmd-toggle-lbl">Start</span></button>
        <button class="cmd-btn" data-cmd="step" title="Advance one tick">⏭ Step</button>
        <label class="cmd-scale" title="Simulation speed">
          <span>Speed</span>
          <input type="range" data-cmd="scale" min="0.1" max="5" step="0.1" />
          <span class="cmd-scale-val" id="cmd-scale-val"></span>
        </label>
      </div>
      <div class="cmd-cluster cmd-actions">
        <button class="cmd-btn" data-cmd="generate" title="Generate a mission batch">✦ Generate</button>
        <button class="cmd-btn cmd-accent" data-cmd="jury" title="Reset and run the jury demo">★ Jury Demo</button>
        <button class="cmd-btn" data-cmd="screenshot" title="Download a PNG of the 3D view">⎙ Screenshot</button>
      </div>
      <div class="cmd-status">
        <span class="status-dot" id="cmd-dot"></span>
        <span class="status-bar" id="cmd-status">Ready</span>
      </div>
      <div class="cmd-credit" title="Copyright credit">&copy; Nabil ES-SAADI</div>
    </header>
    <div class="app-body">
      <nav class="nav-rail" id="nav-rail">
        <button class="tab-btn" data-tab="operations"><span class="nav-ico">◳</span><span class="nav-lbl">Operations</span></button>
        <button class="tab-btn" data-tab="missions"><span class="nav-ico">▤</span><span class="nav-lbl">Missions</span></button>
        <button class="tab-btn" data-tab="robots"><span class="nav-ico">◎</span><span class="nav-lbl">Fleet</span></button>
        <button class="tab-btn" data-tab="layout"><span class="nav-ico">▦</span><span class="nav-lbl">Warehouse</span></button>
        <button class="tab-btn" data-tab="inventory"><span class="nav-ico">▥</span><span class="nav-lbl">Inventory</span></button>
        <button class="tab-btn" data-tab="traffic"><span class="nav-ico">⤳</span><span class="nav-lbl">Traffic</span></button>
        <button class="tab-btn" data-tab="analytics"><span class="nav-ico">▩</span><span class="nav-lbl">Analytics</span></button>
        <button class="tab-btn" data-tab="export"><span class="nav-ico">⤓</span><span class="nav-lbl">Export</span></button>
        <button class="tab-btn nav-secondary" data-tab="debug"><span class="nav-ico">⚙</span><span class="nav-lbl">Debug</span></button>
      </nav>
      <main class="scene-workspace">
        <section class="viewport" aria-label="3D warehouse swarm simulation"></section>
      </main>
      <aside class="ops-sidebar">
        <div class="kpi-strip" id="dashboard"></div>
        <div class="sidebar-scroll">
          <div class="view-title" id="view-title">Operations</div>
          <div class="tab-content" id="tab-content"></div>
        </div>
        <div class="competition-area" id="competition-overlay"></div>
      </aside>
    </div>
  </div>
`;

const mount = document.querySelector<HTMLDivElement>(".viewport")!;
const workspace = document.querySelector<HTMLElement>(".scene-workspace")!;
const tabContent = document.getElementById("tab-content")!;
const dashboardEl = document.getElementById("dashboard")!;
const competitionEl = document.getElementById("competition-overlay")!;
const viewTitleEl = document.getElementById("view-title")!;

initScene(mount);
createOperationsMapPanel(mount);
createSceneToolbar(workspace);
renderCompetitionOverlay(competitionEl);

const TAB_LABELS: Record<string, string> = {
  operations: "Operations",
  missions: "Missions",
  robots: "Fleet",
  layout: "Warehouse",
  inventory: "Inventory",
  traffic: "Traffic Control",
  analytics: "Analytics",
  export: "Export",
  debug: "Debug & Diagnostics",
};

let currentTab = "operations";
const tabRenderers: Record<string, (el: HTMLElement) => void> = {
  operations: renderOperationsPanel,
  missions: renderMissionPanel,
  robots: renderRobotPanel,
  layout: renderLayoutPanel,
  inventory: renderInventoryPanel,
  traffic: renderTrafficPanel,
  analytics: renderAnalyticsPanel,
  export: renderExportPanel,
  debug: renderDebugPanel,
};
const tabUpdaters: Record<string, (el: HTMLElement) => void> = {
  operations: updateOperationsPanel,
  missions: updateMissionTable,
  traffic: updateTrafficPanel,
  analytics: updateAnalyticsPanel,
  debug: updateDebugPanel,
};

function switchTab(tab: string) {
  currentTab = tab;
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.classList.toggle("active", (btn as HTMLElement).dataset.tab === tab);
  });
  viewTitleEl.textContent = TAB_LABELS[tab] ?? tab;
  tabRenderers[tab]?.(tabContent);
}

document.getElementById("nav-rail")!.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(".tab-btn") as HTMLElement;
  if (btn?.dataset.tab) switchTab(btn.dataset.tab);
});

// --- Command bar wiring ---
const commandBar = document.querySelector<HTMLElement>(".command-bar")!;
commandBar.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("[data-cmd]") as HTMLElement;
  if (!btn) return;
  const state = getState();
  const cmd = btn.dataset.cmd;
  if (cmd === "toggle") {
    setState({ running: !state.running });
    setStatus(getState().running ? "Simulation running" : "Simulation paused");
  } else if (cmd === "step") {
    setState({ running: false });
    (window as any).__simStep = true;
    setStatus("Stepped 1 tick");
  } else if (cmd === "generate") {
    if (state.missions.length === 0 || state.missions.every(m => m.status === "done" || m.status === "failed")) {
      resetCollisionTracking();
      state.congestionMap.clear();
    }
    const created = generateMissions(state.scenario, state.slots, state.scenario.simulation.missionCount, state.tick, state.missions);
    state.missions.push(...created);
    assignMissions(
      state.missions, state.robots, state.navGraph, state.slots,
      state.scenario.simulation.allocator, state.scenario.stations,
      state.scenario.simulation.maxActiveMissions, state.scenario, state.congestionMap,
      state.tick
    );
    refreshMetrics();
    setStatus(`Generated ${created.length} missions`);
  } else if (cmd === "jury") {
    startJuryDemo();
  } else if (cmd === "screenshot") {
    const ss = getSceneState();
    if (ss) {
      exportScreenshot(ss.renderer, `warehouse-screenshot-${Date.now()}.png`);
      setStatus("Screenshot exported");
    }
  }
});

const scaleInput = commandBar.querySelector<HTMLInputElement>('[data-cmd="scale"]')!;
scaleInput.addEventListener("input", () => {
  getState().scenario.simulation.timeScale = parseFloat(scaleInput.value);
  updateCommandBar();
});

function refreshMetrics() {
  const state = getState();
  state.metrics = computeMetrics(
    state.robots, state.missions, state.slots, state.congestionMap,
    state.tick, state.scenario.simulation.tickMs,
    state.metrics.throughputHistory, state.scenario.stations
  );
}

function updateCommandBar() {
  const state = getState();
  const running = state.running;
  const toggleLbl = document.getElementById("cmd-toggle-lbl")!;
  const toggleIco = document.getElementById("cmd-toggle-ico")!;
  toggleLbl.textContent = running ? "Pause" : "Start";
  toggleIco.textContent = running ? "⏸" : "▶";
  const toggleBtn = commandBar.querySelector('[data-cmd="toggle"]')!;
  toggleBtn.classList.toggle("cmd-running", running);

  document.getElementById("cmd-scenario")!.textContent = state.scenario.name;
  document.getElementById("cmd-scale-val")!.textContent = `${state.scenario.simulation.timeScale.toFixed(1)}x`;
  if (document.activeElement !== scaleInput) scaleInput.value = String(state.scenario.simulation.timeScale);

  const statusEl = document.getElementById("cmd-status")!;
  statusEl.textContent = state.statusMessage;
  const dot = document.getElementById("cmd-dot")!;
  const allDone = state.missions.length > 0 && state.missions.every(m => m.status === "done" || m.status === "failed");
  dot.className = "status-dot " + (running ? "dot-running" : allDone ? "dot-done" : "dot-idle");
}

let lastScenario = getState().scenario;
let lastSlots = getState().slots;
let lastRobots = getState().robots;
let lastNavGraph = getState().navGraph;

function renderCurrentState() {
  const state = getState();
  const needsSceneRebuild =
    state.scenario !== lastScenario ||
    state.slots !== lastSlots ||
    state.robots !== lastRobots ||
    state.navGraph !== lastNavGraph;

  if (needsSceneRebuild) {
    rebuildScene(state.scenario, state.slots, state.robots, state.navGraph);
    lastScenario = state.scenario;
    lastSlots = state.slots;
    lastRobots = state.robots;
    lastNavGraph = state.navGraph;
    updateLaneGeometry(state.scenario, state.robots);
  }

  renderDashboard(dashboardEl, state.metrics, state.statusMessage);
  renderCompetitionOverlay(competitionEl);
  updateCommandBar();
  switchTab(currentTab);
}

subscribe(renderCurrentState);

const bootState = getState();
rebuildScene(bootState.scenario, bootState.slots, bootState.robots, bootState.navGraph);
updateLaneGeometry(bootState.scenario, bootState.robots);
renderDashboard(dashboardEl, bootState.metrics, bootState.statusMessage);
updateCommandBar();
switchTab("operations");
installPromoControlApi();
void loadBuiltInReferenceModel().finally(() => {
  if (new URLSearchParams(window.location.search).get("demo") === "jury") {
    startJuryDemo();
  }
});

function installPromoControlApi() {
  (window as any).__warehousePromo = {
    camera(robotId = 1, mode = "follow-close") {
      setRobotCamera(robotId, mode as any);
    },
    overview() {
      clearRobotCamera();
      setCameraPreset("overview");
    },
    aisle() {
      clearRobotCamera();
      setCameraPreset("aisle");
    },
    state() {
      const s = getState();
      return {
        tick: s.tick,
        running: s.running,
        missions: s.missions.map(m => ({
          id: m.id,
          status: m.status,
          statusNote: m.statusNote,
          assignedRobotId: m.assignedRobotId,
          waitTicks: m.waitTicks,
        })),
        robots: s.robots.map(r => ({
          id: r.id,
          state: r.state,
          missionId: r.missionId,
          carryingSlotId: r.carryingSlotId,
          lift: r.liftTelemetry,
          position: r.position,
          assignedParkingPosition: r.assignedParkingPosition,
          assignedParkingBayId: r.assignedParkingBayId,
        })),
        parking: s.robots.map(r => {
          const target = r.assignedParkingPosition ?? r.homePosition;
          return {
            robotId: r.id,
            bayId: r.assignedParkingBayId,
            distance: Math.hypot(r.position.x - target.x, r.position.z - target.z),
          };
        }),
      };
    },
  };
}

async function loadBuiltInReferenceModel() {
  const initialState = getState();
  const url = initialState.scenario.visual.referenceModelUrl;
  if (!url) return;

  setStatus("Loading STEP-derived warehouse CAD reference...");
  const result = await loadReferenceWarehouseModelFromUrl(url, initialState.scenario.visual.referenceModelScale);
  if (result.status === "loaded") {
    const refreshedState = getState();
    rebuildScene(refreshedState.scenario, refreshedState.slots, refreshedState.robots, refreshedState.navGraph);
    setStatus("Loaded STEP-derived warehouse CAD reference");
    return;
  }

  setStatus(`CAD reference failed: ${result.error}`);
}

let lastTime = performance.now();
let tickAccumulator = 0;
let mapUpdateCounter = 0;

function animate(now: number) {
  const dt = now - lastTime;
  lastTime = now;

  const state = getState();
  const doStep = (window as any).__simStep === true;

  const replayTrace = (window as any).__replayTrace;
  if (replayTrace) {
    const traceIdx = (window as any).__replayTraceIdx ?? 0;
    if (traceIdx < replayTrace.entries.length) {
      const entry = replayTrace.entries[traceIdx];
      const robot = state.robots.find((r: any) => r.id === replayTrace.robotId);
      if (robot) {
        robot.position = { x: entry.x, z: entry.z };
        robot.heading = entry.heading;
        robot.state = entry.state as any;
        updateRobots(state.robots, state.scenario, dt, state.missions, state.slots);
      }
      (window as any).__replayTraceIdx = traceIdx + 1;
    } else {
      delete (window as any).__replayTrace;
      delete (window as any).__replayTraceIdx;
      setStatus("Trace replay complete");
    }
  }

  if ((state.running || doStep) && !replayTrace) {
    (window as any).__simStep = false;
    tickAccumulator += dt * state.scenario.simulation.timeScale;
    const tickMs = state.scenario.simulation.tickMs;
    tickAccumulator = Math.min(tickAccumulator, tickMs * 6);

    let ticksThisFrame = 0;
    while (tickAccumulator >= tickMs && ticksThisFrame < 6) {
      tickAccumulator -= tickMs;
      ticksThisFrame++;
      state.tick++;

      assignMissions(
        state.missions, state.robots, state.navGraph,
        state.slots, state.scenario.simulation.allocator,
        state.scenario.stations,
        state.scenario.simulation.maxActiveMissions,
        state.scenario,
        state.congestionMap,
        state.tick
      );

      tickRobots(
        state.robots, state.missions, state.slots,
        state.scenario, state.navGraph, state.congestionMap,
        state.scenario.simulation.collisionAvoidance, state.tick
      );
    }

    updateRobots(state.robots, state.scenario, dt, state.missions, state.slots);
    updateRouteLines(state.robots, state.scenario);
    updateHeatmap(state.congestionMap, state.scenario.simulation.showHeatmap);
    updateLaneGeometry(state.scenario, state.robots);

    state.metrics = computeMetrics(
      state.robots, state.missions, state.slots,
      state.congestionMap, state.tick,
      state.scenario.simulation.tickMs,
      state.metrics.throughputHistory,
      state.scenario.stations
    );

    if (state.tick % 5 === 0) {
      renderDashboard(dashboardEl, state.metrics, state.statusMessage);
      renderCompetitionOverlay(competitionEl);
      updateCommandBar();
      updateSceneInspector();
      tabUpdaters[currentTab]?.(tabContent);
    }

    mapUpdateCounter++;
    if (mapUpdateCounter % 3 === 0) {
      updateOperationsMap(
        state.scenario, state.robots, state.slots,
        state.navGraph, state.missions,
        state.congestionMap, state.metrics
      );
    }
  } else {
    updateRobots(state.robots, state.scenario, dt, state.missions, state.slots);

    mapUpdateCounter++;
    if (mapUpdateCounter % 10 === 0) {
      updateOperationsMap(
        state.scenario, state.robots, state.slots,
        state.navGraph, state.missions,
        state.congestionMap, state.metrics
      );
      updateSceneInspector();
    }
  }

  renderFrame();
  requestAnimationFrame(animate);
}

requestAnimationFrame(animate);
