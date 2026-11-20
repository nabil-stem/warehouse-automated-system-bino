import { getState, setStatus } from "../app/appState";
import {
  setCameraPreset, setRobotCamera, clearRobotCamera,
  setOverlayVisible, isOverlayVisible,
  getSelectedRobotId, setSelectedRobotId, onRobotSelected,
  updateRouteLines, updateHeatmap, updateLaneGeometry,
} from "../render/sceneManager";
import { getTraceForMission } from "../domain/traceRecorder";
import type { RobotRuntime } from "../domain/schema";

let toolbarEl: HTMLElement | null = null;
let inspectorEl: HTMLElement | null = null;
type CameraMode = "overview" | "top-down" | "aisle" | "follow" | "robot-camera" | "lift-close";
let cameraMode: CameraMode = "overview";

const CAMERAS: Array<{ id: CameraMode; label: string; icon: string; needsRobot?: boolean }> = [
  { id: "overview", label: "Overview", icon: "◰" },
  { id: "top-down", label: "Top-down", icon: "⊞" },
  { id: "aisle", label: "Aisle", icon: "▤" },
  { id: "follow", label: "Follow robot", icon: "◎", needsRobot: true },
  { id: "robot-camera", label: "Robot camera", icon: "◉", needsRobot: true },
  { id: "lift-close", label: "Lift close-up", icon: "⇡", needsRobot: true },
];

type OverlayKey = "routes" | "qr" | "heatmap" | "lanes" | "cad";
const OVERLAYS: Array<{ id: OverlayKey; label: string; icon: string }> = [
  { id: "routes", label: "Routes", icon: "⤳" },
  { id: "qr", label: "QR tracks", icon: "▦" },
  { id: "heatmap", label: "Heatmap", icon: "▩" },
  { id: "lanes", label: "Bays & lanes", icon: "◫" },
  { id: "cad", label: "CAD reference", icon: "◳" },
];

function selectedRobot(): RobotRuntime | undefined {
  const state = getState();
  const id = getSelectedRobotId();
  if (id == null) return state.robots[0];
  return state.robots.find(r => r.id === id) ?? state.robots[0];
}

function applyCamera(mode: typeof cameraMode) {
  cameraMode = mode;
  if (mode === "overview" || mode === "top-down" || mode === "aisle") {
    clearRobotCamera();
    setCameraPreset(mode);
  } else {
    const robot = selectedRobot();
    if (!robot) { setStatus("No robot to view"); return; }
    setSelectedRobotId(robot.id);
    setRobotCamera(robot.id, mode === "follow" ? "follow" : mode === "robot-camera" ? "robot-camera" : "lift-close");
    setStatus(`Camera: ${mode} R${String(robot.id).padStart(2, "0")}`);
  }
  refreshToolbarState();
}

function overlayActive(id: OverlayKey): boolean {
  const sim = getState().scenario.simulation;
  switch (id) {
    case "routes": return !!sim.showRoutes;
    case "heatmap": return !!sim.showHeatmap;
    case "lanes": return sim.showLaneGeometry !== false;
    case "qr": return isOverlayVisible("navgraph");
    case "cad": return isOverlayVisible("reference");
  }
}

function toggleOverlay(id: OverlayKey) {
  const state = getState();
  const sim = state.scenario.simulation;
  const next = !overlayActive(id);
  switch (id) {
    case "routes":
      sim.showRoutes = next;
      updateRouteLines(state.robots, state.scenario);
      break;
    case "heatmap":
      sim.showHeatmap = next;
      updateHeatmap(state.congestionMap, next);
      break;
    case "lanes":
      sim.showLaneGeometry = next;
      updateLaneGeometry(state.scenario, state.robots);
      break;
    case "qr":
      setOverlayVisible("navgraph", next);
      break;
    case "cad":
      setOverlayVisible("reference", next);
      break;
  }
  refreshToolbarState();
}

export function createSceneToolbar(workspace: HTMLElement) {
  toolbarEl = document.createElement("div");
  toolbarEl.className = "scene-toolbar";
  workspace.appendChild(toolbarEl);

  inspectorEl = document.createElement("div");
  inspectorEl.className = "scene-inspector is-empty";
  workspace.appendChild(inspectorEl);

  renderToolbar();

  onRobotSelected(() => {
    if (cameraMode === "follow" || cameraMode === "robot-camera" || cameraMode === "lift-close") {
      const robot = selectedRobot();
      if (robot) setRobotCamera(robot.id, cameraMode === "follow" ? "follow" : cameraMode === "robot-camera" ? "robot-camera" : "lift-close");
    }
    renderToolbar();
    updateSceneInspector();
  });
}

function renderToolbar() {
  if (!toolbarEl) return;
  const state = getState();
  const robots = state.robots;
  const sel = getSelectedRobotId();

  toolbarEl.innerHTML = `
    <div class="stb-group" role="group" aria-label="Camera views">
      ${CAMERAS.map(c => `
        <button class="stb-btn ${cameraMode === c.id ? "active" : ""}" data-cam="${c.id}" title="${c.label}">
          <span class="stb-ico">${c.icon}</span><span class="stb-lbl">${c.label}</span>
        </button>
      `).join("")}
    </div>
    <div class="stb-divider"></div>
    <div class="stb-group" role="group" aria-label="Overlays">
      ${OVERLAYS.map(o => `
        <button class="stb-btn stb-toggle ${overlayActive(o.id) ? "active" : ""}" data-overlay="${o.id}" title="Toggle ${o.label}">
          <span class="stb-ico">${o.icon}</span><span class="stb-lbl">${o.label}</span>
        </button>
      `).join("")}
    </div>
    <div class="stb-divider"></div>
    <label class="stb-robot-pick" title="Selected robot">
      <span class="stb-ico">◎</span>
      <select data-field="selectedRobot">
        ${robots.map(r => `<option value="${r.id}" ${r.id === (sel ?? robots[0]?.id) ? "selected" : ""}>R${String(r.id).padStart(2, "0")}</option>`).join("")}
      </select>
    </label>
  `;

  toolbarEl.onclick = (e) => {
    const camBtn = (e.target as HTMLElement).closest("[data-cam]") as HTMLElement;
    if (camBtn) { applyCamera(camBtn.dataset.cam as typeof cameraMode); return; }
    const ovBtn = (e.target as HTMLElement).closest("[data-overlay]") as HTMLElement;
    if (ovBtn) { toggleOverlay(ovBtn.dataset.overlay as OverlayKey); return; }
  };

  toolbarEl.onchange = (e) => {
    const target = e.target as HTMLSelectElement;
    if (target.dataset.field === "selectedRobot") {
      setSelectedRobotId(parseInt(target.value));
    }
  };
}

function refreshToolbarState() {
  if (!toolbarEl) return;
  toolbarEl.querySelectorAll<HTMLElement>("[data-cam]").forEach(b => {
    b.classList.toggle("active", b.dataset.cam === cameraMode);
  });
  toolbarEl.querySelectorAll<HTMLElement>("[data-overlay]").forEach(b => {
    b.classList.toggle("active", overlayActive(b.dataset.overlay as OverlayKey));
  });
}

function statePill(stateName: string): string {
  const map: Record<string, { label: string; cls: string }> = {
    "idle": { label: "Parked", cls: "idle" },
    "to-pick": { label: "To pick", cls: "moving" },
    "picking": { label: "Lifting", cls: "action" },
    "to-drop": { label: "Carrying", cls: "carry" },
    "placing": { label: "Placing", cls: "action" },
    "returning": { label: "Returning", cls: "returning" },
    "yielding": { label: "Yielding", cls: "wait" },
    "to-point": { label: "To point", cls: "moving" },
    "charging": { label: "Charging", cls: "charge" },
    "to-charge": { label: "To charge", cls: "charge" },
  };
  const m = map[stateName] ?? { label: stateName, cls: "idle" };
  return `<span class="pill pill-${m.cls}">${m.label}</span>`;
}

function collisionPill(robot: RobotRuntime): string {
  const state = robot.collisionState ?? "clear";
  const map: Record<string, { label: string; cls: string }> = {
    "clear": { label: "Clear", cls: "clear" },
    "watch": { label: "Watch", cls: "watch" },
    "reserved": { label: "Reserved", cls: "reserved" },
    "yielding": { label: "Yielding", cls: "yielding" },
    "blocked": { label: "Blocked", cls: "blocked" },
    "near-miss": { label: "Near-miss", cls: "near" },
    "physical-contact": { label: "Contact", cls: "contact" },
  };
  const m = map[state] ?? map.clear;
  return `<span class="collision-pill collision-${m.cls}">${m.label}</span>`;
}

function waitReason(robot: RobotRuntime): string {
  if (robot.collisionStateReason && robot.collisionState && robot.collisionState !== "clear") {
    return robot.collisionStateReason;
  }
  if (robot.state === "yielding") {
    return robot.waitingForRobotId ? `Yielding for R${String(robot.waitingForRobotId).padStart(2, "0")}` : "Yielding to clear lane";
  }
  if (robot.blockedTicks > 0) {
    return robot.waitingForRobotId
      ? `Waiting on R${String(robot.waitingForRobotId).padStart(2, "0")} (${robot.blockedTicks}t)`
      : `Waiting for clearance (${robot.blockedTicks}t)`;
  }
  if (robot.state === "returning") return "Returning home (no queued work)";
  if (robot.state === "idle") return "At standby slot";
  return "Clear";
}

function remainingPathDistance(robot: RobotRuntime): number {
  let d = 0;
  for (let i = Math.max(1, robot.pathIndex); i < robot.path.length; i++) {
    d += Math.hypot(robot.path[i].x - robot.path[i - 1].x, robot.path[i].z - robot.path[i - 1].z);
  }
  return d;
}

function launchStatus(robot: RobotRuntime): string {
  if (robot.launchCleared === false) {
    return `<span style="color:#f5a623">held for startup spacing (#${robot.launchPriority ?? "?"}, ${robot.startupHoldTicks ?? 0}t)</span>`;
  }
  if (robot.launchCleared === true) {
    const wave = robot.launchWaveId ? ` w${robot.launchWaveId}` : "";
    return `<span style="color:#62d7b8">cleared to launch${wave}</span>`;
  }
  return "—";
}

export function updateSceneInspector() {
  if (!inspectorEl) return;
  const state = getState();
  const id = getSelectedRobotId();
  const robot = id != null ? state.robots.find(r => r.id === id) : undefined;

  if (!robot) {
    inspectorEl.classList.add("is-empty");
    inspectorEl.innerHTML = `<div class="insp-hint">Click a robot in the 3D view to inspect it.</div>`;
    return;
  }
  inspectorEl.classList.remove("is-empty");

  const mission = state.missions.find(m => m.id === robot.missionId);
  const lift = robot.liftTelemetry;
  const speed = robot.currentSpeedMps ?? 0;
  const dist = remainingPathDistance(robot);
  const eta = speed > 0.05 ? dist / speed : 0;
  const hasTrace = mission ? !!getTraceForMission(mission.id) : false;
  const homeDist = Math.hypot(robot.position.x - robot.homePosition.x, robot.position.z - robot.homePosition.z);
  const clearance = robot.collisionClearanceMeters;
  const homeDocked = homeDist < 0.08 && Math.abs(robot.heading - (robot.homeHeading ?? 0)) < 0.12;

  inspectorEl.innerHTML = `
    <div class="insp-head">
      <span class="insp-id">R${String(robot.id).padStart(2, "0")}</span>
      ${statePill(robot.state)}
      <button class="insp-close" data-insp="close" title="Deselect">×</button>
    </div>
    <div class="insp-grid">
      <span>Mission</span><span>${mission ? mission.id : "—"}</span>
      <span>Phase</span><span>${mission?.statusNote ?? robot.state}</span>
      <span>Battery</span><span>${Math.round(robot.batteryMinutes)} min</span>
      <span>Speed</span><span>${speed.toFixed(2)} m/s</span>
      <span>Payload</span><span class="payload-${lift.payloadState}">${robot.carryingSlotId ? "carrying" : lift.payloadState}</span>
      <span>Lift level</span><span>${lift.payloadState !== "empty" ? "L" + (lift.targetLevel + 1) : "—"}</span>
      <span>Lift ext.</span><span>${lift.currentExtensionPct.toFixed(0)}%</span>
      <span>Stages</span><span>${lift.activeStages}</span>
      <span>Path left</span><span>${dist.toFixed(1)} m</span>
      <span>ETA</span><span>${eta > 0 ? eta.toFixed(1) + " s" : "—"}</span>
      <span>Home slot</span><span>${homeDocked ? "exact dock" : homeDist.toFixed(2) + " m away"}</span>
      <span>Avoidance</span><span>${collisionPill(robot)}</span>
      <span>Clearance</span><span>${clearance === undefined ? "—" : clearance.toFixed(2) + " m"}</span>
      <span>Launch</span><span>${launchStatus(robot)}</span>
      ${robot.launchReason ? `<span>Launch note</span><span>${robot.launchReason}</span>` : ""}
    </div>
    <div class="insp-reason">${waitReason(robot)}</div>
    <div class="insp-actions">
      <button class="btn btn-sm" data-insp="follow">Follow</button>
      <button class="btn btn-sm" data-insp="camera">Camera</button>
      <button class="btn btn-sm" data-insp="lift">Lift</button>
      ${hasTrace ? `<button class="btn btn-sm btn-primary" data-insp="replay">Replay</button>` : ""}
    </div>
  `;

  inspectorEl.onclick = (e) => {
    const btn = (e.target as HTMLElement).closest("[data-insp]") as HTMLElement;
    if (!btn) return;
    const act = btn.dataset.insp;
    if (act === "close") { setSelectedRobotId(null); clearRobotCamera(); cameraMode = "overview"; refreshToolbarState(); updateSceneInspector(); return; }
    if (act === "follow") applyCamera("follow");
    if (act === "camera") applyCamera("robot-camera");
    if (act === "lift") applyCamera("lift-close");
    if (act === "replay" && mission) {
      const trace = getTraceForMission(mission.id);
      if (trace) {
        (window as any).__replayTrace = trace;
        (window as any).__replayTraceIdx = 0;
        setStatus(`Replaying ${mission.id} (${trace.entries.length} ticks)`);
      }
    }
  };
}
