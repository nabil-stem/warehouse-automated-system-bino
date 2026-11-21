import type { Mission, RobotRuntime, Slot, WarehouseScenario, NavGraph, Vec2 } from "./schema";
import { findNearestNodeId, aStar } from "./navigationGraph";
import { getStationQueues } from "./robotSimulation";

let missionCounter = 0;

export function resetMissionCounter() {
  missionCounter = 0;
}

function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export function generateMissions(
  scenario: WarehouseScenario,
  slots: Slot[],
  count: number,
  tick: number,
  existingMissions: Mission[] = []
): Mission[] {
  const rand = seededRandom(scenario.seed + tick + missionCounter);
  const occupiedSlots = slots.filter(s => s.occupied);
  if (occupiedSlots.length === 0) return [];

  const packingStations = scenario.stations.filter(s => s.type === "packing" || s.type === "inbound");
  if (packingStations.length === 0) return [];

  const missions: Mission[] = [];
  const reservedSources = new Set(
    existingMissions
      .filter(mission => isMissionSourceReservationActive(mission))
      .map(mission => mission.sourceSlotId)
  );

  // Load-balance target stations so no single station (e.g. Pack A) gets swamped, which
  // is the main cause of approach congestion. Seed the load with any still-active missions.
  const stationLoad = new Map<string, number>();
  for (const st of packingStations) stationLoad.set(st.id, 0);
  for (const m of existingMissions) {
    if (m.status !== "done" && m.status !== "failed" && stationLoad.has(m.targetStationId)) {
      stationLoad.set(m.targetStationId, (stationLoad.get(m.targetStationId) ?? 0) + 1);
    }
  }

  // Soft balance: prefer the nearest station but add a penalty for each mission already
  // queued there, so a station only gets overloaded if it is much closer than the rest.
  // This prevents the Pack-A pile-up without forcing a rigid spread on tiny batches.
  const LOAD_PENALTY_METERS = 9;
  const pickBalancedStation = (slot: Slot) => {
    let best = packingStations[0];
    let bestScore = Infinity;
    for (const st of packingStations) {
      const dist = Math.hypot(slot.position.x - st.position.x, slot.position.z - st.position.z);
      const score = dist + (stationLoad.get(st.id) ?? 0) * LOAD_PENALTY_METERS;
      if (score < bestScore) { bestScore = score; best = st; }
    }
    stationLoad.set(best.id, (stationLoad.get(best.id) ?? 0) + 1);
    return best;
  };

  for (let i = 0; i < count; i++) {
    const candidates = occupiedSlots.filter(slot => !reservedSources.has(slot.id));
    if (candidates.length === 0) break;

    missionCounter++;
    const slot = candidates[Math.floor(rand() * candidates.length)];
    reservedSources.add(slot.id);
    const station = pickBalancedStation(slot);
    const estDist = Math.hypot(slot.position.x - station.position.x, slot.position.z - station.position.z);
    const estTime = estDist / scenario.robots.speedMetersPerSecond;
    missions.push({
      id: `M-${String(missionCounter).padStart(4, "0")}`,
      sku: slot.sku ?? "UNKNOWN",
      sourceSlotId: slot.id,
      targetStationId: station.id,
      type: "pick-and-drop",
      status: "queued",
      createdAtTick: tick,
      distanceMeters: 0,
      waitTicks: 0,
      estimatedDistance: Math.round(estDist * 10) / 10,
      estimatedTime: Math.round(estTime * 10) / 10,
    });
  }
  return missions;
}

export function createManualMission(
  slot: Slot,
  targetStationId: string,
  tick: number
): Mission {
  missionCounter++;
  return {
    id: `M-${String(missionCounter).padStart(4, "0")}`,
    sku: slot.sku ?? "UNKNOWN",
    sourceSlotId: slot.id,
    targetStationId,
    type: "pick-and-drop",
    status: "queued",
    createdAtTick: tick,
    distanceMeters: 0,
    waitTicks: 0,
  };
}

export function createMoveToPointMission(
  target: Vec2,
  tick: number
): Mission {
  missionCounter++;
  return {
    id: `M-${String(missionCounter).padStart(4, "0")}`,
    sku: "MOVE",
    sourceSlotId: "__POINT__",
    targetStationId: "POINT",
    targetPosition: target,
    type: "move-to-point",
    status: "queued",
    createdAtTick: tick,
    distanceMeters: 0,
    waitTicks: 0,
    statusNote: `Move to X ${target.x.toFixed(1)}, Z ${target.z.toFixed(1)}`,
  };
}

/**
 * Refresh a mission's estimate at assignment time, from the assigned robot's actual
 * start position: Manhattan travel (robot -> source -> station) plus pick/place service
 * time. Stored so the post-run analysis can compare estimate vs reality per mission.
 */
export function applyMissionEstimate(
  mission: Mission,
  robot: RobotRuntime,
  slots: Slot[],
  scenario?: WarehouseScenario,
  stations?: WarehouseScenario["stations"],
  tick?: number
) {
  mission.assignedAtTick = tick ?? mission.assignedAtTick ?? mission.createdAtTick;
  if (!scenario) return;
  const manhattan = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z);
  const speed = Math.max(0.1, scenario.robots.speedMetersPerSecond);
  const tickSec = scenario.simulation.tickMs / 1000;

  let travel = 0;
  let serviceTicks = 0;
  if (mission.type === "move-to-point" && mission.targetPosition) {
    travel = manhattan(robot.position, mission.targetPosition);
  } else {
    const slot = slots.find(s => s.id === mission.sourceSlotId);
    if (!slot) return;
    const slotPos = { x: slot.position.x, z: slot.position.z };
    travel = manhattan(robot.position, slotPos);
    const station = (stations ?? scenario.stations).find(s => s.id === mission.targetStationId);
    const stationLeg = station ? manhattan(slotPos, station.position) : 0;
    travel += stationLeg;
    const pickPlacePerLevel = scenario.simulation.pickPlaceTimePerLevel ?? 3;
    const liftCycleTicks = 60 + (slot.levelIndex ?? 0) * pickPlacePerLevel;
    serviceTicks = liftCycleTicks + 15;
    if (scenario.simulation.returnBoxesToShelf) {
      // Round-trip: operator processing at the station, then carry the box back and
      // run a second lift cycle to put it on the shelf.
      travel += stationLeg;
      serviceTicks += Math.max(20, scenario.simulation.operatorProcessTicks ?? 120) + liftCycleTicks;
    }
  }

  mission.estimatedDistance = Math.round(travel * 10) / 10;
  mission.estimatedTime = Math.round((travel / speed + serviceTicks * tickSec) * 10) / 10;
}

export function assignMissionToRobot(
  mission: Mission,
  robot: RobotRuntime,
  slots: Slot[],
  activeMissions: Mission[] = [],
  scenario?: WarehouseScenario,
  tick?: number
): { ok: true } | { ok: false; reason: string } {
  if (!isRobotAssignable(robot)) return { ok: false, reason: `Robot ${robot.id} is not available` };
  if (robot.batteryMinutes <= assignmentBatteryFloor(scenario)) return { ok: false, reason: `Robot ${robot.id} battery is too low` };
  if (mission.type !== "move-to-point" && isSourceSlotReserved(activeMissions, mission.sourceSlotId, mission.id)) {
    mission.statusNote = "Source slot reserved by another active mission";
    return { ok: false, reason: `Source slot ${mission.sourceSlotId} is already reserved` };
  }

  const slot = slots.find(s => s.id === mission.sourceSlotId);
  if (mission.type !== "move-to-point") {
    if (!slot) return { ok: false, reason: "Source slot not found" };
    if (!slot.occupied) return { ok: false, reason: "Source slot is empty" };
  }

  mission.assignedRobotId = robot.id;
  mission.status = "assigned";
  robot.missionId = mission.id;
  robot.state = mission.type === "move-to-point" ? "to-point" : "to-pick";
  robot.path = [];
  robot.pathIndex = 0;
  robot.waitTicks = 0;
  robot.blockedTicks = 0;
  robot.usingTemporaryBay = undefined; // next return goes to the real home slot
  applyMissionEstimate(mission, robot, slots, scenario, scenario?.stations, tick);
  return { ok: true };
}

export function assignMissions(
  missions: Mission[],
  robots: RobotRuntime[],
  graph: NavGraph,
  slots: Slot[],
  mode: "round-robin" | "nearest-robot" | "least-busy" | "eta-optimal",
  stations?: WarehouseScenario["stations"],
  maxActiveMissions = Infinity,
  scenario?: WarehouseScenario,
  congestionMap?: Map<string, number>,
  tick?: number
) {
  const queued = missions.filter(m => m.status === "queued");
  const assignable = robots.filter(r => isRobotAssignable(r) && r.batteryMinutes > assignmentBatteryFloor(scenario));
  if (queued.length === 0 || assignable.length === 0) return;
  const activeMissionLimit = resolveActiveMissionLimit(missions, robots, maxActiveMissions, scenario);

  let activeMissionCount = missions.filter(
    m => m.status === "assigned" || m.status === "moving" || m.status === "picking" || m.status === "placing"
  ).length;

  // Missions in flight per target station. Every active phase counts (the old filter
  // skipped "picking", so the cap leaked), except round-trip return legs, which have
  // already left the station.
  const stationLoad = new Map<string, number>();
  if (stations) {
    for (const station of stations) {
      const current = missions.filter(
        m => m.targetStationId === station.id && !m.returnLeg &&
        (m.status === "assigned" || m.status === "moving" || m.status === "picking" || m.status === "placing")
      ).length;
      stationLoad.set(station.id, current);
    }
  }

  for (const mission of queued) {
    if (assignable.length === 0) break;
    if (activeMissionCount >= activeMissionLimit) break;
    if (mission.type !== "move-to-point" && isSourceSlotInFlight(missions, mission.sourceSlotId, mission.id)) {
      mission.statusNote = "Source slot reserved by another active mission";
      continue;
    }

    if (stations) {
      const station = stations.find(s => s.id === mission.targetStationId);
      if (station) {
        // One robot at the dock plus a full queue behind it.
        const currentLoad = stationLoad.get(station.id) ?? 0;
        if (currentLoad >= station.queueCapacity + 1) {
          continue;
        }
      }
    }

    const slot = slots.find(s => s.id === mission.sourceSlotId);
    if (mission.type === "move-to-point") {
      const robot = selectRobotForMission(assignable, mode, graph, mission.targetPosition ?? { x: 0, z: 0 }, undefined, scenario, congestionMap);
      if (robot) {
        mission.assignedRobotId = robot.id;
        mission.status = "assigned";
        mission.statusNote = "Driving to selected position";
        robot.missionId = mission.id;
        robot.state = "to-point";
        robot.path = [];
        robot.pathIndex = 0;
        robot.waitTicks = 0;
        robot.blockedTicks = 0;
        robot.usingTemporaryBay = undefined;
        applyMissionEstimate(mission, robot, slots, scenario, stations, tick);
        activeMissionCount++;
      }
      continue;
    }

    if (!slot) {
      mission.status = "failed";
      mission.failReason = "Source slot not found";
      continue;
    }

    if (!slot.occupied) {
      mission.status = "failed";
      mission.failReason = "Source slot empty";
      continue;
    }

    const robot = selectRobotForMission(assignable, mode, graph, { x: slot.position.x, z: slot.position.z }, mission, scenario, congestionMap);

    if (robot) {
      mission.assignedRobotId = robot.id;
      mission.status = "assigned";
      mission.statusNote = undefined;
      robot.missionId = mission.id;
      robot.state = "to-pick";
      robot.path = [];
      robot.pathIndex = 0;
      robot.waitTicks = 0;
      robot.blockedTicks = 0;
      robot.usingTemporaryBay = undefined;
      applyMissionEstimate(mission, robot, slots, scenario, stations, tick);
      activeMissionCount++;

      if (stations) {
        const currentLoad = stationLoad.get(mission.targetStationId) ?? 0;
        stationLoad.set(mission.targetStationId, currentLoad + 1);
      }
    }
  }
}

export function resolveActiveMissionLimit(
  missions: Mission[],
  robots: RobotRuntime[],
  configuredLimit: number,
  scenario?: WarehouseScenario
): number {
  const safeConfiguredLimit = Math.max(1, Math.floor(configuredLimit || 1));
  if (!scenario?.simulation.autoScaleActiveMissions) return safeConfiguredLimit;

  const queuedCount = missions.filter(m => m.status === "queued").length;
  if (queuedCount <= safeConfiguredLimit) return safeConfiguredLimit;

  const packingCapacity = scenario.stations
    .filter(station => station.type === "packing" || station.type === "inbound")
    .reduce((sum, station) => sum + Math.max(1, station.queueCapacity), 0);
  const robotCeiling = Math.max(1, robots.length - 1);
  const stationCeiling = Math.max(safeConfiguredLimit, packingCapacity);
  const fleetRampCeiling = Math.max(safeConfiguredLimit, Math.ceil(robotCeiling * 0.55));
  const demandRamp = safeConfiguredLimit + Math.ceil((queuedCount - safeConfiguredLimit) / 4);

  return Math.max(
    safeConfiguredLimit,
    Math.min(robotCeiling, stationCeiling, fleetRampCeiling, demandRamp)
  );
}

/**
 * Minimum battery to accept new work. With a charger present this is the low-battery
 * threshold itself: a robot that is already due for charging must go charge instead of
 * being handed another mission (assignment runs before the tick that would send it to
 * the charger, so a lower floor let busy fleets starve robots of charge indefinitely).
 * Without a charger there is nowhere to recharge, so only a hard floor applies.
 */
export function assignmentBatteryFloor(scenario?: WarehouseScenario): number {
  const hasCharger = scenario?.stations.some(station => station.type === "charging") ?? false;
  return hasCharger ? Math.max(5, scenario?.simulation.lowBatteryThreshold ?? 15) : 5;
}

function isRobotAssignable(robot: RobotRuntime): boolean {
  return robot.state === "idle" || robot.state === "returning";
}

function selectRobotForMission(
  idle: RobotRuntime[],
  mode: "round-robin" | "nearest-robot" | "least-busy" | "eta-optimal",
  graph: NavGraph,
  target: Vec2,
  mission?: Mission,
  scenario?: WarehouseScenario,
  congestionMap?: Map<string, number>
): RobotRuntime | undefined {
  if (mode === "round-robin") return idle.shift();

  if (mode === "nearest-robot") {
    let bestDist = Infinity;
    let bestIdx = -1;
    for (let i = 0; i < idle.length; i++) {
      const d = estimateAssignmentEnergyScore(idle[i], target, graph, scenario);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx >= 0) return idle.splice(bestIdx, 1)[0];
    return undefined;
  }

  if (mode === "eta-optimal" && scenario) {
    let bestEta = Infinity;
    let bestIdx = -1;
    for (let i = 0; i < idle.length; i++) {
      const eta = estimateCompletionTime(idle[i], target, mission, graph, scenario, congestionMap);
      if (eta < bestEta) { bestEta = eta; bestIdx = i; }
    }
    if (bestIdx >= 0) return idle.splice(bestIdx, 1)[0];
    return undefined;
  }

  let bestRemaining = Infinity;
  let bestIdx = -1;
  for (let i = 0; i < idle.length; i++) {
    const remaining = idle[i].path.length - idle[i].pathIndex;
    if (remaining < bestRemaining) { bestRemaining = remaining; bestIdx = i; }
  }
  if (bestIdx >= 0) return idle.splice(bestIdx, 1)[0];
  return undefined;
}

function estimateCompletionTime(
  robot: RobotRuntime,
  sourcePos: Vec2,
  mission: Mission | undefined,
  graph: NavGraph,
  scenario: WarehouseScenario,
  congestionMap?: Map<string, number>
): number {
  const speed = scenario.robots.speedMetersPerSecond;
  const tickMs = scenario.simulation.tickMs;
  const tickSpeed = speed * (tickMs / 1000);

  const targetStationId = mission?.targetStationId ?? "";
  const sourceSlotPos = sourcePos;

  const distToSource = estimateDistance(graph, robot.position, sourceSlotPos);
  const travelToSourceTicks = distToSource / Math.max(tickSpeed, 0.01);

  const station = scenario.stations.find(s => s.id === targetStationId);
  const stationPos = station ? station.position : { x: 0, z: 0 };
  const distToStation = estimateDistance(graph, sourceSlotPos, stationPos);
  const travelToStationTicks = distToStation / Math.max(tickSpeed, 0.01);

  let congestionPenalty = 0;
  if (congestionMap) {
    const aisleKey = `aisle_${Math.round(sourceSlotPos.z / 3)}`;
    congestionPenalty += (congestionMap.get(aisleKey) ?? 0) * 3;
    const stationAisleKey = `aisle_${Math.round(stationPos.z / 3)}`;
    congestionPenalty += (congestionMap.get(stationAisleKey) ?? 0) * 2;
  }

  const queues = getStationQueues();
  const stationQueue = queues.find(q => q.stationId === targetStationId);
  const queueWaitTicks = stationQueue ? stationQueue.occupiedBy.length * 40 : 0;

  const pickPlaceTimePerLevel = scenario.simulation.pickPlaceTimePerLevel ?? 3;
  const liftTimeTicks = 60 + pickPlaceTimePerLevel * 2;

  const batteryPenalty = robot.batteryMinutes < 30 ? (30 - robot.batteryMinutes) * 5 : 0;

  return travelToSourceTicks + travelToStationTicks +
    congestionPenalty + queueWaitTicks + liftTimeTicks + batteryPenalty;
}

function estimateAssignmentEnergyScore(
  robot: RobotRuntime,
  target: Vec2,
  graph: NavGraph,
  scenario?: WarehouseScenario
): number {
  const travel = estimateDistance(graph, robot.position, target);
  if (!scenario) return travel;

  const homeDistance = Math.hypot(robot.position.x - robot.homePosition.x, robot.position.z - robot.homePosition.z);
  const parkedAtHome = homeDistance < 0.4;

  let score = travel;
  if (parkedAtHome) {
    score += nearestStationAccessDistance(robot.homePosition, scenario) * 0.05;
  }
  return score;
}

function nearestStationAccessDistance(position: Vec2, scenario: WarehouseScenario): number {
  const stations = scenario.stations.filter(station =>
    station.type === "packing" || station.type === "inbound" || station.type === "buffer"
  );
  if (stations.length === 0) return 0;
  return Math.min(...stations.map(station =>
    Math.hypot(position.x - station.position.x, position.z - station.position.z)
  ));
}

export function isSourceSlotReserved(
  missions: Mission[],
  sourceSlotId: string,
  excludeMissionId?: string
): boolean {
  return missions.some(mission =>
    mission.id !== excludeMissionId &&
    mission.sourceSlotId === sourceSlotId &&
    isMissionSourceReservationActive(mission)
  );
}

function isMissionSourceReservationActive(mission: Mission): boolean {
  return mission.status === "queued" ||
    mission.status === "assigned" ||
    mission.status === "moving" ||
    mission.status === "picking" ||
    mission.status === "placing";
}

function isSourceSlotInFlight(
  missions: Mission[],
  sourceSlotId: string,
  excludeMissionId?: string
): boolean {
  return missions.some(mission =>
    mission.id !== excludeMissionId &&
    mission.sourceSlotId === sourceSlotId &&
    (
      mission.status === "assigned" ||
      mission.status === "moving" ||
      mission.status === "picking" ||
      mission.status === "placing"
    )
  );
}

function estimateDistance(graph: NavGraph, from: Vec2, to: Vec2): number {
  const startId = findNearestNodeId(graph.nodes, from);
  const goalId = findNearestNodeId(graph.nodes, to);
  if (!startId || !goalId) return Math.hypot(to.x - from.x, to.z - from.z);
  const path = aStar(graph, startId, goalId);
  let dist = 0;
  for (let i = 1; i < path.length; i++) {
    dist += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
  }
  return dist || Math.hypot(to.x - from.x, to.z - from.z);
}
