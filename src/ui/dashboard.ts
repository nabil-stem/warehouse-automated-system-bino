import type { SimMetrics } from "../domain/schema";

export function renderDashboard(container: HTMLElement, metrics: SimMetrics, _statusMessage: string) {
  const totalMissions = metrics.doneMissions + metrics.queuedMissions + metrics.failedMissions;
  container.innerHTML = `
    <div class="kpi-grid kpi-compact">
      ${kpiCard("Robots active", `${metrics.activeRobots}`, `of ${metrics.totalRobots}`)}
      ${kpiCard("Missions done", `${metrics.doneMissions}`, totalMissions > 0 ? `of ${totalMissions}` : "")}
      ${kpiCard("Throughput", `${metrics.throughputPerHour.toFixed(1)}`, "per hour")}
      ${kpiCard("Collisions", `${metrics.physicalCollisions}`, metrics.physicalCollisions === 0 ? "safe" : "contact", metrics.physicalCollisions === 0 ? "good" : "bad")}
      ${kpiCard("Avg wait", `${metrics.avgWaitTime.toFixed(1)}`, "ticks")}
      ${kpiCard("Route eff.", `${(metrics.routeEfficiency * 100).toFixed(0)}%`, "")}
    </div>
  `;
}

function kpiCard(label: string, value: string, sub: string, tone = ""): string {
  return `<div class="kpi-card ${tone ? "kpi-" + tone : ""}">
    <div class="kpi-value">${value}</div>
    <div class="kpi-label">${label}</div>
    ${sub ? `<div class="kpi-sub">${sub}</div>` : ""}
  </div>`;
}
