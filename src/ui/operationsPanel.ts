import { getState, setState, setStatus } from "../app/appState";
import { generateMissions, assignMissions } from "../domain/missionPlanner";
import { computeMetrics } from "../domain/metrics";
import { resetCollisionTracking } from "../domain/robotSimulation";
import { setSelectedRobotId } from "../render/sceneManager";
import type { Mission, RobotRuntime, Slot } from "../domain/schema";

const STATE_META: Record<string, { label: string; cls: string }> = {
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

export function renderOperationsPanel(container: HTMLElement) {
  container.innerHTML = `
    <div class="panel-section">
      <h3>Quick Dispatch</h3>
      <label class="ctrl"><span>Batch size</span>
        <input type="number" data-field="opsBatch" value="${getState().scenario.simulation.missionCount}" min="1" max="200" /></label>
      <div class="panel-actions">
        <button class="btn btn-primary" data-action="ops-generate">Generate Missions</button>
        <button class="btn" data-action="ops-clear">Clear Done</button>
      </div>
      <div class="hint">Use the command bar to run, pause, step, or launch the jury demo. Detailed dispatch lives in the Missions view.</div>
    </div>
    <div class="panel-section">
      <h3>Fleet State</h3>
      <div id="ops-fleet-pills" class="pill-row"></div>
    </div>
    <div class="panel-section">
      <h3>Active Missions</h3>
      <div id="ops-active-missions"></div>
    </div>
    <div class="panel-section">
      <h3>Traffic Alerts</h3>
      <div id="ops-alerts"></div>
    </div>
  `;

  container.onclick = (e) => {
    const robotCard = (e.target as HTMLElement).closest("[data-robot]") as HTMLElement;
    if (robotCard) { setSelectedRobotId(parseInt(robotCard.dataset.robot!)); return; }
    const btn = (e.target as HTMLElement).closest("[data-action]") as HTMLElement;
    if (!btn) return;
    const state = getState();
    if (btn.dataset.action === "ops-generate") {
      const n = parseInt((container.querySelector('[data-field="opsBatch"]') as HTMLInputElement)?.value ?? "10") || 10;
      if (state.missions.length === 0 || state.missions.every(m => m.status === "done" || m.status === "failed")) {
        resetCollisionTracking();
        state.congestionMap.clear();
      }
      const created = generateMissions(state.scenario, state.slots, n, state.tick, state.missions);
      state.missions.push(...created);
      assignMissions(
        state.missions, state.robots, state.navGraph, state.slots,
        state.scenario.simulation.allocator, state.scenario.stations,
        state.scenario.simulation.maxActiveMissions, state.scenario, state.congestionMap,
        state.tick
      );
      refreshMetrics();
      setStatus(`Generated ${created.length} missions`);
      updateOperationsPanel(container);
    }
    if (btn.dataset.action === "ops-clear") {
      state.missions = state.missions.filter(m => m.status !== "done" && m.status !== "failed");
      refreshMetrics();
      setStatus("Cleared completed missions");
      updateOperationsPanel(container);
    }
  };

  updateOperationsPanel(container);
}

function refreshMetrics() {
  const state = getState();
  state.metrics = computeMetrics(
    state.robots, state.missions, state.slots, state.congestionMap,
    state.tick, state.scenario.simulation.tickMs,
    state.metrics.throughputHistory, state.scenario.stations
  );
}

export function updateOperationsPanel(container: HTMLElement) {
  const state = getState();
  const { robots, missions, slots } = state;

  const pillsEl = container.querySelector("#ops-fleet-pills");
  if (pillsEl) {
    const counts: Record<string, number> = {};
    for (const r of robots) counts[r.state] = (counts[r.state] ?? 0) + 1;
    pillsEl.innerHTML = Object.entries(counts)
      .map(([st, c]) => {
        const m = STATE_META[st] ?? { label: st, cls: "idle" };
        return `<span class="pill pill-${m.cls}">${m.label} ${c}</span>`;
      })
      .join("") || `<span class="hint">No robots</span>`;
  }

  const activeEl = container.querySelector("#ops-active-missions");
  if (activeEl) {
    const active = missions.filter(m => m.status !== "done" && m.status !== "failed" && m.status !== "queued");
    if (active.length === 0) {
      activeEl.innerHTML = `<div class="hint">No active missions. Generate a batch to begin.</div>`;
    } else {
      activeEl.innerHTML = active.slice(0, 8).map(m => missionCard(m, robots, slots)).join("");
    }
  }

  const alertsEl = container.querySelector("#ops-alerts");
  if (alertsEl) {
    const blocked = robots.filter(r => r.blockedTicks > 0);
    const yielding = robots.filter(r => r.state === "yielding");
    const failed = missions.filter(m => m.status === "failed");
    const rows: string[] = [];
    if (blocked.length === 0 && yielding.length === 0 && failed.length === 0) {
      rows.push(`<div class="alert alert-ok">All lanes clear — no conflicts or blocks.</div>`);
    }
    for (const r of yielding.slice(0, 4)) {
      rows.push(`<div class="alert alert-warn" data-robot="${r.id}">R${pad(r.id)} yielding${r.waitingForRobotId ? ` for R${pad(r.waitingForRobotId)}` : ""}</div>`);
    }
    for (const r of blocked.slice(0, 4)) {
      rows.push(`<div class="alert alert-warn" data-robot="${r.id}">R${pad(r.id)} waiting ${r.blockedTicks}t for clearance</div>`);
    }
    for (const m of failed.slice(0, 3)) {
      rows.push(`<div class="alert alert-danger">${m.id} failed: ${m.failReason ?? "unknown"}</div>`);
    }
    alertsEl.innerHTML = rows.join("");
  }
}

function missionCard(m: Mission, robots: RobotRuntime[], slots: Slot[]): string {
  const robot = robots.find(r => r.id === m.assignedRobotId);
  const slot = slots.find(s => s.id === m.sourceSlotId);
  const src = m.type === "move-to-point" ? "point" : slot ? `R${slot.rowIndex}/B${slot.bayIndex}/L${slot.levelIndex + 1}` : m.sourceSlotId;
  const meta = robot ? STATE_META[robot.state] ?? { label: robot.state, cls: "idle" } : { label: m.status, cls: "moving" };
  return `
    <div class="ops-card" ${robot ? `data-robot="${robot.id}"` : ""}>
      <div class="ops-card-top">
        <span class="ops-card-id">${m.id}</span>
        <span class="pill pill-${meta.cls}">${meta.label}</span>
      </div>
      <div class="ops-card-line">
        <span>${robot ? "R" + pad(robot.id) : "unassigned"}</span>
        <span>${src} → ${m.type === "move-to-point" ? "point" : m.targetStationId}</span>
      </div>
      ${m.statusNote ? `<div class="ops-card-note">${m.statusNote}</div>` : ""}
    </div>
  `;
}

function pad(n: number): string { return String(n).padStart(2, "0"); }
