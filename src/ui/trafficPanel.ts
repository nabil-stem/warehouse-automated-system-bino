import { getState } from "../app/appState";
import { setSelectedRobotId } from "../render/sceneManager";
import {
  getDeadlockStats, getStationQueues, getTrafficEvents,
  getYieldBays, getSupervisorDecisions, getParkingBays,
  getStartupDispatchStats,
} from "../domain/robotSimulation";
import type { RobotRuntime } from "../domain/schema";

export function renderTrafficPanel(container: HTMLElement) {
  container.innerHTML = `
    <div class="panel-section">
      <h3>Traffic Overview</h3>
      <div id="tr-overview" class="kv-list"></div>
    </div>
    <div class="panel-section">
      <h3>Why Robots Wait</h3>
      <div id="tr-waits"></div>
    </div>
    <div class="panel-section">
      <h3>Startup Dispatch</h3>
      <div id="tr-startup"></div>
    </div>
    <div class="panel-section">
      <h3>Station Queues</h3>
      <div id="tr-queues"></div>
    </div>
    <div class="panel-section">
      <h3>Supervisor Decisions</h3>
      <div id="tr-supervisor"></div>
    </div>
    <div class="panel-section">
      <h3>Recent Traffic Events</h3>
      <div id="tr-events"></div>
    </div>
  `;
  container.onclick = (e) => {
    const row = (e.target as HTMLElement).closest("[data-robot]") as HTMLElement;
    if (row) setSelectedRobotId(parseInt(row.dataset.robot!));
  };
  updateTrafficPanel(container);
}

export function updateTrafficPanel(container: HTMLElement) {
  const state = getState();
  const { robots, metrics } = state;
  const events = getTrafficEvents();
  const yieldBays = getYieldBays();
  const dl = getDeadlockStats();
  const parkingBays = getParkingBays();

  const overviewEl = container.querySelector("#tr-overview");
  if (overviewEl) {
    overviewEl.innerHTML = `
      <div class="kv"><span>Route reservations</span><span>${metrics.routeReservationCount}</span></div>
      <div class="kv"><span>Yield bays in use</span><span>${yieldBays.filter(b => b.occupied).length}/${yieldBays.length}</span></div>
      <div class="kv"><span>Parking bays occupied</span><span>${parkingBays.filter(b => b.state === "occupied").length}/${parkingBays.length}</span></div>
      <div class="kv"><span>Deadlocks</span><span>${dl.deadlocksResolved} resolved / ${dl.deadlocksDetected} seen</span></div>
      <div class="kv"><span>Bottleneck aisle</span><span>${metrics.topCongestedAisle}</span></div>
      <div class="kv"><span>Physical collisions</span><span class="${metrics.physicalCollisions > 0 ? "txt-danger" : "txt-success"}">${metrics.physicalCollisions}</span></div>
      <div class="kv"><span>Conflicts predicted/avoided</span><span>${metrics.totalConflicts}</span></div>
    `;
  }

  const waitsEl = container.querySelector("#tr-waits");
  if (waitsEl) {
    const waiting = robots.filter(r => r.blockedTicks > 0 || r.state === "yielding");
    if (waiting.length === 0) {
      waitsEl.innerHTML = `<div class="alert alert-ok">No robots waiting — traffic flowing freely.</div>`;
    } else {
      waitsEl.innerHTML = waiting
        .sort((a, b) => b.blockedTicks - a.blockedTicks)
        .slice(0, 8)
        .map(r => `<div class="alert alert-warn" data-robot="${r.id}">R${pad(r.id)} — ${reason(r)}</div>`)
        .join("");
    }
  }

  const startupEl = container.querySelector("#tr-startup");
  if (startupEl) {
    const sd = getStartupDispatchStats();
    const held = robots.filter(r => r.launchCleared === false);
    const recent = sd.recentDecisions.slice(-6).reverse();
    startupEl.innerHTML = `
      <div class="kv-list">
        <div class="kv"><span>Robots held</span><span class="${sd.heldNow > 0 ? "txt-warn" : "txt-success"}">${sd.heldNow}</span></div>
        <div class="kv"><span>Cleared in launch zone</span><span>${sd.clearedInZone}</span></div>
        <div class="kv"><span>Active launch wave</span><span>${sd.activeWaveId > 0 ? "#" + sd.activeWaveId : "—"}</span></div>
        <div class="kv"><span>Total clearances</span><span>${sd.totalClearances}</span></div>
        <div class="kv"><span>Total holds</span><span>${sd.totalHolds}</span></div>
      </div>
      ${held.length > 0 ? held.map(r => `
        <div class="alert alert-warn" data-robot="${r.id}">
          R${pad(r.id)} — held for startup spacing (queue #${r.launchPriority ?? "?"}, ${r.startupHoldTicks ?? 0}t)
        </div>
      `).join("") : `<div class="hint">No robots waiting for launch clearance.</div>`}
      ${recent.length > 0 ? `
        <div style="margin-top:4px">
          ${recent.map(d => `
            <div class="log-row">
              <span class="log-tick">t${d.tick}</span>
              <span class="log-type">${d.action}</span>
              <span>R${pad(d.robotId)} w${d.waveId}</span>
              <span class="log-reason">${d.reason}</span>
            </div>
          `).join("")}
        </div>
      ` : ""}
    `;
  }

  const queuesEl = container.querySelector("#tr-queues");
  if (queuesEl) {
    const queues = getStationQueues();
    queuesEl.innerHTML = queues.length === 0
      ? `<div class="hint">No station queue activity yet.</div>`
      : queues.map(q => `
          <div class="kv"><span>${q.stationId}</span><span>${q.occupiedBy.length}/${q.approachPositions.length} slots</span></div>
        `).join("");
  }

  const supEl = container.querySelector("#tr-supervisor");
  if (supEl) {
    const decisions = getSupervisorDecisions().slice(-4).reverse();
    supEl.innerHTML = decisions.length === 0
      ? `<div class="hint">No supervisor interventions yet.</div>`
      : decisions.map(d => `
          <div class="log-row">
            <span class="log-tick">t${d.tick}</span>
            <span>cluster ${d.clusterSize} → protect R${pad(d.protectedRobotId)}</span>
            <span class="log-reason">${d.protectedReason}</span>
          </div>
        `).join("");
  }

  const eventsEl = container.querySelector("#tr-events");
  if (eventsEl) {
    const recent = events.slice(-8).reverse();
    eventsEl.innerHTML = recent.length === 0
      ? `<div class="hint">No traffic events logged.</div>`
      : recent.map(e => `
          <div class="log-row log-${e.type}">
            <span class="log-tick">t${e.tick}</span>
            <span class="log-type">${e.type}</span>
            <span>R${pad(e.robotId)}${e.otherRobotId ? ` vs R${pad(e.otherRobotId)}` : ""}</span>
            <span class="log-reason">${e.reason}</span>
          </div>
        `).join("");
  }
}

function reason(r: RobotRuntime): string {
  if (r.state === "yielding") return r.waitingForRobotId ? `yielding for R${pad(r.waitingForRobotId)}` : "yielding to clear lane";
  if (r.waitingForRobotId) return `waiting on R${pad(r.waitingForRobotId)} (${r.blockedTicks}t)`;
  return `waiting for reserved clearance (${r.blockedTicks}t)`;
}

function pad(n: number): string { return String(n).padStart(2, "0"); }
