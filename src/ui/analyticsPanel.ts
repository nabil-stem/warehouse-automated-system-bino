import { getState } from "../app/appState";
import { getTrafficEvents, getDeadlockStats } from "../domain/robotSimulation";
import type { SimMetrics } from "../domain/schema";

export function renderAnalyticsPanel(container: HTMLElement) {
  container.innerHTML = `
    <div class="panel-section">
      <h3>Performance</h3>
      <div id="an-kpis" class="kpi-grid"></div>
    </div>
    <div class="panel-section">
      <h3>Throughput Trend</h3>
      <div id="an-spark"></div>
    </div>
    <div class="panel-section">
      <h3>Mission Outcomes</h3>
      <div id="an-missions"></div>
    </div>
    <div class="panel-section">
      <h3>Traffic & Safety</h3>
      <div id="an-traffic"></div>
    </div>
  `;
  updateAnalyticsPanel(container);
}

export function updateAnalyticsPanel(container: HTMLElement) {
  const state = getState();
  const m = state.metrics;

  const kpiEl = container.querySelector("#an-kpis");
  if (kpiEl) {
    kpiEl.innerHTML = [
      kpi("Throughput", `${m.throughputPerHour.toFixed(1)}`, "/hr"),
      kpi("Route efficiency", `${(m.routeEfficiency * 100).toFixed(0)}`, "%"),
      kpi("Avg wait", `${m.avgWaitTime.toFixed(1)}`, "ticks"),
      kpi("Total distance", `${m.totalDistanceTraveled.toFixed(0)}`, "m"),
      kpi("Completed", `${m.doneMissions}`, "missions"),
      kpi("Utilization", `${(m.avgRobotUtilization * 100).toFixed(0)}`, "%"),
    ].join("");
  }

  const sparkEl = container.querySelector("#an-spark");
  if (sparkEl) sparkEl.innerHTML = sparkline(m.throughputHistory);

  const missionsEl = container.querySelector("#an-missions");
  if (missionsEl) {
    const total = m.doneMissions + m.queuedMissions + m.failedMissions || 1;
    missionsEl.innerHTML = `
      <div class="stack-bar">
        <div class="seg seg-done" style="width:${(m.doneMissions / total) * 100}%"></div>
        <div class="seg seg-queued" style="width:${(m.queuedMissions / total) * 100}%"></div>
        <div class="seg seg-failed" style="width:${(m.failedMissions / total) * 100}%"></div>
      </div>
      <div class="kv-list">
        <div class="kv"><span>Done</span><span>${m.doneMissions}</span></div>
        <div class="kv"><span>Queued</span><span>${m.queuedMissions}</span></div>
        <div class="kv"><span>Failed</span><span class="${m.failedMissions > 0 ? "txt-danger" : ""}">${m.failedMissions}</span></div>
        <div class="kv"><span>Avg mission time</span><span>${m.avgMissionTime.toFixed(0)} ticks</span></div>
      </div>
    `;
  }

  const trafficEl = container.querySelector("#an-traffic");
  if (trafficEl) {
    const events = getTrafficEvents();
    const dl = getDeadlockStats();
    trafficEl.innerHTML = `
      <div class="kv-list">
        <div class="kv"><span>Physical collisions</span><span class="${m.physicalCollisions > 0 ? "txt-danger" : "txt-success"}">${m.physicalCollisions}</span></div>
        <div class="kv"><span>Conflicts predicted</span><span>${m.totalConflicts}</span></div>
        <div class="kv"><span>Avoidance actions</span><span>${m.yieldEvents + m.priorityPasses + dl.deadlocksResolved}</span></div>
        <div class="kv"><span>Yield events</span><span>${m.yieldEvents}</span></div>
        <div class="kv"><span>Priority passes</span><span>${m.priorityPasses}</span></div>
        <div class="kv"><span>Deadlocks resolved</span><span>${dl.deadlocksResolved}/${dl.deadlocksDetected}</span></div>
        <div class="kv"><span>Dynamic reroutes</span><span>${m.dynamicReroutes}</span></div>
        <div class="kv"><span>Bottleneck aisle</span><span>${m.topCongestedAisle}</span></div>
        <div class="kv"><span>Traffic events logged</span><span>${events.length}</span></div>
      </div>
    `;
  }
}

function kpi(label: string, value: string, unit: string): string {
  return `<div class="kpi-card">
    <div class="kpi-value">${value}<span class="kpi-unit">${unit}</span></div>
    <div class="kpi-label">${label}</div>
  </div>`;
}

function sparkline(data: SimMetrics["throughputHistory"]): string {
  if (!data || data.length < 2) return `<div class="hint">Run the simulation to chart throughput.</div>`;
  const max = Math.max(...data, 1);
  const w = 300;
  const h = 60;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * h}`).join(" ");
  const area = `0,${h} ${pts} ${w},${h}`;
  return `<svg class="spark-svg" width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polygon points="${area}" fill="rgba(55,216,194,0.12)" />
    <polyline points="${pts}" fill="none" stroke="#37d8c2" stroke-width="2" />
  </svg>`;
}
