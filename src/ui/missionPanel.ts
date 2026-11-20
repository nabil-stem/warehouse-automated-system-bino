import { getState, setState, setStatus } from "../app/appState";
import { generateMissions, assignMissions, createManualMission, createMoveToPointMission, assignMissionToRobot, isSourceSlotReserved, resolveActiveMissionLimit } from "../domain/missionPlanner";
import { computeMetrics } from "../domain/metrics";
import { resetCollisionTracking } from "../domain/robotSimulation";
import type { Mission, Slot, RobotRuntime } from "../domain/schema";
import { getTraceForMission } from "../domain/traceRecorder";

let statusFilter = "all";
let levelFilter = "all";
let slotRowFilter = "all";
let slotLevelFilter = "all";
let slotSkuFilter = "all";
let dispatchMode = "slot";

export function renderMissionPanel(container: HTMLElement) {
  const state = getState();
  const s = state.scenario;
  const sim = s.simulation;
  const effectiveActiveLimit = resolveActiveMissionLimit(state.missions, state.robots, sim.maxActiveMissions, s);

  container.innerHTML = `
    <div class="panel-section">
      <h3>Simulation</h3>
      <label class="ctrl"><span>Mission count</span>
        <input type="number" data-field="missionCount" value="${sim.missionCount}" min="1" max="200" /></label>
      <label class="ctrl"><span>Time scale</span>
        <input type="range" data-field="timeScale" value="${sim.timeScale}" min="0.1" max="5" step="0.1" />
        <span class="range-val">${sim.timeScale.toFixed(1)}x</span></label>
      <div class="sim-controls">
        <button class="btn btn-primary" data-action="generate">Generate Missions</button>
        <button class="btn ${state.running ? "btn-danger" : "btn-success"}" data-action="toggle">${state.running ? "Pause" : "Start"}</button>
        <button class="btn" data-action="step">Step</button>
      </div>
    </div>
    <div class="panel-section">
      <h3>Routing & Assignment</h3>
      <label class="ctrl"><span>Routing</span>
        <select data-field="routing">
          <option value="direct" ${sim.routing === "direct" ? "selected" : ""}>Direct</option>
          <option value="a-star" ${sim.routing === "a-star" ? "selected" : ""}>A*</option>
          <option value="reservation-table" ${sim.routing === "reservation-table" ? "selected" : ""}>Reservation Table</option>
        </select></label>
      <label class="ctrl"><span>Allocator</span>
        <select data-field="allocator">
          <option value="round-robin" ${sim.allocator === "round-robin" ? "selected" : ""}>Round Robin</option>
          <option value="nearest-robot" ${sim.allocator === "nearest-robot" ? "selected" : ""}>Nearest Robot</option>
          <option value="least-busy" ${sim.allocator === "least-busy" ? "selected" : ""}>Least Busy</option>
          <option value="eta-optimal" ${sim.allocator === "eta-optimal" ? "selected" : ""}>ETA Optimal</option>
        </select></label>
      <label class="ctrl"><span>Collision avoidance</span>
        <input type="checkbox" data-field="collision" ${sim.collisionAvoidance ? "checked" : ""} /></label>
      <label class="ctrl"><span>Show routes</span>
        <input type="checkbox" data-field="showRoutes" ${sim.showRoutes ? "checked" : ""} /></label>
      <label class="ctrl"><span>Show heatmap</span>
        <input type="checkbox" data-field="showHeatmap" ${sim.showHeatmap ? "checked" : ""} /></label>
      <label class="ctrl"><span>Max active missions</span>
        <input type="number" data-field="maxActiveMissions" value="${sim.maxActiveMissions}" min="1" max="50" step="1" /></label>
      <label class="ctrl"><span>Auto-ramp active missions</span>
        <input type="checkbox" data-field="autoScaleActiveMissions" ${sim.autoScaleActiveMissions ? "checked" : ""} /></label>
      <div class="model-status">Effective active mission limit: ${effectiveActiveLimit}/${state.robots.length}</div>
      <label class="ctrl"><span>Robot clearance (m)</span>
        <input type="number" data-field="robotClearance" value="${sim.robotClearanceMeters}" min="0" max="2" step="0.05" /></label>
      <label class="ctrl"><span>Parking strategy</span>
        <select data-field="parkingStrategy">
          <option value="home-slots" ${sim.parkingStrategy === "home-slots" ? "selected" : ""}>Home Slots</option>
          <option value="farthest-free" ${sim.parkingStrategy === "farthest-free" ? "selected" : ""}>Farthest Free</option>
          <option value="nearest-free" ${sim.parkingStrategy === "nearest-free" ? "selected" : ""}>Nearest Free</option>
          <option value="least-congested" ${sim.parkingStrategy === "least-congested" ? "selected" : ""}>Least Congested</option>
          <option value="balanced-sides" ${sim.parkingStrategy === "balanced-sides" ? "selected" : ""}>Balanced Sides</option>
        </select></label>
    </div>
    <div class="panel-section">
      <h3>Manual Dispatch</h3>
      ${renderDispatchSection(state)}
    </div>
    <div class="panel-section">
      <h3>Missions (${state.missions.length})</h3>
      <div class="mission-filters">
        <select data-field="statusFilter">
          <option value="all" ${statusFilter === "all" ? "selected" : ""}>All status</option>
          <option value="queued" ${statusFilter === "queued" ? "selected" : ""}>Queued</option>
          <option value="assigned" ${statusFilter === "assigned" ? "selected" : ""}>Assigned</option>
          <option value="moving" ${statusFilter === "moving" ? "selected" : ""}>Moving</option>
          <option value="picking" ${statusFilter === "picking" ? "selected" : ""}>Picking</option>
          <option value="placing" ${statusFilter === "placing" ? "selected" : ""}>Placing</option>
          <option value="done" ${statusFilter === "done" ? "selected" : ""}>Done</option>
          <option value="failed" ${statusFilter === "failed" ? "selected" : ""}>Failed</option>
        </select>
        <select data-field="levelFilter">
          <option value="all" ${levelFilter === "all" ? "selected" : ""}>All levels</option>
          ${Array.from({ length: s.racks.levels }, (_, i) => `
            <option value="${i}" ${levelFilter === String(i) ? "selected" : ""}>Level ${i + 1}</option>
          `).join("")}
        </select>
      </div>
      <div class="mission-table-v2" id="mission-table">
        ${renderMissionTableContent(state.missions, state.robots, state.slots)}
      </div>
      <button class="btn btn-sm" data-action="clear-done">Clear Completed</button>
    </div>
  `;

  container.onchange = (e) => {
    const target = e.target as HTMLInputElement | HTMLSelectElement;
    const f = target.dataset.field;
    if (!f) return;
    if (f === "missionCount") sim.missionCount = parseInt(target.value) || 10;
    else if (f === "timeScale") {
      sim.timeScale = parseFloat(target.value);
      const rv = target.parentElement?.querySelector(".range-val");
      if (rv) rv.textContent = sim.timeScale.toFixed(1) + "x";
    }
    else if (f === "routing") sim.routing = target.value as any;
    else if (f === "allocator") sim.allocator = target.value as any;
    else if (f === "collision") sim.collisionAvoidance = (target as HTMLInputElement).checked;
    else if (f === "showRoutes") sim.showRoutes = (target as HTMLInputElement).checked;
    else if (f === "showHeatmap") sim.showHeatmap = (target as HTMLInputElement).checked;
    else if (f === "maxActiveMissions") sim.maxActiveMissions = Math.max(1, parseInt(target.value) || 1);
    else if (f === "autoScaleActiveMissions") sim.autoScaleActiveMissions = (target as HTMLInputElement).checked;
    else if (f === "robotClearance") sim.robotClearanceMeters = Math.max(0, parseFloat(target.value) || 0);
    else if (f === "parkingStrategy") sim.parkingStrategy = target.value as any;
    else if (f === "statusFilter") { statusFilter = target.value; renderMissionPanel(container); }
    else if (f === "levelFilter") { levelFilter = target.value; renderMissionPanel(container); }
    else if (f === "slotRow") { slotRowFilter = target.value; renderMissionPanel(container); }
    else if (f === "slotLevel") { slotLevelFilter = target.value; renderMissionPanel(container); }
    else if (f === "slotSku") { slotSkuFilter = target.value; renderMissionPanel(container); }
    else if (f === "dispatchMode") { dispatchMode = target.value; renderMissionPanel(container); }
  };

  container.oninput = (e) => {
    const target = e.target as HTMLInputElement;
    if (target.dataset.field === "timeScale") {
      sim.timeScale = parseFloat(target.value);
      const rv = target.parentElement?.querySelector(".range-val");
      if (rv) rv.textContent = sim.timeScale.toFixed(1) + "x";
    }
  };

  container.onclick = (e) => {
    const btn = (e.target as HTMLElement).closest("[data-action]") as HTMLElement;
    if (!btn) return;
    if (btn.dataset.action === "generate") {
      if (state.missions.length === 0 || state.missions.every(m => m.status === "done" || m.status === "failed")) {
        resetCollisionTracking();
        state.congestionMap.clear();
      }
      const newMissions = generateMissions(state.scenario, state.slots, sim.missionCount, state.tick, state.missions);
      state.missions.push(...newMissions);
      assignMissions(
        state.missions, state.robots, state.navGraph, state.slots,
        sim.allocator, state.scenario.stations, sim.maxActiveMissions,
        state.scenario, state.congestionMap, state.tick
      );
      refreshMetrics(state);
      setStatus(`Generated ${newMissions.length} missions`);
      renderMissionPanel(container);
    }
    if (btn.dataset.action === "toggle") {
      setState({ running: !state.running });
      setStatus(state.running ? "Simulation running" : "Simulation paused");
      renderMissionPanel(container);
    }
    if (btn.dataset.action === "step") {
      setState({ running: false });
      (window as any).__simStep = true;
      setStatus("Stepped 1 tick");
    }
    if (btn.dataset.action === "clear-done") {
      state.missions = state.missions.filter(m => m.status !== "done" && m.status !== "failed");
      refreshMetrics(state);
      setStatus("Cleared completed missions");
      renderMissionPanel(container);
    }
    if (btn.dataset.action === "dispatch-manual" || btn.dataset.action === "dispatch-and-run") {
      dispatchManual(container, btn.dataset.action === "dispatch-and-run");
    }
    if (btn.dataset.action === "dispatch-highest") {
      dispatchHighestShelf(container);
    }
    if (btn.dataset.action === "replay-trace") {
      const missionId = btn.dataset.mission;
      if (missionId) {
        const trace = getTraceForMission(missionId);
        if (trace) {
          (window as any).__replayTrace = trace;
          (window as any).__replayTraceIdx = 0;
          setState({ running: false });
          setStatus(`Replaying trace for ${missionId} (${trace.entries.length} ticks)`);
        }
      }
    }
  };
}

function renderDispatchSection(state: ReturnType<typeof getState>): string {
  const s = state.scenario;
  const idleRobots = state.robots.filter(r => r.state === "idle" || r.state === "returning");
  const targetStations = s.stations
    .filter(st => st.type === "packing" || st.type === "inbound" || st.type === "buffer")
    .sort((a, b) => stationPriority(a.type) - stationPriority(b.type));

  const rows = new Set(state.slots.map(s => s.rowIndex));
  const skus = new Set(state.slots.filter(s => s.sku).map(s => s.sku!));
  const filteredSlots = getFilteredSlots(state.slots, state.missions);

  return `
    <label class="ctrl"><span>Mission type</span>
      <select data-field="dispatchMode">
        <option value="slot" ${dispatchMode === "slot" ? "selected" : ""}>Pick box slot</option>
        <option value="point" ${dispatchMode === "point" ? "selected" : ""}>Go to position</option>
      </select></label>
    <div class="dispatch-filters ${dispatchMode === "point" ? "is-dimmed" : ""}">
      <select data-field="slotRow" ${dispatchMode === "point" ? "disabled" : ""}>
        <option value="all" ${slotRowFilter === "all" ? "selected" : ""}>All rows</option>
        ${[...rows].sort((a, b) => a - b).map(r => `
          <option value="${r}" ${slotRowFilter === String(r) ? "selected" : ""}>Row ${r}</option>
        `).join("")}
      </select>
      <select data-field="slotLevel" ${dispatchMode === "point" ? "disabled" : ""}>
        <option value="all" ${slotLevelFilter === "all" ? "selected" : ""}>All levels</option>
        ${Array.from({ length: s.racks.levels }, (_, i) => `
          <option value="${i}" ${slotLevelFilter === String(i) ? "selected" : ""}>L${i + 1}</option>
        `).join("")}
      </select>
      <select data-field="slotSku" ${dispatchMode === "point" ? "disabled" : ""}>
        <option value="all" ${slotSkuFilter === "all" ? "selected" : ""}>All SKU</option>
        ${[...skus].sort().slice(0, 50).map(sku => `
          <option value="${sku}" ${slotSkuFilter === sku ? "selected" : ""}>${sku}</option>
        `).join("")}
      </select>
    </div>
    <div class="dispatch-slot-count ${dispatchMode === "point" ? "is-dimmed" : ""}">${filteredSlots.length} slots shown (${filteredSlots.filter(s => !s._reserved).length} available)</div>
    <label class="ctrl"><span>Robot</span>
      <select data-field="manualRobot">
        ${state.robots.map(robot => `
          <option value="${robot.id}" ${robot.id === (idleRobots[0]?.id ?? state.robots[0]?.id) ? "selected" : ""}>
            R${String(robot.id).padStart(2, "0")} - ${robot.state}
          </option>
        `).join("")}
      </select></label>
    <label class="ctrl"><span>Source slot</span>
      <select data-field="manualSlot">
        ${filteredSlots.slice(0, 300).map(slot => `
          <option value="${slot.id}" ${slot._reserved ? "disabled" : ""}>
            ${slot._reserved ? "[reserved " + slot._reservedBy + "] " : ""}L${slot.levelIndex + 1} R${slot.rowIndex} B${slot.bayIndex} - ${slot.sku ?? "SKU"}
          </option>
        `).join("")}
      </select></label>
    <div class="position-dispatch ${dispatchMode === "point" ? "" : "is-hidden"}">
      <label class="ctrl"><span>Target X</span>
        <input type="number" data-field="targetX" value="0" step="0.5" /></label>
      <label class="ctrl"><span>Target Z</span>
        <input type="number" data-field="targetZ" value="0" step="0.5" /></label>
    </div>
    <label class="ctrl"><span>Target</span>
      <select data-field="manualStation">
        ${targetStations.map(station => `<option value="${station.id}">${station.label}</option>`).join("")}
      </select></label>
    <div class="sim-controls">
      <button class="btn btn-primary" data-action="dispatch-manual">Send Robot</button>
      <button class="btn btn-success" data-action="dispatch-and-run">Send & Run</button>
      <button class="btn btn-warning" data-action="dispatch-highest">Dispatch Highest Shelf</button>
    </div>
    <div class="model-status">Pick a robot and slot to watch path choice, pick height, scissor opening, and drop-off.</div>
  `;
}

type FilteredSlot = Slot & { _reserved: boolean; _reservedBy?: string };

function getFilteredSlots(slots: Slot[], missions: Mission[]): FilteredSlot[] {
  let filtered = slots.filter(s => s.occupied);

  if (slotRowFilter !== "all") {
    filtered = filtered.filter(s => s.rowIndex === parseInt(slotRowFilter));
  }
  if (slotLevelFilter !== "all") {
    filtered = filtered.filter(s => s.levelIndex === parseInt(slotLevelFilter));
  }
  if (slotSkuFilter !== "all") {
    filtered = filtered.filter(s => s.sku === slotSkuFilter);
  }

  const result: FilteredSlot[] = filtered.map(s => {
    const reservingMission = missions.find(m =>
      m.sourceSlotId === s.id &&
      (m.status === "queued" || m.status === "assigned" || m.status === "moving" || m.status === "picking" || m.status === "placing")
    );
    return {
      ...s,
      _reserved: !!reservingMission,
      _reservedBy: reservingMission?.id,
    };
  });

  result.sort((a, b) => {
    if (a._reserved !== b._reserved) return a._reserved ? 1 : -1;
    return b.levelIndex - a.levelIndex || a.rowIndex - b.rowIndex || a.bayIndex - b.bayIndex;
  });

  return result;
}

function dispatchManual(container: HTMLElement, andRun: boolean) {
  const state = getState();
  const robotId = parseInt((container.querySelector('[data-field="manualRobot"]') as HTMLSelectElement)?.value ?? "0");
  const slotId = (container.querySelector('[data-field="manualSlot"]') as HTMLSelectElement)?.value;
  const stationId = (container.querySelector('[data-field="manualStation"]') as HTMLSelectElement)?.value;
  const robot = state.robots.find(r => r.id === robotId);
  const slot = state.slots.find(s => s.id === slotId);
  if (!robot || !stationId) {
    setStatus("Manual dispatch needs robot and target");
    return;
  }

  if (dispatchMode === "point") {
    const x = parseFloat((container.querySelector('[data-field="targetX"]') as HTMLInputElement)?.value ?? "0");
    const z = parseFloat((container.querySelector('[data-field="targetZ"]') as HTMLInputElement)?.value ?? "0");
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      setStatus("Position dispatch needs valid X/Z coordinates");
      return;
    }
    const halfW = state.scenario.warehouse.width / 2;
    const halfD = state.scenario.warehouse.depth / 2;
    if (x < -halfW || x > halfW || z < -halfD || z > halfD) {
      setStatus(`Target position must stay inside warehouse bounds (${(-halfW).toFixed(1)}..${halfW.toFixed(1)}, ${(-halfD).toFixed(1)}..${halfD.toFixed(1)})`);
      return;
    }

    const mission = createMoveToPointMission({ x, z }, state.tick);
    const assigned = assignMissionToRobot(mission, robot, state.slots, state.missions, state.scenario, state.tick);
    if (!assigned.ok) {
      setStatus(assigned.reason);
      return;
    }
    state.missions.unshift(mission);
    refreshMetrics(state);
    if (andRun) {
      setState({ running: true });
      setStatus(`Sent R${String(robot.id).padStart(2, "0")} to X ${x.toFixed(1)}, Z ${z.toFixed(1)}`);
    } else {
      setStatus(`Queued R${String(robot.id).padStart(2, "0")} to X ${x.toFixed(1)}, Z ${z.toFixed(1)}`);
    }
    renderMissionPanel(container);
    return;
  }

  if (!slot) {
    setStatus("Manual dispatch needs a source slot");
    return;
  }

  if (isSourceSlotReserved(state.missions, slot.id)) {
    setStatus(`Slot ${slot.id} is already reserved by an active mission`);
    return;
  }

  const mission = createManualMission(slot, stationId, state.tick);
  const assigned = assignMissionToRobot(mission, robot, state.slots, state.missions, state.scenario, state.tick);
  if (!assigned.ok) {
    setStatus(assigned.reason);
    return;
  }
  state.missions.unshift(mission);

  if (slot.levelIndex >= 2) {
    mission.statusNote = `High shelf L${slot.levelIndex + 1} - scissor lift required`;
  }

  refreshMetrics(state);
  if (andRun) {
    setState({ running: true });
    setStatus(`Sent R${String(robot.id).padStart(2, "0")} to ${slot.id} (L${slot.levelIndex + 1}) and started simulation`);
  } else {
    setStatus(`Sent R${String(robot.id).padStart(2, "0")} to ${slot.id} (L${slot.levelIndex + 1})`);
  }
  renderMissionPanel(container);
}

function dispatchHighestShelf(container: HTMLElement) {
  const state = getState();
  const maxLevel = state.scenario.racks.levels - 1;
  const highSlots = state.slots
    .filter(s => s.occupied && s.levelIndex === maxLevel && !isSourceSlotReserved(state.missions, s.id));

  if (highSlots.length === 0) {
    setStatus(`No available occupied slots at level ${maxLevel + 1}`);
    return;
  }

  const idleRobot = state.robots.find(r => (r.state === "idle" || r.state === "returning") && r.batteryMinutes > 5);
  if (!idleRobot) {
    setStatus("No available robot for highest-shelf dispatch");
    return;
  }

  const packingStations = state.scenario.stations.filter(s => s.type === "packing" || s.type === "inbound");
  if (packingStations.length === 0) {
    setStatus("No target station available");
    return;
  }

  const slot = highSlots[0];
  const station = packingStations[0];
  const mission = createManualMission(slot, station.id, state.tick);
  const assigned = assignMissionToRobot(mission, idleRobot, state.slots, state.missions, state.scenario, state.tick);
  if (!assigned.ok) {
    setStatus(assigned.reason);
    return;
  }
  state.missions.unshift(mission);
  mission.statusNote = `High shelf L${slot.levelIndex + 1} - scissor lift required`;
  refreshMetrics(state);
  setState({ running: true });
  setStatus(`Dispatched R${String(idleRobot.id).padStart(2, "0")} to highest shelf ${slot.id} (L${slot.levelIndex + 1})`);
  renderMissionPanel(container);
}

function renderMissionTableContent(missions: Mission[], robots: RobotRuntime[], slots: Slot[]): string {
  let filtered = missions;
  if (statusFilter !== "all") {
    filtered = filtered.filter(m => m.status === statusFilter);
  }
  if (levelFilter !== "all") {
    const lvl = parseInt(levelFilter);
    filtered = filtered.filter(m => {
      const slot = slots.find(s => s.id === m.sourceSlotId);
      return slot && slot.levelIndex === lvl;
    });
  }

  const shown = filtered.slice(0, 30);

  return `
    <div class="mission-header-v2">
      <span>ID</span><span>Robot</span><span>Phase</span><span>Source</span><span>Target</span><span>Info</span>
    </div>
    ${shown.map(m => {
      const robot = robots.find(r => r.missionId === m.id);
      const slot = slots.find(s => s.id === m.sourceSlotId);
      const phase = getMissionPhase(m, robot);
      const hasTrace = !!getTraceForMission(m.id);
      const progress = getMissionProgress(m, robot);
      const liftPct = robot?.liftTelemetry.currentExtensionPct ?? 0;
      const showLift = robot && (robot.state === "picking" || robot.state === "placing") && liftPct > 0;
      return `
        <div class="mission-row-v2 ${m.status}">
          <span class="mission-id">${m.id}${hasTrace ? ` <button class="btn-trace" data-action="replay-trace" data-mission="${m.id}" title="Replay trace">&#9654;</button>` : ""}</span>
          <span>${m.assignedRobotId != null ? "R" + String(m.assignedRobotId).padStart(2, "0") : "-"}</span>
          <span class="phase-badge ${phaseClass(phase)}">${phase}</span>
          <span class="mission-source">${m.type === "move-to-point" ? "manual point" : slot ? `R${slot.rowIndex}/B${slot.bayIndex}/L${slot.levelIndex + 1}` : m.sourceSlotId}</span>
          <span>${m.type === "move-to-point" && m.targetPosition ? `${m.targetPosition.x.toFixed(1)},${m.targetPosition.z.toFixed(1)}` : m.targetStationId}</span>
          <span class="mission-info">${missionInfoText(m)}${showLift ? ` [lift ${liftPct.toFixed(0)}%]` : ""}</span>
        </div>
        ${m.status !== "done" && m.status !== "failed" ? renderMissionStepper(progress) : ""}
      `;
    }).join("")}
    ${filtered.length > 30 ? `<div class="mission-more">...and ${filtered.length - 30} more</div>` : ""}
  `;
}

function getMissionProgress(m: Mission, robot?: RobotRuntime): number {
  if (m.status === "done") return 100;
  if (m.status === "failed") return 0;
  if (m.status === "queued") return 5;
  if (!robot) return 10;
  if (robot.state === "to-pick" || robot.state === "to-point") return 25;
  if (robot.state === "picking") return 50;
  if (robot.state === "to-drop") return 70;
  if (robot.state === "placing") return 85;
  if (robot.state === "returning") return 95;
  return 15;
}

function renderMissionStepper(progress: number): string {
  return `<div class="mission-stepper"><div class="mission-stepper-fill" style="width:${progress}%"></div></div>`;
}

function getMissionPhase(m: Mission, robot?: RobotRuntime): string {
  if (m.status === "done") return m.type === "move-to-point" ? "arrived" : "done";
  if (m.status === "failed") return m.failReason ?? "failed";
  if (m.status === "queued") {
    if (m.statusNote?.includes("reserved")) return "slot reserved";
    return "queued";
  }
  if (!robot) {
    if (m.status === "assigned") return "assigned";
    return m.status;
  }
  if (robot.state === "to-pick") {
    if (robot.blockedTicks > 0) return "wait clearance";
    return "drive to pick";
  }
  if (robot.state === "to-point") return robot.blockedTicks > 0 ? "wait clearance" : "drive to point";
  if (robot.state === "yielding") return "yielding";
  if (robot.state === "returning") return robot.blockedTicks > 0 ? "wait return clearance" : "return standby";
  if (robot.state === "picking") {
    if (m.statusNote?.includes("Scissor lift extending")) return "lift extending";
    if (m.statusNote?.includes("Lowering")) return "lowering";
    return "picking";
  }
  if (robot.state === "to-drop") {
    if (robot.blockedTicks > 0) return "wait clearance";
    return "drive to drop";
  }
  if (robot.state === "placing") return "placing";
  return m.status;
}

function phaseClass(phase: string): string {
  if (phase === "queued" || phase === "slot reserved") return "phase-queued";
  if (phase === "assigned") return "phase-assigned";
  if (phase === "drive to pick" || phase === "drive to drop" || phase === "drive to point") return "phase-moving";
  if (phase === "wait clearance" || phase === "yielding") return "phase-wait";
  if (phase === "lift extending" || phase === "lowering") return "phase-lift";
  if (phase === "picking" || phase === "placing") return "phase-action";
  if (phase === "done" || phase === "arrived") return "phase-done";
  return "phase-failed";
}

function missionInfoText(m: Mission): string {
  const parts: string[] = [];
  if (m.estimatedDistance !== undefined) parts.push(`${m.estimatedDistance.toFixed(1)}m`);
  if (m.distanceMeters > 0) parts.push(`${m.distanceMeters.toFixed(1)}m real`);
  if (m.waitTicks > 0) parts.push(`wait ${m.waitTicks}`);
  if (m.failReason) parts.push(m.failReason);
  else if (m.statusNote) parts.push(m.statusNote);
  return parts.join(" / ") || "-";
}

function refreshMetrics(state: ReturnType<typeof getState>) {
  state.metrics = computeMetrics(
    state.robots, state.missions, state.slots,
    state.congestionMap, state.tick,
    state.scenario.simulation.tickMs,
    state.metrics.throughputHistory,
    state.scenario.stations
  );
}

function stationPriority(type: string): number {
  if (type === "inbound") return 0;
  if (type === "buffer") return 1;
  return 2;
}

export function updateMissionTable(container: HTMLElement) {
  const state = getState();
  const table = container.querySelector("#mission-table");
  if (!table) return;
  table.innerHTML = renderMissionTableContent(state.missions, state.robots, state.slots);
}
