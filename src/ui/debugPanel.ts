import { getState } from "../app/appState";
import { isSourceSlotReserved } from "../domain/missionPlanner";
import { buildSolidObstacles } from "../domain/obstacles";
import { getDeadlockStats, getStationQueues, getTrafficEvents, getYieldBays, getSupervisorDecisions, getParkingBays, getParkingReassignments, getStartupDispatchStats, getMissionAnalysis } from "../domain/robotSimulation";

export function renderDebugPanel(container: HTMLElement) {
  container.innerHTML = `
    <div class="panel-section">
      <h3>Fleet Timeline</h3>
      <div id="debug-fleet-timeline"></div>
    </div>
    <div class="panel-section">
      <h3>Nav Graph</h3>
      <div id="debug-navgraph"></div>
    </div>
    <div class="panel-section">
      <h3>Collision & Reservation</h3>
      <div id="debug-collision"></div>
    </div>
    <div class="panel-section">
      <h3>Obstacle Model</h3>
      <div id="debug-obstacles"></div>
    </div>
    <div class="panel-section">
      <h3>Deadlock & Traffic</h3>
      <div id="debug-deadlock"></div>
    </div>
    <div class="panel-section">
      <h3>Station Queues</h3>
      <div id="debug-station-queues"></div>
    </div>
    <div class="panel-section">
      <h3>Startup Dispatch</h3>
      <div id="debug-startup-dispatch"></div>
    </div>
    <div class="panel-section">
      <h3>Mission Analysis</h3>
      <div id="debug-mission-analysis"></div>
    </div>
    <div class="panel-section">
      <h3>Traffic Controller</h3>
      <div id="debug-traffic-controller"></div>
    </div>
    <div class="panel-section">
      <h3>Traffic KPIs</h3>
      <div id="debug-traffic-kpi"></div>
    </div>
    <div class="panel-section">
      <h3>Parking Management</h3>
      <div id="debug-parking"></div>
    </div>
    <div class="panel-section">
      <h3>Per-Robot State</h3>
      <div class="debug-robot-table" id="debug-robots"></div>
    </div>
  `;
  updateDebugPanel(container);
}

export function updateDebugPanel(container: HTMLElement) {
  const state = getState();
  const { navGraph, robots, missions, congestionMap, slots } = state;

  const timelineEl = container.querySelector("#debug-fleet-timeline");
  if (timelineEl) {
    const stateColors: Record<string, string> = {
      "idle": "#556677",
      "to-pick": "#62d7b8",
      "picking": "#9b59b6",
      "to-drop": "#3b8be2",
      "placing": "#9b59b6",
      "returning": "#8fd3ff",
      "yielding": "#f5a623",
      "to-point": "#62d7b8",
      "charging": "#f5c542",
      "to-charge": "#f5c542",
    };
    const stateLabels: Record<string, string> = {
      "idle": "PKD",
      "to-pick": "TPK",
      "picking": "LFT",
      "to-drop": "TDR",
      "placing": "PLC",
      "returning": "RTN",
      "yielding": "YLD",
      "to-point": "TPT",
      "charging": "CHG",
      "to-charge": "TCH",
    };
    timelineEl.innerHTML = `
      <div class="fleet-timeline">
        ${robots.map(r => {
          const color = stateColors[r.state] ?? "#556677";
          const label = stateLabels[r.state] ?? r.state.slice(0, 3).toUpperCase();
          const blocked = r.blockedTicks > 0;
          const missionLabel = r.missionId ? r.missionId.replace("M-", "") : "";
          return `
            <div class="fleet-row">
              <span class="fleet-robot-id">R${String(r.id).padStart(2, "0")}</span>
              <div class="fleet-bar" style="background:${color}${blocked ? ";animation:pulse 0.8s infinite" : ""}">
                <span class="fleet-bar-label">${label}${missionLabel ? " " + missionLabel : ""}${blocked ? " BLK" + r.blockedTicks : ""}</span>
              </div>
              ${r.liftTelemetry.currentExtensionPct > 0 ? `<span class="fleet-lift">${r.liftTelemetry.currentExtensionPct.toFixed(0)}%</span>` : ""}
            </div>
          `;
        }).join("")}
      </div>
      <div class="fleet-legend">
        <span style="color:#62d7b8">TPK/TDR=driving</span>
        <span style="color:#9b59b6">LFT/PLC=action</span>
        <span style="color:#f5a623">YLD=yield</span>
        <span style="color:#8fd3ff">RTN=return</span>
      </div>
    `;
  }

  const navEl = container.querySelector("#debug-navgraph");
  if (navEl) {
    let edgeCount = 0;
    let diagonalEdges = 0;
    const seen = new Set<string>();
    for (const node of navGraph.nodes.values()) {
      for (const nid of node.neighbors) {
        const key = [node.id, nid].sort().join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        edgeCount++;
        const neighbor = navGraph.nodes.get(nid);
        if (!neighbor) continue;
        const dx = Math.abs(node.position.x - neighbor.position.x);
        const dz = Math.abs(node.position.z - neighbor.position.z);
        if (dx > 0.05 && dz > 0.05) diagonalEdges++;
      }
    }

    const occupiedSlots = slots.filter(s => s.occupied);
    const reservedCount = occupiedSlots.filter(s =>
      isSourceSlotReserved(missions, s.id)
    ).length;

    const activeRobots = robots.filter(r => r.state !== "idle" && r.state !== "charging").length;
    const blockedRobots = robots.filter(r => r.blockedTicks > 0).length;

    navEl.innerHTML = `
      <div class="debug-grid">
        <span>Nodes</span><span class="debug-val">${navGraph.nodes.size}</span>
        <span>Edges</span><span class="debug-val">${edgeCount}</span>
        <span>Diagonal edges</span><span class="debug-val ${diagonalEdges > 0 ? "debug-warn" : ""}">${diagonalEdges}</span>
        <span>Reserved sources</span><span class="debug-val">${reservedCount}</span>
        <span>Active robots</span><span class="debug-val">${activeRobots}</span>
        <span>Blocked robots</span><span class="debug-val ${blockedRobots > 0 ? "debug-warn" : ""}">${blockedRobots}</span>
      </div>
    `;
  }

  const collEl = container.querySelector("#debug-collision");
  if (collEl) {
    const totalWaits = robots.reduce((s, r) => s + r.totalWaitTicks, 0);
    const replans = missions.filter(m => m.statusNote?.includes("Replanning")).length;
    const maxWaitRobot = robots.reduce((best, r) =>
      r.totalWaitTicks > (best?.totalWaitTicks ?? 0) ? r : best, robots[0]);

    let topAisle = "none";
    let maxCong = 0;
    for (const [key, val] of congestionMap) {
      if (val > maxCong) { maxCong = val; topAisle = key; }
    }

    collEl.innerHTML = `
      <div class="debug-grid">
        <span>Total wait ticks</span><span class="debug-val">${totalWaits}</span>
        <span>Replans</span><span class="debug-val">${replans}</span>
        <span>Max wait robot</span><span class="debug-val">R${String(maxWaitRobot?.id ?? 0).padStart(2, "0")} (${maxWaitRobot?.totalWaitTicks ?? 0})</span>
        <span>Top congested</span><span class="debug-val">${topAisle}</span>
      </div>
    `;
  }

  const obstacleEl = container.querySelector("#debug-obstacles");
  if (obstacleEl) {
    const scenario = state.scenario;
    const solids = buildSolidObstacles(scenario);
    const rackCount = solids.filter(s => s.id.startsWith("rack-")).length;
    const stationCount = solids.filter(s => s.id.startsWith("station-")).length;
    const bollardCount = solids.filter(s => s.id.startsWith("bollard-")).length;
    const columnCount = solids.filter(s => s.id.startsWith("column-")).length;
    const dockCount = solids.filter(s => s.id.startsWith("dock-")).length;

    const nodesWithNeighbors = [...navGraph.nodes.values()].filter(n => n.neighbors.length > 0).length;
    const totalPossible = nodesWithNeighbors + (columnCount > 0 ? columnCount * 2 : 0);
    const blockedRatio = columnCount > 0 && totalPossible > 0 ? columnCount / totalPossible : 0;
    const columnWarning = scenario.visual.showSupportColumns && blockedRatio > 0.05;

    obstacleEl.innerHTML = `
      <div class="obstacle-grid">
        <span>Rack solids</span><span class="obstacle-val">${rackCount}</span>
        <span>Station solids</span><span class="obstacle-val">${stationCount}</span>
        <span>Bollards</span><span class="obstacle-val">${bollardCount}</span>
        <span>Support columns</span><span class="obstacle-val">${columnCount}</span>
        <span>Dock bumpers</span><span class="obstacle-val">${dockCount}</span>
        <span>Total obstacles</span><span class="obstacle-val">${solids.length}</span>
      </div>
      ${columnWarning ? `<div class="obstacle-warn">Support columns enabled - ${columnCount} column solids may block nav nodes. Disable in Layout if robots get stuck.</div>` : ""}
    `;
  }

  const deadlockEl = container.querySelector("#debug-deadlock");
  if (deadlockEl) {
    const dlStats = getDeadlockStats();
    const waitingRobots = robots.filter(r => r.waitingForRobotId !== undefined).length;
    const recoveredRobots = robots.reduce((s, r) => s + r.deadlockRecoveries, 0);
    deadlockEl.innerHTML = `
      <div class="debug-grid">
        <span>Deadlocks detected</span><span class="debug-val ${dlStats.deadlocksDetected > 0 ? "debug-warn" : ""}">${dlStats.deadlocksDetected}</span>
        <span>Deadlocks resolved</span><span class="debug-val">${dlStats.deadlocksResolved}</span>
        <span>Time-window reservations</span><span class="debug-val">${dlStats.timeWindowReservations}</span>
        <span>Robots waiting</span><span class="debug-val ${waitingRobots > 0 ? "debug-warn" : ""}">${waitingRobots}</span>
        <span>Total recoveries</span><span class="debug-val">${recoveredRobots}</span>
      </div>
    `;
  }

  const stationQueueEl = container.querySelector("#debug-station-queues");
  if (stationQueueEl) {
    const queues = getStationQueues();
    if (queues.length === 0) {
      stationQueueEl.innerHTML = `<div class="empty-msg">No station queue data yet</div>`;
    } else {
      stationQueueEl.innerHTML = queues.map(q => `
        <div class="debug-grid">
          <span>${q.stationId}</span>
          <span class="debug-val">${q.occupiedBy.length}/${q.approachPositions.length} slots</span>
        </div>
      `).join("");
    }
  }

  const startupEl = container.querySelector("#debug-startup-dispatch");
  if (startupEl) {
    const sd = getStartupDispatchStats();
    const heldRobots = robots.filter(r => r.launchCleared === false);
    const recentLaunches = sd.recentDecisions.slice(-8).reverse();
    startupEl.innerHTML = `
      <div class="debug-grid">
        <span>Robots held</span><span class="debug-val ${sd.heldNow > 0 ? "debug-warn" : ""}">${sd.heldNow}</span>
        <span>Cleared in launch zone</span><span class="debug-val">${sd.clearedInZone}</span>
        <span>Active launch wave</span><span class="debug-val">${sd.activeWaveId > 0 ? "#" + sd.activeWaveId : "-"}</span>
        <span>Total clearances</span><span class="debug-val">${sd.totalClearances}</span>
        <span>Total holds</span><span class="debug-val">${sd.totalHolds}</span>
      </div>
      ${heldRobots.length > 0 ? `
        <div class="traffic-log">
          <div class="traffic-label">Held For Startup Spacing</div>
          ${heldRobots.map(r => `
            <div class="traffic-event" style="font-size:11px">
              <span>R${String(r.id).padStart(2, "0")}</span>
              <span>queue #${r.launchPriority ?? "?"}</span>
              <span>${r.startupHoldTicks ?? 0}t</span>
              <span class="traffic-reason">${r.launchReason ?? ""}</span>
            </div>
          `).join("")}
        </div>
      ` : ""}
      ${recentLaunches.length > 0 ? `
        <div class="traffic-log" style="margin-top:6px">
          <div class="traffic-label">Recent Launch Decisions</div>
          ${recentLaunches.map(d => `
            <div class="traffic-event" style="font-size:11px">
              <span class="traffic-tick">t${d.tick}</span>
              <span class="traffic-type">${d.action}</span>
              <span>R${String(d.robotId).padStart(2, "0")} w${d.waveId}</span>
              <span class="traffic-reason">${d.reason}</span>
            </div>
          `).join("")}
        </div>
      ` : ""}
    `;
  }

  const analysisEl = container.querySelector("#debug-mission-analysis");
  if (analysisEl) {
    const records = getMissionAnalysis();
    if (records.length === 0) {
      analysisEl.innerHTML = `<div class="empty-msg">No completed missions analyzed yet</div>`;
    } else {
      const tickMs = state.scenario.simulation.tickMs;
      const sec = (ticks: number) => (ticks * tickMs / 1000).toFixed(1);
      const withEstimates = records.filter(r => r.estimatedTimeTicks !== undefined);
      const avgDelayPct = withEstimates.length > 0
        ? withEstimates.reduce((s, r) => s + (r.actualTimeTicks / Math.max(1, r.estimatedTimeTicks!) - 1), 0) / withEstimates.length * 100
        : 0;
      const problematic = records.filter(r => r.problems.length > 0);
      const recent = records.slice(-8).reverse();
      analysisEl.innerHTML = `
        <div class="debug-grid">
          <span>Missions analyzed</span><span class="debug-val">${records.length}</span>
          <span>Clean runs</span><span class="debug-val">${records.length - problematic.length}</span>
          <span>With problems</span><span class="debug-val ${problematic.length > 0 ? "debug-warn" : ""}">${problematic.length}</span>
          <span>Avg vs estimate</span><span class="debug-val ${avgDelayPct > 50 ? "debug-warn" : ""}">${avgDelayPct >= 0 ? "+" : ""}${avgDelayPct.toFixed(0)}%</span>
        </div>
        <div class="traffic-log" style="margin-top:6px">
          <div class="traffic-label">Recent Missions (estimate vs actual)</div>
          ${recent.map(r => `
            <div class="traffic-event" style="font-size:11px">
              <span>${r.missionId}</span>
              <span>R${String(r.robotId ?? 0).padStart(2, "0")} &rarr; ${r.targetStationId}</span>
              <span class="${r.status === "failed" ? "debug-warn" : ""}">${r.status}</span>
              <span>${r.estimatedTimeTicks !== undefined ? `est ${sec(r.estimatedTimeTicks)}s` : "est —"} / act ${sec(r.actualTimeTicks)}s</span>
              <span>${r.estimatedDistance !== undefined ? `est ${r.estimatedDistance}m` : ""} / ${r.actualDistance}m</span>
            </div>
            ${r.problems.length > 0 ? `
              <div class="traffic-event" style="font-size:11px; padding-left:12px">
                <span class="traffic-reason">${r.problems.join("; ")}</span>
              </div>
            ` : ""}
          `).join("")}
        </div>
      `;
    }
  }

  const trafficEl = container.querySelector("#debug-traffic-controller");
  if (trafficEl) {
    const events = getTrafficEvents();
    const yieldBays = getYieldBays();
    const yieldCount = events.filter(e => e.type === "yield").length;
    const headOnCount = events.filter(e => e.type === "head-on").length;
    const priorityCount = events.filter(e => e.type === "priority-pass").length;
    const queueCount = events.filter(e => e.type === "queue-wait").length;
    const clusterCount = events.filter(e => e.type === "cluster-resolve").length;
    const occupiedBays = yieldBays.filter(b => b.occupied).length;
    const yieldingRobots = robots.filter(r => r.state === "yielding");
    const decisions = getSupervisorDecisions();
    const recentDecisions = decisions.slice(-4).reverse();

    const recentEvents = events.slice(-8).reverse();

    trafficEl.innerHTML = `
      <div class="debug-grid">
        <span>Yield events</span><span class="debug-val">${yieldCount}</span>
        <span>Head-on conflicts</span><span class="debug-val ${headOnCount > 0 ? "debug-warn" : ""}">${headOnCount}</span>
        <span>Priority passes</span><span class="debug-val">${priorityCount}</span>
        <span>Queue waits</span><span class="debug-val">${queueCount}</span>
        <span>Cluster resolves</span><span class="debug-val ${clusterCount > 0 ? "debug-warn" : ""}">${clusterCount}</span>
        <span>Yield bays</span><span class="debug-val">${occupiedBays}/${yieldBays.length} occupied</span>
      </div>
      ${recentDecisions.length > 0 ? `
        <div class="traffic-log">
          <div class="traffic-label">Supervisor Decisions</div>
          ${recentDecisions.map(d => `
            <div class="traffic-event traffic-event-cluster-resolve">
              <span class="traffic-tick">t${d.tick}</span>
              <span class="traffic-type">cluster(${d.clusterSize})</span>
              <span>protect R${String(d.protectedRobotId).padStart(2, "0")} [${d.protectedReason}]</span>
            </div>
            ${d.commands.map(c => `
              <div class="traffic-event" style="padding-left:12px">
                <span class="traffic-type">${c.command}</span>
                <span>R${String(c.robotId).padStart(2, "0")}</span>
                <span class="traffic-reason">${c.reason}</span>
              </div>
            `).join("")}
          `).join("")}
        </div>
      ` : ""}
      ${yieldingRobots.length > 0 ? `
        <div class="traffic-yielding">
          <div class="traffic-label">Currently Yielding</div>
          ${yieldingRobots.map(r => `
            <div class="traffic-yield-entry">
              R${String(r.id).padStart(2, "0")} &rarr; yields=${r.consecutiveYields}
              ${r.waitingForRobotId ? ` waiting for R${String(r.waitingForRobotId).padStart(2, "0")}` : ""}
              ${r.carryingSlotId ? " [loaded]" : ""}
            </div>
          `).join("")}
        </div>
      ` : ""}
      ${recentEvents.length > 0 ? `
        <div class="traffic-log">
          <div class="traffic-label">Recent Events</div>
          ${recentEvents.map(e => `
            <div class="traffic-event traffic-event-${e.type}">
              <span class="traffic-tick">t${e.tick}</span>
              <span class="traffic-type">${e.type}</span>
              <span>R${String(e.robotId).padStart(2, "0")}${e.otherRobotId ? ` vs R${String(e.otherRobotId).padStart(2, "0")}` : ""}</span>
              <span class="traffic-reason">${e.reason}</span>
            </div>
          `).join("")}
        </div>
      ` : ""}
    `;
  }

  const kpiEl = container.querySelector("#debug-traffic-kpi");
  if (kpiEl) {
    const m = state.metrics;
    const topAisles = Object.entries(m.avgDelayPerAisle)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    kpiEl.innerHTML = `
      <div class="debug-grid">
        <span>Route efficiency</span><span class="debug-val">${(m.routeEfficiency * 100).toFixed(1)}%</span>
        <span>Total conflicts</span><span class="debug-val ${m.totalConflicts > 0 ? "debug-warn" : ""}">${m.totalConflicts}</span>
        <span>Yield events</span><span class="debug-val">${m.yieldEvents}</span>
        <span>Queue wait ticks</span><span class="debug-val">${m.totalQueueWaitTicks}</span>
        <span>Throughput loss</span><span class="debug-val">${(m.throughputLoss * 100).toFixed(1)}%</span>
        <span>Route reservations</span><span class="debug-val">${m.routeReservationCount}</span>
        <span>Dynamic reroutes</span><span class="debug-val">${m.dynamicReroutes}</span>
      </div>
      ${topAisles.length > 0 ? `
        <div class="traffic-label" style="margin-top:6px">Top Delay Aisles</div>
        ${topAisles.map(([aisle, delay]) => `
          <div class="debug-grid">
            <span>${aisle}</span><span class="debug-val">${delay.toFixed(1)}</span>
          </div>
        `).join("")}
      ` : ""}
    `;
  }

  const parkingEl = container.querySelector("#debug-parking");
  if (parkingEl) {
    const parkingBays = getParkingBays();
    const reassignments = getParkingReassignments();
    const freeBays = parkingBays.filter(b => b.state === "free").length;
    const reservedBays = parkingBays.filter(b => b.state === "reserved").length;
    const occupiedBays = parkingBays.filter(b => b.state === "occupied").length;
    const blockedBays = parkingBays.filter(b => b.state === "blocked").length;
    const strategy = state.scenario.simulation.parkingStrategy ?? "farthest-free";
    const recentReassignments = reassignments.slice(-5).reverse();

    const stuckRobots = robots.filter(r => r.blockedTicks >= 30 && r.state !== "idle" && r.state !== "charging");
    const nearestStationTag = (r: { position: { x: number; z: number } }) => {
      let best = "";
      let bestD = 14;
      for (const st of state.scenario.stations) {
        const d = Math.hypot(r.position.x - st.position.x, r.position.z - st.position.z);
        if (d < bestD) { bestD = d; best = ` near ${st.id} (${d.toFixed(1)}m)`; }
      }
      return best;
    };

    parkingEl.innerHTML = `
      <div class="debug-grid">
        <span>Strategy</span><span class="debug-val">${strategy}</span>
        <span>Total bays</span><span class="debug-val">${parkingBays.length}</span>
        <span>Free</span><span class="debug-val" style="color:#22cc55">${freeBays}</span>
        <span>Reserved</span><span class="debug-val" style="color:#ccaa22">${reservedBays}</span>
        <span>Occupied</span><span class="debug-val" style="color:#3388ff">${occupiedBays}</span>
        <span>Blocked</span><span class="debug-val ${blockedBays > 0 ? "debug-warn" : ""}">${blockedBays}</span>
      </div>
      ${stuckRobots.length > 0 ? `
        <div class="debug-stuck-alert">
          <div class="traffic-label">Stuck Robots (blocked 30+ ticks)</div>
          ${stuckRobots.map(r => `
            <div class="debug-stuck-row">
              R${String(r.id).padStart(2, "0")} - ${r.state} - blocked ${r.blockedTicks} ticks${nearestStationTag(r)}
              ${r.waitingForRobotId ? ` (waiting for R${String(r.waitingForRobotId).padStart(2, "0")})` : ""}
              ${r.collisionStateReason ? ` — ${r.collisionStateReason}` : ""}
            </div>
          `).join("")}
        </div>
      ` : ""}
      <div class="parking-bay-table">
        <div class="traffic-label" style="margin-top:6px">Bay Status Table</div>
        <div class="parking-bay-grid-header">
          <span>Bay</span><span>State</span><span>Robot</span><span>Position</span>
        </div>
        ${parkingBays.filter(b => b.state !== "free").slice(0, 16).map(b => `
          <div class="parking-bay-grid-row parking-bay-${b.state}">
            <span>${b.id}</span>
            <span class="parking-state-${b.state}">${b.state}</span>
            <span>${b.assignedRobotId ? "R" + String(b.assignedRobotId).padStart(2, "0") : "-"}</span>
            <span>${b.position.x.toFixed(1)},${b.position.z.toFixed(1)}</span>
          </div>
        `).join("")}
      </div>
      <div class="traffic-log" style="margin-top:6px">
        <div class="traffic-label">Robot Parking Assignments</div>
        ${robots.map(r => `
          <div class="traffic-event" style="font-size:11px">
            <span>R${String(r.id).padStart(2, "0")}</span>
            <span class="debug-state-${r.state}">${r.state}</span>
            <span>${r.assignedParkingBayId ?? "-"}</span>
            <span class="traffic-reason">${r.parkingReassignReason ?? ""}</span>
          </div>
        `).join("")}
      </div>
      ${recentReassignments.length > 0 ? `
        <div class="traffic-log" style="margin-top:6px">
          <div class="traffic-label">Recent Reassignments</div>
          ${recentReassignments.map(r => `
            <div class="traffic-event" style="font-size:11px">
              <span class="traffic-tick">t${r.tick}</span>
              <span>R${String(r.robotId).padStart(2, "0")}</span>
              <span>${r.fromBayId ?? "?"} &rarr; ${r.toBayId}</span>
              <span class="traffic-reason">${r.reason}</span>
            </div>
          `).join("")}
        </div>
      ` : ""}
    `;
  }

  const robotsEl = container.querySelector("#debug-robots");
  if (robotsEl) {
    robotsEl.innerHTML = `
      <div class="debug-robot-header">
        <span>ID</span><span>State</span><span>Pos</span><span>Path</span><span>Mission</span><span>Blk</span><span>Bat</span>
      </div>
      ${robots.map(r => `
        <div class="debug-robot-row ${r.blockedTicks > 0 ? "debug-blocked" : ""}">
          <span>R${String(r.id).padStart(2, "0")}</span>
          <span class="debug-state-${r.state}">${r.state}</span>
          <span>${r.position.x.toFixed(1)},${r.position.z.toFixed(1)}</span>
          <span>${r.path.length > 0 ? `${r.pathIndex}/${r.path.length}` : "-"}</span>
          <span>${r.missionId ?? "-"}</span>
          <span>${r.blockedTicks > 0 ? r.blockedTicks : "-"}</span>
          <span>${Math.round(r.batteryMinutes)}m</span>
        </div>
      `).join("")}
    `;
  }
}
