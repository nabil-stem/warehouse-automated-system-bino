import { getState, setState, setStatus, rebuildWorld } from "../app/appState";
import { generateMissions, assignMissions, resolveActiveMissionLimit } from "../domain/missionPlanner";
import { computeMetrics } from "../domain/metrics";
import { getParkingBays } from "../domain/robotSimulation";
import type { RobotRuntime } from "../domain/schema";

export type JuryVerdict = {
  allMissionsDone: boolean;
  allRobotsParked: boolean;
  zeroCollisions: boolean;
  avgWaitTime: number;
  throughput: number;
  totalTicks: number;
  score: number;
};

let juryDemoRunning = false;
let juryVerdict: JuryVerdict | null = null;
let compCollapsed = false;

export function getJuryDemoRunning(): boolean {
  return juryDemoRunning;
}

export function renderCompetitionOverlay(container: HTMLElement) {
  const state = getState();
  const robots = state.robots;
  const missions = state.missions;
  const metrics = state.metrics;

  const doneMissions = missions.filter(m => m.status === "done").length;
  const totalMissions = missions.length;
  const activeMissions = missions.filter(m => m.status !== "done" && m.status !== "failed" && m.status !== "queued").length;
  const queuedMissions = missions.filter(m => m.status === "queued").length;
  const failedMissions = missions.filter(m => m.status === "failed").length;

  const parkedRobots = robots.filter(r => r.state === "idle" || r.state === "charging").length;

  const allDone = totalMissions > 0 && doneMissions === totalMissions;
  const allParked = robots.every(r => r.state === "idle" || r.state === "charging");
  const noCollisions = metrics.physicalCollisions === 0;
  const avoidanceActions = metrics.yieldEvents + metrics.priorityPasses + metrics.deadlocksResolved;
  const effectiveActiveLimit = resolveActiveMissionLimit(missions, robots, state.scenario.simulation.maxActiveMissions, state.scenario);

  const parkingBays = getParkingBays();
  const occupiedBays = parkingBays.filter(b => b.state === "occupied").length;

  const robotStates = getRobotStateBreakdown(robots);

  container.innerHTML = `
    <div class="competition-panel ${compCollapsed ? "is-collapsed" : ""}">
      <div class="comp-header">
        <div class="comp-header-left">
          <span class="comp-title">Competition Mode</span>
          <span class="comp-tick">Tick ${state.tick}</span>
        </div>
        <button type="button" class="comp-collapse-btn" data-action="toggle-comp" title="${compCollapsed ? "Expand competition panel" : "Minimize competition panel"}" aria-expanded="${!compCollapsed}">
          ${compCollapsed ? "▴ Expand" : "▾ Minimize"}
        </button>
      </div>

      <div class="comp-final-state ${allDone && allParked ? 'comp-success' : totalMissions > 0 ? 'comp-running' : 'comp-idle'}">
        ${allDone && allParked && noCollisions ? '<span class="verdict-pass">ALL CLEAR - PASS</span>' :
          allDone && allParked ? '<span class="verdict-warn">COMPLETE (collisions detected)</span>' :
          totalMissions > 0 && state.running ? '<span class="verdict-running">SIMULATION RUNNING</span>' :
          totalMissions > 0 ? '<span class="verdict-paused">PAUSED</span>' :
          '<span class="verdict-idle">AWAITING MISSIONS</span>'}
      </div>

      <div class="comp-kpi-grid">
        <div class="comp-kpi">
          <span class="comp-kpi-val">${doneMissions}/${totalMissions}</span>
          <span class="comp-kpi-label">Missions Done</span>
        </div>
        <div class="comp-kpi">
          <span class="comp-kpi-val">${parkedRobots}/${robots.length}</span>
          <span class="comp-kpi-label">Robots Parked</span>
        </div>
        <div class="comp-kpi ${noCollisions ? 'comp-kpi-good' : 'comp-kpi-bad'}">
          <span class="comp-kpi-val">${metrics.physicalCollisions}</span>
          <span class="comp-kpi-label">Collisions</span>
        </div>
        <div class="comp-kpi">
          <span class="comp-kpi-val">${avoidanceActions}</span>
          <span class="comp-kpi-label">Conflicts Avoided</span>
        </div>
        <div class="comp-kpi">
          <span class="comp-kpi-val">${metrics.throughputPerHour.toFixed(1)}/h</span>
          <span class="comp-kpi-label">Throughput</span>
        </div>
        <div class="comp-kpi">
          <span class="comp-kpi-val">${(metrics.routeEfficiency * 100).toFixed(0)}%</span>
          <span class="comp-kpi-label">Route Efficiency</span>
        </div>
      </div>

      <div class="comp-collapsible-body" ${compCollapsed ? "hidden" : ""}>
        <div class="comp-details">
          <div class="comp-detail-row"><span>Avg wait time</span><span>${metrics.avgWaitTime.toFixed(1)} ticks</span></div>
          <div class="comp-detail-row"><span>Route efficiency</span><span>${(metrics.routeEfficiency * 100).toFixed(1)}%</span></div>
          <div class="comp-detail-row"><span>Bottleneck aisle</span><span>${metrics.topCongestedAisle}</span></div>
          <div class="comp-detail-row"><span>Parking status</span><span>${occupiedBays}/${parkingBays.length} bays</span></div>
          <div class="comp-detail-row"><span>Active missions</span><span>${activeMissions}/${effectiveActiveLimit}</span></div>
          <div class="comp-detail-row"><span>Queued</span><span>${queuedMissions}</span></div>
          <div class="comp-detail-row"><span>Failed</span><span class="${failedMissions > 0 ? 'comp-danger' : ''}">${failedMissions}</span></div>
        </div>

        <div class="comp-robot-states">
          <span class="comp-state-label">Robot States:</span>
          <div class="comp-state-pills">
            ${robotStates.map(s => `<span class="comp-pill comp-pill-${s.cls}">${s.label} ${s.count}</span>`).join('')}
          </div>
        </div>

        ${juryVerdict ? renderVerdictCard(juryVerdict) : ''}

        <div class="comp-actions">
          <button class="btn btn-primary comp-btn" data-action="jury-demo" ${juryDemoRunning ? 'disabled' : ''}>
            ${juryDemoRunning ? 'Demo Running...' : 'Reset + Run Jury Demo'}
          </button>
          <label class="comp-check-label">
            <input type="checkbox" data-action="toggle-charging" ${(state.scenario.simulation.juryChargingShowcase ?? true) ? 'checked' : ''} />
            <span>Charging showcase (one robot docks at charger)</span>
          </label>
          <label class="comp-check-label">
            <input type="checkbox" data-action="toggle-roundtrip" ${(state.scenario.simulation.returnBoxesToShelf ?? false) ? 'checked' : ''} />
            <span>Operator round-trip (return totes to shelf)</span>
          </label>
        </div>
      </div>
    </div>
  `;

  container.querySelector('[data-action="toggle-comp"]')?.addEventListener('click', () => {
    compCollapsed = !compCollapsed;
    renderCompetitionOverlay(container);
  });
  container.querySelector('[data-action="jury-demo"]')?.addEventListener('click', () => {
    startJuryDemo();
  });
  container.querySelector('[data-action="toggle-charging"]')?.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    getState().scenario.simulation.juryChargingShowcase = checked;
    setStatus(checked ? "Charging showcase enabled for next jury demo" : "Charging showcase disabled");
  });
  container.querySelector('[data-action="toggle-roundtrip"]')?.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    getState().scenario.simulation.returnBoxesToShelf = checked;
    setStatus(checked
      ? "Operator round-trip enabled: boxes will be processed and returned to their shelf"
      : "Operator round-trip disabled: boxes are delivered at the station");
  });
}

function renderVerdictCard(v: JuryVerdict): string {
  const passed = v.allMissionsDone && v.allRobotsParked && v.zeroCollisions;
  return `
    <div class="comp-verdict ${passed ? 'comp-verdict-pass' : 'comp-verdict-fail'}">
      <div class="comp-verdict-title">${passed ? 'JURY VERDICT: PASS' : 'JURY VERDICT: ISSUES DETECTED'}</div>
      <div class="comp-verdict-grid">
        <span>${v.allMissionsDone ? 'OK' : 'FAIL'}</span><span>All missions complete</span>
        <span>${v.allRobotsParked ? 'OK' : 'FAIL'}</span><span>All robots parked</span>
        <span>${v.zeroCollisions ? 'OK' : 'FAIL'}</span><span>No collisions</span>
      </div>
      <div class="comp-verdict-stats">
        <span>Score: ${v.score}/100</span>
        <span>Ticks: ${v.totalTicks}</span>
        <span>Throughput: ${v.throughput.toFixed(1)}/h</span>
        <span>Avg wait: ${v.avgWaitTime.toFixed(1)}</span>
      </div>
    </div>
  `;
}

function getRobotStateBreakdown(robots: RobotRuntime[]): { label: string; count: number; cls: string }[] {
  const counts: Record<string, number> = {};
  for (const r of robots) {
    counts[r.state] = (counts[r.state] || 0) + 1;
  }
  const mapping: Record<string, { label: string; cls: string }> = {
    'idle': { label: 'Parked', cls: 'idle' },
    'to-pick': { label: 'To Pick', cls: 'moving' },
    'picking': { label: 'Lifting', cls: 'action' },
    'to-drop': { label: 'Carrying', cls: 'carry' },
    'placing': { label: 'Placing', cls: 'action' },
    'returning': { label: 'Returning', cls: 'returning' },
    'yielding': { label: 'Yielding', cls: 'wait' },
    'to-point': { label: 'To Point', cls: 'moving' },
    'charging': { label: 'Charging', cls: 'charge' },
    'to-charge': { label: 'To Charge', cls: 'charge' },
  };
  return Object.entries(counts)
    .filter(([_, c]) => c > 0)
    .map(([state, count]) => ({
      label: mapping[state]?.label ?? state,
      count,
      cls: mapping[state]?.cls ?? 'idle',
    }));
}

export function startJuryDemo() {
  if (juryDemoRunning) return;
  juryDemoRunning = true;
  juryVerdict = null;

  rebuildWorld();
  const state = getState();

  state.scenario.simulation.routing = "reservation-table";
  state.scenario.simulation.allocator = "nearest-robot";
  state.scenario.simulation.collisionAvoidance = true;
  state.scenario.simulation.maxActiveMissions = 4;
  state.scenario.simulation.autoScaleActiveMissions = true;
  state.scenario.simulation.parkingStrategy = "home-slots";
  state.scenario.simulation.timeScale = 3.0;

  if (state.scenario.simulation.juryChargingShowcase ?? true) {
    const charger = state.scenario.stations.find(s => s.type === "charging");
    if (charger) {
      const showcase = [...state.robots].sort((a, b) =>
        Math.hypot(a.homePosition.x - charger.position.x, a.homePosition.z - charger.position.z) -
        Math.hypot(b.homePosition.x - charger.position.x, b.homePosition.z - charger.position.z)
      )[0];
      if (showcase) {
        showcase.batteryMinutes = 4.5;
      }
    }
  }

  const missions = generateMissions(state.scenario, state.slots, 11, 0, state.missions);
  state.missions.push(...missions);

  assignMissions(
    state.missions, state.robots, state.navGraph, state.slots,
    state.scenario.simulation.allocator, state.scenario.stations,
    state.scenario.simulation.maxActiveMissions,
    state.scenario, state.congestionMap, state.tick
  );

  setState({ running: true });
  setStatus("Jury Demo started - 11 missions, full collision avoidance");

  monitorJuryDemo();
}

function monitorJuryDemo() {
  const check = () => {
    const state = getState();
    if (!state.running && !juryDemoRunning) return;

    const allDone = state.missions.length > 0 && state.missions.every(m => m.status === "done" || m.status === "failed");
    const allParked = state.robots.every(r => r.state === "idle" || r.state === "charging");

    if (allDone && allParked) {
      juryDemoRunning = false;
      setState({ running: false });

      const metrics = computeMetrics(
        state.robots, state.missions, state.slots,
        state.congestionMap, state.tick,
        state.scenario.simulation.tickMs,
        state.metrics.throughputHistory,
        state.scenario.stations
      );

      const allMissionsDone = state.missions.every(m => m.status === "done");
      const zeroCollisions = metrics.physicalCollisions === 0;

      const throughputScore = Math.min(45, metrics.throughputPerHour * 1.5);
      const utilizationScore = Math.min(25, metrics.avgRobotUtilization * 35);
      const reliabilityScore = Math.max(0, 20 - metrics.failedMissions * 5);
      const waitPenalty = Math.min(18, metrics.avgWaitTime / 8);
      const score = Math.max(0, Math.min(100, Math.round(throughputScore + utilizationScore + reliabilityScore - waitPenalty + 10)));

      juryVerdict = {
        allMissionsDone,
        allRobotsParked: allParked,
        zeroCollisions,
        avgWaitTime: metrics.avgWaitTime,
        throughput: metrics.throughputPerHour,
        totalTicks: state.tick,
        score,
      };

      setStatus(`Jury Demo complete - Score: ${score}/100 ${allMissionsDone && allParked && zeroCollisions ? '- ALL PASS' : '- ISSUES DETECTED'}`);
      return;
    }

    requestAnimationFrame(check);
  };

  requestAnimationFrame(check);
}

export function updateCompetitionOverlay(container: HTMLElement) {
  const el = container.querySelector('.competition-panel');
  if (el) {
    renderCompetitionOverlay(container);
  }
}
