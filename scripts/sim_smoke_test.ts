import { createDefaultScenario } from "../src/app/defaultScenario";
import type { Mission, RobotRuntime, Slot, WarehouseScenario } from "../src/domain/schema";
import { computeWarehouseExtents, generateSlots, normalizeScenarioGeometry } from "../src/domain/warehouseGenerator";
import { buildNavigationGraph, pathToPoint, pathToStation } from "../src/domain/navigationGraph";
import { initRobots, tickRobots, getDeadlockStats, getStationQueues, getTrafficEvents, getYieldBays, clearTrafficEvents, getParkingBays, getParkingReassignments, getPhysicalCollisionCount, resetCollisionTracking, __detectPhysicalCollisionsForTest, getStartupDispatchStats, getMissionAnalysis } from "../src/domain/robotSimulation";
import { isClearSegment } from "../src/domain/obstacles";
import { assignMissions, createManualMission, createMoveToPointMission, assignMissionToRobot, generateMissions, resetMissionCounter, resolveActiveMissionLimit, assignmentBatteryFloor } from "../src/domain/missionPlanner";
import { runStressCase, STRESS_CASES } from "./sim_stress_test";
import { buildSolidObstacles, robotRadius } from "../src/domain/obstacles";
import { recordTick, getAllTraces, clearTraces } from "../src/domain/traceRecorder";

declare const process: { exitCode?: number };

type TestResult = {
  name: string;
  passed: boolean;
  ticks: number;
  done: number;
  failed: number;
  moving: number;
  totalDistance: number;
  totalWait: number;
  details: string;
};

function runManualMission(name: string, customize: (scenario: WarehouseScenario) => void): TestResult {
  const scenario = createDefaultScenario();
  customize(scenario);
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const inbound = scenario.stations.find(station => station.type === "inbound") ?? scenario.stations[0];
  const source = chooseSourceSlot(slots);
  const mission = createManualMission(source, inbound.id, 0);
  const assigned = assignMissionToRobot(mission, robots[0], slots, []);
  if (!assigned.ok) {
    return fail(name, 0, [mission], robots, "reason" in assigned ? assigned.reason : "assignment failed");
  }
  const missions = [mission];
  const ticks = runTicks(scenario, robots, missions, slots, graph, 1200);
  return summarize(name, ticks, missions, robots, `source=${source.id}, target=${inbound.id}`);
}

function runGeneratedMissionBatch(name: string, customize: (scenario: WarehouseScenario) => void): TestResult {
  const scenario = createDefaultScenario();
  customize(scenario);
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, scenario.simulation.missionCount, 0);
  assignMissions(
    missions,
    robots,
    graph,
    slots,
    scenario.simulation.allocator,
    scenario.stations,
    scenario.simulation.maxActiveMissions,
    scenario
  );
  const ticks = runTicks(scenario, robots, missions, slots, graph, 1600, true);
  return summarize(name, ticks, missions, robots, `generated=${missions.length}`);
}

function runMissionChainingTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 1;
  scenario.robots.speedMetersPerSecond = 3.6;
  scenario.simulation.maxActiveMissions = 1;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const inbound = scenario.stations.find(station => station.type === "inbound") ?? scenario.stations[0];
  const sources = slots.filter(slot => slot.occupied).slice(0, 2);
  const missions = sources.map(slot => createManualMission(slot, inbound.id, 0));
  let ticks = runTicks(scenario, robots, missions, slots, graph, 2000, true);
  ticks += runUntilRobotsClear(scenario, robots, missions, slots, graph, ticks, 800);
  const distanceFromHome = Math.hypot(
    robots[0].position.x - robots[0].homePosition.x,
    robots[0].position.z - robots[0].homePosition.z
  );
  const result = summarize("mission-chain-after-completion", ticks, missions, robots, `missions=${missions.length}`);
  result.passed = missions.filter(mission => mission.status === "done").length === 2 &&
    robots[0].state === "idle" &&
    distanceFromHome < 0.2 &&
    sources.every(slot => !slot.occupied);
  return result;
}

function runNoReturnBetweenQueuedMissionsTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 1;
  scenario.robots.speedMetersPerSecond = 3.6;
  scenario.simulation.maxActiveMissions = 1;
  scenario.simulation.allocator = "nearest-robot";
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const inbound = scenario.stations.find(station => station.type === "inbound") ?? scenario.stations[0];
  const sources = slots.filter(slot => slot.occupied).slice(0, 2);
  const missions = sources.map(slot => createManualMission(slot, inbound.id, 0));
  const congestionMap = new Map<string, number>();
  let earlyReturn = false;
  let firstDoneTick = -1;
  let secondAssignedTick = -1;

  for (let tick = 1; tick <= 2200; tick++) {
    assignMissions(
      missions,
      robots,
      graph,
      slots,
      scenario.simulation.allocator,
      scenario.stations,
      scenario.simulation.maxActiveMissions,
      scenario,
      congestionMap
    );
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);

    if (firstDoneTick < 0 && missions[0].status === "done") {
      firstDoneTick = tick;
    }
    if (secondAssignedTick < 0 && missions[1].assignedRobotId !== undefined) {
      secondAssignedTick = tick;
    }
    if (missions[0].status === "done" && missions[1].status === "queued" && robots[0].state === "returning") {
      earlyReturn = true;
      break;
    }
    if (missions.every(mission => mission.status === "done") && allRobotsAtOrganizedStandby(robots)) {
      break;
    }
  }

  const distanceFromHome = Math.hypot(
    robots[0].position.x - robots[0].homePosition.x,
    robots[0].position.z - robots[0].homePosition.z
  );
  const result = summarize(
    "no-return-between-queued-missions",
    Math.max(firstDoneTick, secondAssignedTick),
    missions,
    robots,
    `firstDone=${firstDoneTick}, secondAssigned=${secondAssignedTick}, earlyReturn=${earlyReturn}, homeDist=${distanceFromHome.toFixed(2)}`
  );
  result.passed = firstDoneTick > 0 &&
    secondAssignedTick > firstDoneTick &&
    !earlyReturn &&
    missions.every(mission => mission.status === "done") &&
    allRobotsAtOrganizedStandby(robots);
  return result;
}

function runUnassignedRobotsStayParkedTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 12;
  scenario.simulation.maxActiveMissions = 2;
  scenario.simulation.missionCount = 2;
  scenario.simulation.allocator = "nearest-robot";
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, 2, 0);
  const congestionMap = new Map<string, number>();

  assignMissions(
    missions,
    robots,
    graph,
    slots,
    scenario.simulation.allocator,
    scenario.stations,
    scenario.simulation.maxActiveMissions,
    scenario,
    congestionMap
  );
  const initiallyAssigned = new Set(missions.map(mission => mission.assignedRobotId).filter(Boolean));
  const unassignedIds = robots
    .filter(robot => !initiallyAssigned.has(robot.id))
    .map(robot => robot.id);

  for (let tick = 1; tick <= 350; tick++) {
    assignMissions(
      missions,
      robots,
      graph,
      slots,
      scenario.simulation.allocator,
      scenario.stations,
      scenario.simulation.maxActiveMissions,
      scenario,
      congestionMap
    );
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
  }

  const movedUnassigned = robots.filter(robot =>
    unassignedIds.includes(robot.id) &&
    Math.hypot(robot.position.x - robot.homePosition.x, robot.position.z - robot.homePosition.z) > 0.05
  );
  const result = summarize(
    "unassigned-robots-stay-parked",
    350,
    missions,
    robots,
    `initialAssigned=${Array.from(initiallyAssigned).join(",")}, movedUnassigned=${movedUnassigned.map(r => r.id).join(",") || "none"}`
  );
  result.passed = initiallyAssigned.size === 2 && movedUnassigned.length === 0;
  return result;
}

function runReturnToStandbyTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 1;
  scenario.robots.speedMetersPerSecond = 3.6;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const inbound = scenario.stations.find(station => station.type === "inbound") ?? scenario.stations[0];
  const source = chooseSourceSlot(slots);
  const mission = createManualMission(source, inbound.id, 0);
  const assigned = assignMissionToRobot(mission, robots[0], slots, []);
  if (!assigned.ok) {
    return fail("return-to-standby-after-delivery", 0, [mission], robots, "reason" in assigned ? assigned.reason : "assignment failed");
  }

  const missions = [mission];
  const deliveryTick = runTicks(scenario, robots, missions, slots, graph, 1200);
  const startedReturn = mission.status === "done" && robots[0].state === "returning" && robots[0].path.length > 0;
  const returnTicks = runUntilRobotsClear(scenario, robots, missions, slots, graph, deliveryTick, 800);
  const distanceFromHome = Math.hypot(
    robots[0].position.x - robots[0].homePosition.x,
    robots[0].position.z - robots[0].homePosition.z
  );
  const result = summarize(
    "return-to-standby-after-delivery",
    deliveryTick + returnTicks,
    missions,
    robots,
    `startedReturn=${startedReturn}, homeDist=${distanceFromHome.toFixed(2)}`
  );
  result.passed = startedReturn && robots[0].state === "idle" && distanceFromHome < 0.2;
  return result;
}

function runIdleAwayAutoRehomeTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 6;
  scenario.simulation.routing = "reservation-table";
  scenario.simulation.collisionAvoidance = true;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions: Mission[] = [];

  robots.forEach((robot, index) => {
    robot.position = {
      x: robot.homePosition.x + (index % 2 === 0 ? 0.75 : -0.75),
      z: robot.homePosition.z + 6 + Math.floor(index / 2) * 0.4,
    };
    robot.state = "idle";
    robot.path = [];
    robot.pathIndex = 0;
    robot.missionId = undefined;
  });

  const initialParkingError = maxDistanceFromAssignedParking(robots);
  const congestionMap = new Map<string, number>();
  let ticks = 0;
  for (ticks = 1; ticks <= 1200; ticks++) {
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, ticks);
    if (allRobotsAtOrganizedStandby(robots)) break;
  }

  const finalParkingError = maxDistanceFromAssignedParking(robots);
  const result = summarize(
    "idle-away-auto-rehome",
    ticks,
    missions,
    robots,
    `initialParkingError=${initialParkingError.toFixed(2)}, finalParkingError=${finalParkingError.toFixed(2)}`
  );
  result.passed = initialParkingError > 1 &&
    finalParkingError <= 0.35 &&
    allRobotsAtOrganizedStandby(robots) &&
    result.totalDistance > 0;
  return result;
}

function runMoveToPointTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 1;
  scenario.robots.speedMetersPerSecond = 3.6;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  // Target an open point on the front main aisle (derived from geometry so the test is
  // robust to layout changes rather than hardcoding a coordinate that may land in a rack).
  const target = { x: 6, z: computeWarehouseExtents(scenario).mainAisleZ };
  const mission = createMoveToPointMission(target, 0);
  const assigned = assignMissionToRobot(mission, robots[0], slots, []);
  if (!assigned.ok) {
    return fail("move-to-position", 0, [mission], robots, "reason" in assigned ? assigned.reason : "assignment failed");
  }
  const ticks = runTicks(scenario, robots, [mission], slots, graph, 700);
  const distanceToTarget = Math.hypot(robots[0].position.x - target.x, robots[0].position.z - target.z);
  const result = summarize("move-to-position", ticks, [mission], robots, `target=${target.x},${target.z}, dist=${distanceToTarget.toFixed(2)}`);
  result.passed = mission.status === "done" && distanceToTarget < 0.15;
  return result;
}

function runDuplicateSourceReservationTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 2;
  const slots = generateSlots(scenario);
  const robots = initRobots(scenario);
  const inbound = scenario.stations.find(station => station.type === "inbound") ?? scenario.stations[0];
  const source = chooseSourceSlot(slots);
  const first = createManualMission(source, inbound.id, 0);
  const firstAssigned = assignMissionToRobot(first, robots[0], slots, []);
  const second = createManualMission(source, inbound.id, 0);
  const secondAssigned = assignMissionToRobot(second, robots[1], slots, [first]);
  const result = summarize("duplicate-source-reservation", 0, [first, second], robots, `source=${source.id}`);
  result.passed = firstAssigned.ok &&
    !secondAssigned.ok &&
    "reason" in secondAssigned &&
    secondAssigned.reason.includes("already reserved");
  return result;
}

function runHighShelfLiftTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 1;
  scenario.robots.speedMetersPerSecond = 3.5;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const inbound = scenario.stations.find(station => station.type === "inbound") ?? scenario.stations[0];
  const source = slots.find(slot => slot.occupied && slot.levelIndex === scenario.racks.levels - 1) ?? chooseSourceSlot(slots);
  const mission = createManualMission(source, inbound.id, 0);
  const assigned = assignMissionToRobot(mission, robots[0], slots, []);
  if (!assigned.ok) {
    return fail("high-shelf-scissor-lift", 0, [mission], robots, "reason" in assigned ? assigned.reason : "assignment failed");
  }
  const missions = [mission];
  const congestionMap = new Map<string, number>();
  let ticks = 0;
  for (ticks = 1; ticks <= 900; ticks++) {
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, scenario.simulation.collisionAvoidance, ticks);
    if (mission.statusNote?.includes(`level ${source.levelIndex + 1}`)) break;
  }
  const result = summarize("high-shelf-scissor-lift", ticks, missions, robots, `source=${source.id}, level=${source.levelIndex + 1}`);
  result.passed = source.levelIndex === scenario.racks.levels - 1 &&
    mission.status === "picking" &&
    mission.statusNote === `Scissor lift extending to level ${source.levelIndex + 1}`;
  return result;
}

function runCollisionPredictionStressTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 12;
  scenario.simulation.missionCount = 10;
  scenario.simulation.maxActiveMissions = 6;
  scenario.simulation.robotClearanceMeters = 0.2;
  scenario.racks.crossAisleEveryBays = 2;
  scenario.racks.crossAisleWidth = 3.2;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, scenario.simulation.missionCount, 0);
  assignMissions(
    missions,
    robots,
    graph,
    slots,
    scenario.simulation.allocator,
    scenario.stations,
    scenario.simulation.maxActiveMissions
  );

  const congestionMap = new Map<string, number>();
  const minDistance = Math.max(scenario.robots.footprintWidth, scenario.robots.footprintDepth) +
    scenario.simulation.robotClearanceMeters;
  let collisions = 0;
  let ticks = 0;
  for (ticks = 1; ticks <= 1200; ticks++) {
    assignMissions(
      missions,
      robots,
      graph,
      slots,
      scenario.simulation.allocator,
      scenario.stations,
      scenario.simulation.maxActiveMissions
    );
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, scenario.simulation.collisionAvoidance, ticks);
    collisions += countRobotCollisions(robots, minDistance);
  }

  const result = summarize("predictive-collision-stress", ticks, missions, robots, `collisions=${collisions}`);
  result.passed = collisions === 0 && result.totalDistance > 0 && missions.some(mission => mission.status !== "queued");
  return result;
}

function runLargeRackAutoFitGeometryTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.warehouse.width = 84;
  scenario.warehouse.depth = 58;
  scenario.racks.rowCount = 28;
  scenario.racks.baysPerRow = 14;

  const geometry = normalizeScenarioGeometry(scenario);
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const halfW = scenario.warehouse.width / 2;
  const halfD = scenario.warehouse.depth / 2;
  const ext = computeWarehouseExtents(scenario);
  const rackRect = {
    minX: ext.rackBlockStartX - 1.2,
    maxX: ext.rackBlockStartX + ext.rackBlockWidth + 1.2,
    minZ: ext.rackBlockStartZ - 1.2,
    maxZ: ext.rackBlockStartZ + ext.rackBlockDepth + 1.2,
  };

  const slotsInside = slots.every(slot =>
    slot.position.x > -halfW && slot.position.x < halfW &&
    slot.position.z > -halfD && slot.position.z < halfD
  );
  const nodesInside = Array.from(graph.nodes.values()).every(node =>
    node.position.x > -halfW && node.position.x < halfW &&
    node.position.z > -halfD && node.position.z < halfD
  );
  const robotsInside = robots.every(robot =>
    robot.position.x > -halfW && robot.position.x < halfW &&
    robot.position.z > -halfD && robot.position.z < halfD
  );
  const stationsClear = scenario.stations.every(station => {
    const rect = {
      minX: station.position.x - station.width / 2,
      maxX: station.position.x + station.width / 2,
      minZ: station.position.z - station.depth / 2,
      maxZ: station.position.z + station.depth / 2,
    };
    const insideWarehouse =
      rect.minX > -halfW && rect.maxX < halfW &&
      rect.minZ > -halfD && rect.maxZ < halfD;
    const overlapsRack =
      Math.max(rect.minX, rackRect.minX) < Math.min(rect.maxX, rackRect.maxX) &&
      Math.max(rect.minZ, rackRect.minZ) < Math.min(rect.maxZ, rackRect.maxZ);
    return insideWarehouse && !overlapsRack;
  });

  return {
    name: "large-row-layout-autofit",
    passed: geometry.warehouseResized &&
      scenario.warehouse.depth >= geometry.requiredDepth &&
      slotsInside &&
      nodesInside &&
      robotsInside &&
      stationsClear,
    ticks: 0,
    done: 0,
    failed: 0,
    moving: 0,
    totalDistance: 0,
    totalWait: 0,
    details: `size=${scenario.warehouse.width}x${scenario.warehouse.depth}, moved=${geometry.stationsMoved.join("|") || "none"}, slots=${slots.length}, nodes=${graph.nodes.size}`,
  };
}

function runTicks(
  scenario: WarehouseScenario,
  robots: RobotRuntime[],
  missions: Mission[],
  slots: Slot[],
  graph: ReturnType<typeof buildNavigationGraph>,
  maxTicks: number,
  assignQueued = false
): number {
  const congestionMap = new Map<string, number>();
  for (let tick = 1; tick <= maxTicks; tick++) {
    if (assignQueued) {
      assignMissions(
        missions,
        robots,
        graph,
        slots,
        scenario.simulation.allocator,
        scenario.stations,
        scenario.simulation.maxActiveMissions,
        scenario,
        congestionMap
      );
    }
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, scenario.simulation.collisionAvoidance, tick);
    if (missions.length > 0 && missions.every(mission => mission.status === "done" || mission.status === "failed")) {
      return tick;
    }
  }
  return maxTicks;
}

function runUntilRobotsClear(
  scenario: WarehouseScenario,
  robots: RobotRuntime[],
  missions: Mission[],
  slots: Slot[],
  graph: ReturnType<typeof buildNavigationGraph>,
  startTick: number,
  maxTicks: number
): number {
  const congestionMap = new Map<string, number>();
  for (let i = 1; i <= maxTicks; i++) {
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, scenario.simulation.collisionAvoidance, startTick + i);
    if (robots.every(robot => robot.state === "idle" || robot.state === "charging")) {
      return i;
    }
  }
  return maxTicks;
}

function maxDistanceFromAssignedParking(robots: RobotRuntime[]): number {
  return Math.max(0, ...robots.map(robot =>
    Math.hypot(
      robot.position.x - (robot.assignedParkingPosition ?? robot.homePosition).x,
      robot.position.z - (robot.assignedParkingPosition ?? robot.homePosition).z
    )
  ));
}

function maxDistanceFromHomeParking(robots: RobotRuntime[]): number {
  return Math.max(0, ...robots.map(robot =>
    Math.hypot(
      robot.position.x - robot.homePosition.x,
      robot.position.z - robot.homePosition.z
    )
  ));
}

function allRobotsAtOrganizedStandby(robots: RobotRuntime[], tolerance = 0.35): boolean {
  const parked = robots.every(robot =>
    (robot.state === "idle" || robot.state === "charging") &&
    Math.hypot(
      robot.position.x - robot.homePosition.x,
      robot.position.z - robot.homePosition.z
    ) <= tolerance
  );
  const distinctTargets = new Set(robots.map(robot => {
    const target = robot.homePosition;
    return `${target.x.toFixed(1)}:${target.z.toFixed(1)}`;
  }));
  return parked && distinctTargets.size === robots.length;
}

function chooseSourceSlot(slots: Slot[]): Slot {
  const occupied = slots.filter(slot => slot.occupied);
  if (occupied.length === 0) throw new Error("No occupied source slots");
  return occupied[0];
}

function summarize(
  name: string,
  ticks: number,
  missions: Mission[],
  robots: RobotRuntime[],
  details: string
): TestResult {
  const done = missions.filter(mission => mission.status === "done").length;
  const failed = missions.filter(mission => mission.status === "failed").length;
  const moving = missions.filter(mission => mission.status !== "done" && mission.status !== "failed").length;
  const totalDistance = robots.reduce((sum, robot) => sum + robot.totalDistance, 0);
  const totalWait = robots.reduce((sum, robot) => sum + robot.totalWaitTicks, 0);
  const passed = failed === 0 && (done > 0 || moving > 0) && totalDistance > 0;
  return { name, passed, ticks, done, failed, moving, totalDistance, totalWait, details };
}

function fail(name: string, ticks: number, missions: Mission[], robots: RobotRuntime[], details: string): TestResult {
  const result = summarize(name, ticks, missions, robots, details);
  result.passed = false;
  return result;
}

function circleIntersectsRect(cx: number, cz: number, radius: number, rect: { minX: number; maxX: number; minZ: number; maxZ: number }): boolean {
  const closestX = Math.max(rect.minX, Math.min(cx, rect.maxX));
  const closestZ = Math.max(rect.minZ, Math.min(cz, rect.maxZ));
  return Math.hypot(cx - closestX, cz - closestZ) < radius;
}

function runRobotRackCollisionTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 8;
  scenario.simulation.missionCount = 6;
  scenario.simulation.maxActiveMissions = 4;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, scenario.simulation.missionCount, 0);
  assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);

  const solids = buildSolidObstacles(scenario);
  const rackSolids = solids.filter(s => s.id.startsWith("rack-"));
  const radius = robotRadius(scenario);
  const congestionMap = new Map<string, number>();
  let collisions = 0;

  for (let tick = 1; tick <= 800; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    for (const robot of robots) {
      for (const rect of rackSolids) {
        if (circleIntersectsRect(robot.position.x, robot.position.z, radius, rect)) {
          collisions++;
        }
      }
    }
  }

  const result = summarize("robot-rack-collision", 800, missions, robots, `rack_collisions=${collisions}`);
  result.passed = collisions === 0 && result.totalDistance > 0;
  return result;
}

function runRobotWallCollisionTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 6;
  scenario.simulation.missionCount = 4;
  scenario.simulation.maxActiveMissions = 3;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, scenario.simulation.missionCount, 0);
  assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);

  const halfW = scenario.warehouse.width / 2;
  const halfD = scenario.warehouse.depth / 2;
  const radius = robotRadius(scenario);
  const congestionMap = new Map<string, number>();
  let collisions = 0;

  for (let tick = 1; tick <= 800; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    for (const robot of robots) {
      if (robot.position.x - radius < -halfW || robot.position.x + radius > halfW ||
          robot.position.z - radius < -halfD || robot.position.z + radius > halfD) {
        collisions++;
      }
    }
  }

  const result = summarize("robot-wall-collision", 800, missions, robots, `wall_collisions=${collisions}`);
  result.passed = collisions === 0 && result.totalDistance > 0;
  return result;
}

function runRobotStationCollisionTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 6;
  scenario.simulation.missionCount = 4;
  scenario.simulation.maxActiveMissions = 3;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, scenario.simulation.missionCount, 0);
  assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);

  const solids = buildSolidObstacles(scenario);
  const stationSolids = solids.filter(s => s.id.startsWith("station-"));
  const radius = robotRadius(scenario);
  const congestionMap = new Map<string, number>();
  let collisions = 0;

  for (let tick = 1; tick <= 800; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    for (const robot of robots) {
      if (robot.state === "placing" || robot.state === "picking") continue;
      for (const rect of stationSolids) {
        if (circleIntersectsRect(robot.position.x, robot.position.z, radius, rect)) {
          collisions++;
        }
      }
    }
  }

  const result = summarize("robot-station-collision", 800, missions, robots, `station_collisions=${collisions}`);
  result.passed = collisions === 0 && result.totalDistance > 0;
  return result;
}

function runRobotColumnCollisionTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 4;
  scenario.visual.showSupportColumns = true;
  scenario.simulation.missionCount = 3;
  scenario.simulation.maxActiveMissions = 2;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, scenario.simulation.missionCount, 0);
  assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);

  const solids = buildSolidObstacles(scenario);
  const columnSolids = solids.filter(s => s.id.startsWith("column-"));
  const radius = robotRadius(scenario);
  const congestionMap = new Map<string, number>();
  let collisions = 0;

  for (let tick = 1; tick <= 800; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    for (const robot of robots) {
      for (const rect of columnSolids) {
        if (circleIntersectsRect(robot.position.x, robot.position.z, radius, rect)) {
          collisions++;
        }
      }
    }
  }

  const result = summarize("robot-column-collision", 800, missions, robots, `columns=${columnSolids.length}, collisions=${collisions}`);
  result.passed = collisions === 0;
  return result;
}

function runDeadlockDetectionTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 6;
  scenario.simulation.missionCount = 6;
  scenario.simulation.maxActiveMissions = 4;
  scenario.simulation.robotClearanceMeters = 0.15;
  scenario.racks.crossAisleEveryBays = 3;
  scenario.racks.aisleWidth = 2.8;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, scenario.simulation.missionCount, 0);
  assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);

  const congestionMap = new Map<string, number>();
  for (let tick = 1; tick <= 1000; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
  }

  const stats = getDeadlockStats();
  const unresolvedRobotBlock = robots.some(r => r.blockedTicks >= 120 && r.waitingForRobotId !== undefined);
  const maxBlocked = Math.max(...robots.map(r => r.blockedTicks));
  const result = summarize("deadlock-detection-recovery", 1000, missions, robots,
    `detected=${stats.deadlocksDetected}, resolved=${stats.deadlocksResolved}, maxBlocked=${maxBlocked}`);
  result.passed = !unresolvedRobotBlock &&
    stats.deadlocksResolved >= stats.deadlocksDetected &&
    result.totalDistance > 0;
  return result;
}

function runHeadOnYieldPocketTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 2;
  scenario.robots.speedMetersPerSecond = 3.2;
  scenario.simulation.robotClearanceMeters = 0.25;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const z = robots[0].homePosition.z;
  const missionA = createMoveToPointMission({ x: 6, z }, 0);
  const missionB = createMoveToPointMission({ x: -6, z }, 0);
  const assignedA = assignMissionToRobot(missionA, robots[0], slots, []);
  const assignedB = assignMissionToRobot(missionB, robots[1], slots, [missionA]);
  if (!assignedA.ok || !assignedB.ok) {
    return fail("head-on-yield-pocket", 0, [missionA, missionB], robots, "assignment failed");
  }

  robots[0].position = { x: -1, z };
  robots[1].position = { x: 1, z };
  robots[0].path = [{ x: 6, z }];
  robots[1].path = [{ x: -6, z }];
  robots[0].pathIndex = 0;
  robots[1].pathIndex = 0;
  robots[0].blockedTicks = 12;
  robots[1].blockedTicks = 12;
  robots[0].waitingForRobotId = 2;
  robots[1].waitingForRobotId = 1;

  const congestionMap = new Map<string, number>();
  const minDistance = robotRadius(scenario) * 2 + scenario.simulation.robotClearanceMeters;
  let sawYield = false;
  let collisions = 0;
  for (let tick = 1; tick <= 700; tick++) {
    tickRobots(robots, [missionA, missionB], slots, scenario, graph, congestionMap, true, tick);
    sawYield ||= robots.some(robot => robot.state === "yielding") ||
      [missionA, missionB].some(mission => mission.statusNote?.includes("Yielding"));
    collisions += countRobotCollisions(robots, minDistance);
    if (missionA.status === "done" && missionB.status === "done" && robots.every(robot => robot.state !== "yielding")) {
      break;
    }
  }

  const stats = getDeadlockStats();
  const result = summarize(
    "head-on-yield-pocket",
    700,
    [missionA, missionB],
    robots,
    `yield=${sawYield}, resolved=${stats.deadlocksResolved}, collisions=${collisions}`
  );
  result.passed = sawYield &&
    stats.deadlocksResolved > 0 &&
    collisions === 0 &&
    missionA.status === "done" &&
    missionB.status === "done";
  return result;
}

function runStationQueueTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 4;
  scenario.simulation.missionCount = 4;
  scenario.simulation.maxActiveMissions = 3;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, scenario.simulation.missionCount, 0);
  assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);

  const congestionMap = new Map<string, number>();
  let queuesSeen = false;
  for (let tick = 1; tick <= 600; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    const queues = getStationQueues();
    if (queues.length > 0) queuesSeen = true;
  }

  const result = summarize("station-queue-modeling", 600, missions, robots, `queues_seen=${queuesSeen}`);
  result.passed = queuesSeen && result.totalDistance > 0;
  return result;
}

function runTimeWindowReservationTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 8;
  scenario.simulation.missionCount = 6;
  scenario.simulation.maxActiveMissions = 4;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, scenario.simulation.missionCount, 0);
  assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);

  const congestionMap = new Map<string, number>();
  for (let tick = 1; tick <= 600; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
  }

  const stats = getDeadlockStats();
  const result = summarize("time-window-reservations", 600, missions, robots,
    `reservations=${stats.timeWindowReservations}`);
  result.passed = stats.timeWindowReservations > 0 && result.totalDistance > 0;
  return result;
}

function runLiftTelemetryTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 1;
  scenario.robots.speedMetersPerSecond = 3.5;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const inbound = scenario.stations.find(s => s.type === "inbound") ?? scenario.stations[0];
  const highSlot = slots.find(s => s.occupied && s.levelIndex >= 2) ?? chooseSourceSlot(slots);
  const mission = createManualMission(highSlot, inbound.id, 0);
  const assigned = assignMissionToRobot(mission, robots[0], slots, []);
  if (!assigned.ok) {
    return fail("lift-telemetry-tracking", 0, [mission], robots, "assignment failed");
  }

  const congestionMap = new Map<string, number>();
  let sawExtending = false;
  let sawLoaded = false;
  let sawLowering = false;
  let maxExtension = 0;

  for (let tick = 1; tick <= 1200; tick++) {
    tickRobots(robots, [mission], slots, scenario, graph, congestionMap, true, tick);
    const lt = robots[0].liftTelemetry;
    if (lt.payloadState === "extending") sawExtending = true;
    if (lt.payloadState === "loaded") sawLoaded = true;
    if (lt.payloadState === "lowering") sawLowering = true;
    if (lt.currentExtensionPct > maxExtension) maxExtension = lt.currentExtensionPct;
    if (mission.status === "done") break;
  }

  const result = summarize("lift-telemetry-tracking", 1200, [mission], robots,
    `extending=${sawExtending}, loaded=${sawLoaded}, lowering=${sawLowering}, maxExt=${maxExtension.toFixed(0)}`);
  result.passed = sawExtending && sawLoaded && maxExtension > 50 && mission.status === "done";
  return result;
}

function runTraceRecordingTest(): TestResult {
  clearTraces();
  const scenario = createDefaultScenario();
  scenario.robots.count = 1;
  scenario.robots.speedMetersPerSecond = 3.5;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const inbound = scenario.stations.find(s => s.type === "inbound") ?? scenario.stations[0];
  const source = chooseSourceSlot(slots);
  const mission = createManualMission(source, inbound.id, 0);
  const assigned = assignMissionToRobot(mission, robots[0], slots, []);
  if (!assigned.ok) {
    return fail("trace-recording", 0, [mission], robots, "assignment failed");
  }

  const congestionMap = new Map<string, number>();
  for (let tick = 1; tick <= 800; tick++) {
    tickRobots(robots, [mission], slots, scenario, graph, congestionMap, true, tick);
    if (mission.status === "done") break;
  }

  const traces = getAllTraces();
  const missionTrace = traces.find(t => t.missionId === mission.id);
  const hasEntries = missionTrace !== undefined && missionTrace.entries.length > 0;
  const hasEndTick = missionTrace?.endTick !== undefined;
  const entriesHavePosition = missionTrace?.entries.every(
    e => typeof e.x === "number" && typeof e.z === "number" && typeof e.tick === "number"
  ) ?? false;

  const result = summarize("trace-recording", 800, [mission], robots,
    `traces=${traces.length}, entries=${missionTrace?.entries.length ?? 0}, endTick=${hasEndTick}`);
  result.passed = hasEntries && hasEndTick && entriesHavePosition && mission.status === "done";
  clearTraces();
  return result;
}

function runSameStationQueueConflictTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 3;
  scenario.robots.speedMetersPerSecond = 3.2;
  scenario.simulation.maxActiveMissions = 3;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const inbound = scenario.stations.find(s => s.type === "inbound") ?? scenario.stations[0];
  const sources = slots.filter(s => s.occupied).slice(0, 3);
  const missions = sources.map(s => createManualMission(s, inbound.id, 0));
  const existingMissions: typeof missions = [];
  for (let i = 0; i < 3; i++) {
    const assigned = assignMissionToRobot(missions[i], robots[i], slots, existingMissions);
    if (!assigned.ok) return fail("same-station-queue-conflict", 0, missions, robots, "assignment failed");
    existingMissions.push(missions[i]);
  }

  const congestionMap = new Map<string, number>();
  let queueWaitSeen = false;
  for (let tick = 1; tick <= 1200; tick++) {
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    if (missions.some(m => m.statusNote?.includes("Queuing"))) queueWaitSeen = true;
    if (missions.every(m => m.status === "done" || m.status === "failed")) break;
  }

  const events = getTrafficEvents();
  const queueEvents = events.filter(e => e.type === "queue-wait");
  const result = summarize("same-station-queue-conflict", 1200, missions, robots,
    `queueWait=${queueWaitSeen}, queueEvents=${queueEvents.length}`);
  result.passed = missions.filter(m => m.status === "done").length >= 2 && result.totalDistance > 0;
  return result;
}

function runNarrowAislePassingTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 4;
  scenario.robots.speedMetersPerSecond = 3.0;
  scenario.racks.aisleWidth = 2.8;
  scenario.simulation.robotClearanceMeters = 0.2;
  scenario.simulation.maxActiveMissions = 3;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, 3, 0);
  assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);

  const congestionMap = new Map<string, number>();
  const minDistance = robotRadius(scenario) * 2 + scenario.simulation.robotClearanceMeters;
  let collisions = 0;
  for (let tick = 1; tick <= 1000; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    collisions += countRobotCollisions(robots, minDistance);
  }

  const result = summarize("narrow-aisle-passing", 1000, missions, robots,
    `aisleWidth=${scenario.racks.aisleWidth}, collisions=${collisions}`);
  result.passed = collisions === 0 && result.totalDistance > 0;
  return result;
}

function runLoadedVsEmptyPriorityTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 2;
  scenario.robots.speedMetersPerSecond = 3.2;
  scenario.simulation.robotClearanceMeters = 0.25;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const inbound = scenario.stations.find(s => s.type === "inbound") ?? scenario.stations[0];
  const source = chooseSourceSlot(slots);

  const pickMission = createManualMission(source, inbound.id, 0);
  const assigned = assignMissionToRobot(pickMission, robots[0], slots, []);
  if (!assigned.ok) return fail("loaded-vs-empty-priority", 0, [pickMission], robots, "assignment failed");

  const congestionMap = new Map<string, number>();
  for (let tick = 1; tick <= 400; tick++) {
    tickRobots(robots, [pickMission], slots, scenario, graph, congestionMap, true, tick);
    if (robots[0].state === "to-drop" && robots[0].carryingSlotId) break;
  }

  const loadedRobot = robots[0];
  const emptyRobot = robots[1];
  const z = loadedRobot.position.z;
  emptyRobot.position = { x: loadedRobot.position.x + 2, z };
  const emptyMission = createMoveToPointMission({ x: loadedRobot.position.x - 5, z }, 400);
  const emptyAssigned = assignMissionToRobot(emptyMission, emptyRobot, slots, [pickMission]);
  if (!emptyAssigned.ok) {
    return fail("loaded-vs-empty-priority", 0, [pickMission, emptyMission], robots, "empty assignment failed");
  }

  emptyRobot.path = [{ x: loadedRobot.position.x - 5, z }];
  emptyRobot.pathIndex = 0;
  loadedRobot.blockedTicks = 12;
  emptyRobot.blockedTicks = 12;
  loadedRobot.waitingForRobotId = emptyRobot.id;
  emptyRobot.waitingForRobotId = loadedRobot.id;

  for (let tick = 401; tick <= 900; tick++) {
    tickRobots(robots, [pickMission, emptyMission], slots, scenario, graph, congestionMap, true, tick);
    if (pickMission.status === "done") break;
  }

  const events = getTrafficEvents();
  const priorityEvents = events.filter(e => e.type === "priority-pass" || e.type === "yield");
  const loadedYielded = events.some(e => e.type === "yield" && e.robotId === loadedRobot.id);
  const emptyYielded = events.some(e => e.type === "yield" && e.robotId === emptyRobot.id);

  const result = summarize("loaded-vs-empty-priority", 900, [pickMission, emptyMission], robots,
    `priorityEvents=${priorityEvents.length}, loadedYielded=${loadedYielded}, emptyYielded=${emptyYielded}`);
  result.passed = emptyYielded && !loadedYielded && result.totalDistance > 0;
  return result;
}

function runNoRepeatedYieldLoopTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 4;
  scenario.robots.speedMetersPerSecond = 3.0;
  scenario.simulation.robotClearanceMeters = 0.2;
  scenario.simulation.maxActiveMissions = 3;
  scenario.racks.aisleWidth = 3.0;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, 3, 0);
  assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);

  clearTrafficEvents();
  const congestionMap = new Map<string, number>();
  for (let tick = 1; tick <= 1000; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
  }

  const maxConsecutive = Math.max(...robots.map(r => r.consecutiveYields), 0);
  const result = summarize("no-repeated-yield-loop", 1000, missions, robots,
    `maxConsecutiveYields=${maxConsecutive}`);
  result.passed = maxConsecutive <= 3 && result.totalDistance > 0;
  return result;
}

function runYieldBayGenerationTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.racks.crossAisleEveryBays = 4;
  scenario.racks.crossAisleWidth = 2.2;
  const robots = initRobots(scenario);
  const bays = getYieldBays();
  const result = summarize("yield-bay-generation", 0, [], robots,
    `bays=${bays.length}`);
  result.passed = bays.length > 0 && bays.every(b =>
    typeof b.position.x === "number" && typeof b.position.z === "number" && typeof b.id === "string"
  );
  return result;
}

function runPredictiveVsNormalTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 8;
  scenario.simulation.missionCount = 6;
  scenario.simulation.maxActiveMissions = 4;
  scenario.simulation.robotClearanceMeters = 0.2;
  scenario.racks.crossAisleEveryBays = 3;
  scenario.racks.crossAisleWidth = 3.0;

  // This test isolates ROUTING (a-star vs reservation-table), so pin target stations to a
  // fixed round-robin instead of the generator's load-balancing heuristic. Both runs share
  // identical missions, so the only difference measured is the routing mode.
  const packStations = scenario.stations.filter(s => s.type === "packing" || s.type === "inbound");
  const pinStations = (ms: Mission[]) => ms.forEach((m, i) => {
    if (m.type !== "move-to-point") m.targetStationId = packStations[i % packStations.length].id;
  });

  // Compare end-to-end throughput (tick when every mission is done). Total wait ticks are
  // no longer comparable across modes: they also count intentional startup-dispatch holds
  // and station queue dwell, which are policy, not routing cost.
  const runWithRouting = (routing: "a-star" | "reservation-table") => {
    scenario.simulation.routing = routing;
    resetMissionCounter();
    const slots = generateSlots(scenario);
    const graph = buildNavigationGraph(scenario);
    const robots = initRobots(scenario);
    const missions = generateMissions(scenario, slots, scenario.simulation.missionCount, 0);
    pinStations(missions);
    const congestionMap = new Map<string, number>();
    let allDoneTick = -1;
    for (let tick = 1; tick <= 2600; tick++) {
      assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);
      tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
      if (missions.every(m => m.status === "done")) { allDoneTick = tick; break; }
    }
    return {
      allDoneTick,
      done: missions.filter(m => m.status === "done").length,
      wait: robots.reduce((s, r) => s + r.totalWaitTicks, 0),
      missions,
      robots,
    };
  };

  const normal = runWithRouting("a-star");
  const predictive = runWithRouting("reservation-table");

  const result = summarize("predictive-vs-normal-routing", 2600, predictive.missions, predictive.robots,
    `normalDone=${normal.done}@${normal.allDoneTick} (wait=${normal.wait}), predictiveDone=${predictive.done}@${predictive.allDoneTick} (wait=${predictive.wait})`);
  result.passed =
    predictive.done === predictive.missions.length &&
    predictive.done >= normal.done &&
    (normal.allDoneTick < 0 || (predictive.allDoneTick > 0 && predictive.allDoneTick <= normal.allDoneTick * 1.25)) &&
    result.totalDistance > 0;
  return result;
}

function runPhysicalQueueSlotsTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 4;
  scenario.simulation.missionCount = 4;
  scenario.simulation.maxActiveMissions = 3;
  scenario.simulation.routing = "reservation-table";
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const inbound = scenario.stations.find(s => s.type === "inbound") ?? scenario.stations[0];
  const sources = slots.filter(s => s.occupied).slice(0, 3);
  const missions = sources.map(s => createManualMission(s, inbound.id, 0));
  const existingMissions: typeof missions = [];
  for (let i = 0; i < Math.min(3, robots.length); i++) {
    const assigned = assignMissionToRobot(missions[i], robots[i], slots, existingMissions);
    if (!assigned.ok) return fail("physical-queue-slots", 0, missions, robots, "assignment failed");
    existingMissions.push(missions[i]);
  }

  const congestionMap = new Map<string, number>();
  let sawQueueSlotNote = false;
  for (let tick = 1; tick <= 1200; tick++) {
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    if (missions.some(m => m.statusNote?.includes("queue slot"))) sawQueueSlotNote = true;
    if (missions.every(m => m.status === "done" || m.status === "failed")) break;
  }

  const result = summarize("physical-queue-slots", 1200, missions, robots,
    `queueSlotNote=${sawQueueSlotNote}`);
  result.passed = missions.filter(m => m.status === "done").length >= 2 && result.totalDistance > 0;
  return result;
}

function runThreeRobotChainConflictTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 3;
  scenario.robots.speedMetersPerSecond = 3.0;
  scenario.simulation.maxActiveMissions = 3;
  scenario.simulation.robotClearanceMeters = 0.2;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const inbound = scenario.stations.find(s => s.type === "inbound") ?? scenario.stations[0];
  const sources = slots.filter(s => s.occupied).slice(0, 3);
  const missions = sources.map(s => createManualMission(s, inbound.id, 0));
  const existingMissions: typeof missions = [];

  for (let i = 0; i < 3; i++) {
    const assigned = assignMissionToRobot(missions[i], robots[i], slots, existingMissions);
    if (!assigned.ok) return fail("three-robot-chain-conflict", 0, missions, robots, "assignment failed");
    existingMissions.push(missions[i]);
  }

  const congestionMap = new Map<string, number>();
  for (let tick = 1; tick <= 400; tick++) {
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    if (robots[0].state === "to-drop" && robots[0].carryingSlotId) break;
  }

  const loadedRobot = robots.find(r => r.carryingSlotId) ?? robots[0];
  const z = loadedRobot.position.z;
  for (const r of robots) {
    if (r.id !== loadedRobot.id) {
      r.position = { x: loadedRobot.position.x + (r.id - loadedRobot.id) * 1.5, z };
      r.blockedTicks = 12;
      r.waitingForRobotId = loadedRobot.id;
    }
  }

  let chainResolved = false;
  for (let tick = 401; tick <= 1200; tick++) {
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    if (robots.filter(r => r.blockedTicks >= 60).length === 0) {
      chainResolved = true;
    }
    if (missions.filter(m => m.status === "done").length >= 2) break;
  }

  const events = getTrafficEvents();
  const clusterEvents = events.filter(e =>
    e.type === "cluster-resolve" || e.type === "priority-pass" || e.type === "yield"
  );
  const doneCount = missions.filter(m => m.status === "done").length;
  const result = summarize("three-robot-chain-conflict", 1200, missions, robots,
    `loaded=R${loadedRobot.id}, doneCount=${doneCount}, clusterEvents=${clusterEvents.length}, chainResolved=${chainResolved}`);
  result.passed = doneCount >= 1 && result.totalDistance > 0;
  return result;
}

function runParkingExitConflictTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 12;
  scenario.simulation.missionCount = 8;
  scenario.simulation.maxActiveMissions = 6;
  scenario.simulation.robotClearanceMeters = 0.2;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, scenario.simulation.missionCount, 0);
  assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);

  const congestionMap = new Map<string, number>();
  const minDistance = robotRadius(scenario) * 2 + scenario.simulation.robotClearanceMeters;
  let collisions = 0;
  let maxBlockedTicks = 0;

  for (let tick = 1; tick <= 1200; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    collisions += countRobotCollisions(robots, minDistance);
    const currentMax = Math.max(...robots.map(r => r.blockedTicks));
    if (currentMax > maxBlockedTicks) maxBlockedTicks = currentMax;
  }

  const doneCount = missions.filter(m => m.status === "done").length;
  const result = summarize("parking-exit-conflict-12robots", 1200, missions, robots,
    `collisions=${collisions}, maxBlocked=${maxBlockedTicks}, done=${doneCount}`);
  result.passed = collisions === 0 && doneCount >= 1 && result.totalDistance > 0;
  return result;
}

function runTwoRobotsSameAislePassingTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 2;
  scenario.robots.speedMetersPerSecond = 2.5;
  scenario.simulation.robotClearanceMeters = 0.2;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);

  // Send the two robots in opposite directions along the open front main aisle so they must
  // pass each other; derive the aisle Z from geometry so this is layout-independent.
  const passZ = computeWarehouseExtents(scenario).mainAisleZ;
  const missionA = createMoveToPointMission({ x: 15, z: passZ }, 0);
  const missionB = createMoveToPointMission({ x: -15, z: passZ }, 0);
  const assignedA = assignMissionToRobot(missionA, robots[0], slots, []);
  const assignedB = assignMissionToRobot(missionB, robots[1], slots, [missionA]);
  if (!assignedA.ok || !assignedB.ok) {
    return fail("two-robots-same-aisle-passing", 0, [missionA, missionB], robots, "assignment failed");
  }

  const congestionMap = new Map<string, number>();
  const minDistance = robotRadius(scenario) * 2 + scenario.simulation.robotClearanceMeters;
  let collisions = 0;
  for (let tick = 1; tick <= 800; tick++) {
    tickRobots(robots, [missionA, missionB], slots, scenario, graph, congestionMap, true, tick);
    collisions += countRobotCollisions(robots, minDistance);
    if (missionA.status === "done" && missionB.status === "done") break;
  }

  const result = summarize("two-robots-same-aisle-passing", 800, [missionA, missionB], robots,
    `collisions=${collisions}`);
  result.passed = collisions === 0 && result.totalDistance > 0 &&
    (missionA.status === "done" || missionB.status === "done");
  return result;
}

function runPredictiveNoCollisionComparisonTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 10;
  scenario.simulation.missionCount = 8;
  scenario.simulation.maxActiveMissions = 5;
  scenario.simulation.robotClearanceMeters = 0.2;
  scenario.racks.crossAisleEveryBays = 3;
  scenario.racks.crossAisleWidth = 3.0;

  scenario.simulation.routing = "a-star";
  resetMissionCounter();
  const slotsA = generateSlots(scenario);
  const graphA = buildNavigationGraph(scenario);
  const robotsA = initRobots(scenario);
  const missionsA = generateMissions(scenario, slotsA, scenario.simulation.missionCount, 0);
  assignMissions(missionsA, robotsA, graphA, slotsA, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);
  const congestionMapA = new Map<string, number>();
  const minDistance = robotRadius(scenario) * 2 + scenario.simulation.robotClearanceMeters;
  let collisionsA = 0;
  for (let tick = 1; tick <= 1200; tick++) {
    assignMissions(missionsA, robotsA, graphA, slotsA, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);
    tickRobots(robotsA, missionsA, slotsA, scenario, graphA, congestionMapA, true, tick);
    collisionsA += countRobotCollisions(robotsA, minDistance);
  }
  const normalDone = missionsA.filter(m => m.status === "done").length;

  scenario.simulation.routing = "reservation-table";
  resetMissionCounter();
  const slotsB = generateSlots(scenario);
  const graphB = buildNavigationGraph(scenario);
  const robotsB = initRobots(scenario);
  const missionsB = generateMissions(scenario, slotsB, scenario.simulation.missionCount, 0);
  assignMissions(missionsB, robotsB, graphB, slotsB, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);
  const congestionMapB = new Map<string, number>();
  let collisionsB = 0;
  for (let tick = 1; tick <= 1200; tick++) {
    assignMissions(missionsB, robotsB, graphB, slotsB, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions);
    tickRobots(robotsB, missionsB, slotsB, scenario, graphB, congestionMapB, true, tick);
    collisionsB += countRobotCollisions(robotsB, minDistance);
  }
  const predictiveDone = missionsB.filter(m => m.status === "done").length;

  const result = summarize("predictive-no-collision-comparison", 1200, missionsB, robotsB,
    `normalDone=${normalDone}, predictiveDone=${predictiveDone}, collisionsA=${collisionsA}, collisionsB=${collisionsB}`);
  result.passed = collisionsB === 0 && predictiveDone >= Math.max(normalDone - 1, 1) && result.totalDistance > 0;
  return result;
}

function runTenMissionDefaultRegressionTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.simulation.missionCount = 11;
  scenario.simulation.maxActiveMissions = 4;
  scenario.simulation.routing = "reservation-table";
  scenario.simulation.allocator = "nearest-robot";

  resetMissionCounter();
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, scenario.simulation.missionCount, 0);
  const congestionMap = new Map<string, number>();
  const minDistance = robotRadius(scenario) * 2 + (scenario.simulation.robotClearanceMeters ?? 0);
  let collisions = 0;
  let allDoneTick = -1;
  let allClearTick = -1;
  let maxMissionWait = 0;
  let maxBlockedTicks = 0;

  for (let tick = 1; tick <= 3500; tick++) {
    assignMissions(
      missions,
      robots,
      graph,
      slots,
      scenario.simulation.allocator,
      scenario.stations,
      scenario.simulation.maxActiveMissions,
      scenario,
      congestionMap
    );
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    collisions += countRobotCollisions(robots, minDistance);
    maxMissionWait = Math.max(maxMissionWait, ...missions.map(m => m.waitTicks));
    maxBlockedTicks = Math.max(maxBlockedTicks, ...robots.map(r => r.blockedTicks));

    if (allDoneTick < 0 && missions.every(m => m.status === "done")) {
      allDoneTick = tick;
    }
    if (allDoneTick > 0 && allRobotsAtOrganizedStandby(robots)) {
      allClearTick = tick;
      break;
    }
  }

  const done = missions.filter(m => m.status === "done").length;
  const parkingError = maxDistanceFromHomeParking(robots);
  const result = summarize("default-11-missions-organized-standby", allClearTick > 0 ? allClearTick : 3500, missions, robots,
    `done=${done}, allDone=${allDoneTick}, allClear=${allClearTick}, maxParkingError=${parkingError.toFixed(2)}, maxWait=${maxMissionWait}, maxBlocked=${maxBlockedTicks}, collisions=${collisions}`);
  result.passed = done === 11 &&
    allDoneTick > 0 &&
    allClearTick > 0 &&
    parkingError <= 0.35 &&
    collisions === 0 &&
    maxMissionWait < 600 &&
    maxBlockedTicks < 60;
  return result;
}

function run12Robots11MissionsAllParkedTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 12;
  scenario.simulation.missionCount = 11;
  scenario.simulation.maxActiveMissions = 4;
  scenario.simulation.routing = "reservation-table";
  scenario.simulation.allocator = "nearest-robot";
  scenario.simulation.parkingStrategy = "home-slots";

  resetMissionCounter();
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, 11, 0);
  const congestionMap = new Map<string, number>();
  const minDistance = robotRadius(scenario) * 2 + (scenario.simulation.robotClearanceMeters ?? 0);
  let collisions = 0;
  let allDoneTick = -1;
  let allClearTick = -1;

  for (let tick = 1; tick <= 5000; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions, scenario, congestionMap);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    collisions += countRobotCollisions(robots, minDistance);
    if (allDoneTick < 0 && missions.every(m => m.status === "done")) allDoneTick = tick;
    if (allDoneTick > 0 && allRobotsAtOrganizedStandby(robots)) {
      allClearTick = tick;
      break;
    }
  }

  const done = missions.filter(m => m.status === "done").length;
  const allParked = allRobotsAtOrganizedStandby(robots);
  const parkingBays = getParkingBays();
  const occupiedBays = parkingBays.filter(b => b.state === "occupied").length;
  const assignedBayIds = new Set(robots.map(r => r.assignedParkingBayId).filter(Boolean));
  const distinctBays = assignedBayIds.size === robots.length;

  const result = summarize("12robots-11missions-all-parked", allClearTick > 0 ? allClearTick : 5000, missions, robots,
    `done=${done}, parked=${allParked}, occupiedBays=${occupiedBays}, distinctBays=${distinctBays}, allDone=${allDoneTick}, allClear=${allClearTick}, collisions=${collisions}`);
  result.passed = done === 11 && allParked && distinctBays && collisions === 0;
  return result;
}

function runStaleIdleAutoRehomeTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 8;
  scenario.simulation.routing = "reservation-table";
  scenario.simulation.collisionAvoidance = true;
  scenario.simulation.parkingStrategy = "home-slots";
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions: Mission[] = [];

  robots.forEach((robot, index) => {
    robot.position = {
      x: robot.homePosition.x + (index % 2 === 0 ? 0.8 : -0.8),
      z: robot.homePosition.z + 4 + (index % 3) * 0.4,
    };
    robot.state = "idle";
    robot.path = [];
    robot.pathIndex = 0;
    robot.missionId = undefined;
    robot.assignedParkingPosition = undefined;
    robot.assignedParkingBayId = undefined;
  });

  for (const bay of getParkingBays()) {
    bay.state = "free";
    bay.assignedRobotId = undefined;
  }

  const initialParkingError = maxDistanceFromAssignedParking(robots);
  const congestionMap = new Map<string, number>();
  let ticks = 0;
  for (ticks = 1; ticks <= 2000; ticks++) {
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, ticks);
    if (allRobotsAtOrganizedStandby(robots)) break;
  }

  const finalParkingError = maxDistanceFromHomeParking(robots);
  const allParked = allRobotsAtOrganizedStandby(robots);
  const result = summarize("stale-idle-auto-rehome-8robots", ticks, missions, robots,
    `initialErr=${initialParkingError.toFixed(2)}, finalErr=${finalParkingError.toFixed(2)}, parked=${allParked}`);
  result.passed = initialParkingError > 1 && finalParkingError <= 0.35 && allParked && result.totalDistance > 0;
  return result;
}

function runBlockedParkingReassignTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 4;
  scenario.simulation.routing = "reservation-table";
  scenario.simulation.collisionAvoidance = true;
  scenario.simulation.parkingStrategy = "farthest-free";
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const inbound = scenario.stations.find(s => s.type === "inbound") ?? scenario.stations[0];
  const source = chooseSourceSlot(slots);
  const mission = createManualMission(source, inbound.id, 0);
  const assigned = assignMissionToRobot(mission, robots[0], slots, []);
  if (!assigned.ok) return fail("blocked-parking-reassign", 0, [mission], robots, "assignment failed");

  const congestionMap = new Map<string, number>();
  const deliveryTick = runTicks(scenario, robots, [mission], slots, graph, 1200);
  if (mission.status !== "done") {
    return fail("blocked-parking-reassign", deliveryTick, [mission], robots, "mission not done");
  }

  robots[1].position = { ...robots[0].homePosition };
  robots[1].state = "idle";
  robots[1].assignedParkingPosition = { ...robots[0].homePosition };

  let ticks = deliveryTick;
  for (let i = 1; i <= 800; i++) {
    tickRobots(robots, [mission], slots, scenario, graph, congestionMap, true, ticks + i);
    if (robots[0].state === "idle" && robots[0].assignedParkingPosition) break;
  }
  ticks += 800;

  const r0Bay = robots[0].assignedParkingBayId;
  const r1Bay = robots[1].assignedParkingBayId;
  const noDuplicate = !r0Bay || !r1Bay || r0Bay !== r1Bay;
  const reassignments = getParkingReassignments();
  const result = summarize("blocked-parking-reassign", ticks, [mission], robots,
    `r0Bay=${r0Bay ?? "none"}, r1Bay=${r1Bay ?? "none"}, noDuplicate=${noDuplicate}, reassignments=${reassignments.length}`);
  result.passed = mission.status === "done" && noDuplicate && result.totalDistance > 0;
  return result;
}

function runDuplicateParkingReservationTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 6;
  scenario.simulation.routing = "reservation-table";
  scenario.simulation.collisionAvoidance = true;
  scenario.simulation.parkingStrategy = "farthest-free";
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const inbound = scenario.stations.find(s => s.type === "inbound") ?? scenario.stations[0];
  const sources = slots.filter(s => s.occupied).slice(0, 4);
  const missions = sources.map(s => createManualMission(s, inbound.id, 0));
  const existingMissions: typeof missions = [];
  for (let i = 0; i < Math.min(4, robots.length); i++) {
    const assigned = assignMissionToRobot(missions[i], robots[i], slots, existingMissions);
    if (!assigned.ok) return fail("duplicate-parking-reservation", 0, missions, robots, "assignment failed");
    existingMissions.push(missions[i]);
  }

  const congestionMap = new Map<string, number>();
  for (let tick = 1; tick <= 2500; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions, scenario, congestionMap);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    if (missions.every(m => m.status === "done") && allRobotsAtOrganizedStandby(robots)) break;
  }

  const assignedBayIds = robots.map(r => r.assignedParkingBayId).filter(Boolean);
  const uniqueBayIds = new Set(assignedBayIds);
  const noDuplicates = uniqueBayIds.size === assignedBayIds.length;

  const assignedPositions = robots.map(r => {
    const p = r.assignedParkingPosition ?? r.homePosition;
    return `${p.x.toFixed(1)}:${p.z.toFixed(1)}`;
  });
  const uniquePositions = new Set(assignedPositions);
  const noPositionDuplicates = uniquePositions.size === assignedPositions.length;

  const result = summarize("duplicate-parking-reservation", 2500, missions, robots,
    `uniqueBays=${uniqueBayIds.size}/${assignedBayIds.length}, noDuplicates=${noDuplicates}, noPosDupes=${noPositionDuplicates}`);
  result.passed = noDuplicates && noPositionDuplicates && result.totalDistance > 0;
  return result;
}

function runMissionCrossingParkingYieldTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 8;
  scenario.simulation.missionCount = 4;
  scenario.simulation.maxActiveMissions = 3;
  scenario.simulation.routing = "reservation-table";
  scenario.simulation.collisionAvoidance = true;
  scenario.simulation.parkingStrategy = "farthest-free";
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, scenario.simulation.missionCount, 0);
  assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions, scenario);

  const congestionMap = new Map<string, number>();
  const minDistance = robotRadius(scenario) * 2 + scenario.simulation.robotClearanceMeters;
  let collisions = 0;
  for (let tick = 1; tick <= 1500; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions, scenario, congestionMap);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    collisions += countRobotCollisions(robots, minDistance);
  }

  const events = getTrafficEvents();
  const yieldEvents = events.filter(e => e.type === "yield" || e.type === "priority-pass" || e.type === "cluster-resolve");
  const doneCount = missions.filter(m => m.status === "done").length;
  const result = summarize("mission-crossing-parking-yield", 1500, missions, robots,
    `collisions=${collisions}, yieldEvents=${yieldEvents.length}, done=${doneCount}`);
  result.passed = collisions === 0 && doneCount >= 1 && result.totalDistance > 0;
  return result;
}

function runTrafficStress12Robots20MissionsTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 12;
  scenario.simulation.missionCount = 20;
  scenario.simulation.maxActiveMissions = 8;
  scenario.simulation.routing = "reservation-table";
  scenario.simulation.allocator = "eta-optimal";
  scenario.simulation.collisionAvoidance = true;
  scenario.simulation.robotClearanceMeters = 0.2;
  scenario.robots.speedMetersPerSecond = 2.8;
  scenario.racks.crossAisleEveryBays = 3;
  scenario.racks.crossAisleWidth = 3.0;

  resetMissionCounter();
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, 20, 0);
  const congestionMap = new Map<string, number>();
  const minDistance = robotRadius(scenario) * 2 + scenario.simulation.robotClearanceMeters;
  let collisions = 0;
  let maxBlockedTicks = 0;

  for (let tick = 1; tick <= 6000; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions, scenario, congestionMap);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    collisions += countRobotCollisions(robots, minDistance);
    maxBlockedTicks = Math.max(maxBlockedTicks, ...robots.map(r => r.blockedTicks));
    if (missions.every(m => m.status === "done" || m.status === "failed")) break;
  }

  const done = missions.filter(m => m.status === "done").length;
  const physical = getPhysicalCollisionCount();
  const permanentDeadlock = robots.some(r => r.blockedTicks >= 200);
  const result = summarize("traffic-stress-12robots-20missions", 6000, missions, robots,
    `done=${done}, collisions=${collisions}, physical=${physical}, maxBlocked=${maxBlockedTicks}, deadlock=${permanentDeadlock}`);
  result.passed = collisions === 0 && physical === 0 && !permanentDeadlock && done === missions.length;
  return result;
}

function runAutoRampActiveMissionLimitTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 12;
  scenario.simulation.missionCount = 12;
  scenario.simulation.maxActiveMissions = 4;
  scenario.simulation.autoScaleActiveMissions = true;
  scenario.simulation.routing = "reservation-table";
  scenario.simulation.allocator = "nearest-robot";

  resetMissionCounter();
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const targetStations = scenario.stations.filter(st => st.type === "packing" || st.type === "inbound");
  const missions = slots
    .filter(slot => slot.occupied)
    .slice(0, scenario.simulation.missionCount)
    .map((slot, index) => createManualMission(slot, targetStations[index % targetStations.length].id, 0));

  const dynamicLimit = resolveActiveMissionLimit(missions, robots, scenario.simulation.maxActiveMissions, scenario);
  assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions, scenario);
  const dynamicAssigned = missions.filter(m => m.status === "assigned").length;

  const staticScenario = createDefaultScenario();
  staticScenario.robots.count = 12;
  staticScenario.simulation.missionCount = 12;
  staticScenario.simulation.maxActiveMissions = 4;
  staticScenario.simulation.autoScaleActiveMissions = false;
  staticScenario.simulation.routing = "reservation-table";
  staticScenario.simulation.allocator = "nearest-robot";
  resetMissionCounter();
  const staticSlots = generateSlots(staticScenario);
  const staticGraph = buildNavigationGraph(staticScenario);
  const staticRobots = initRobots(staticScenario);
  const staticStations = staticScenario.stations.filter(st => st.type === "packing" || st.type === "inbound");
  const staticMissions = staticSlots
    .filter(slot => slot.occupied)
    .slice(0, staticScenario.simulation.missionCount)
    .map((slot, index) => createManualMission(slot, staticStations[index % staticStations.length].id, 0));
  assignMissions(staticMissions, staticRobots, staticGraph, staticSlots, staticScenario.simulation.allocator, staticScenario.stations, staticScenario.simulation.maxActiveMissions, staticScenario);
  const staticAssigned = staticMissions.filter(m => m.status === "assigned").length;

  const result = summarize("auto-ramp-active-missions", 0, missions, robots,
    `staticAssigned=${staticAssigned}, dynamicAssigned=${dynamicAssigned}, dynamicLimit=${dynamicLimit}`);
  result.passed = staticAssigned === 4 && dynamicLimit > staticAssigned && dynamicAssigned > staticAssigned && dynamicAssigned <= dynamicLimit;
  return result;
}

function runHighShelfLiftLevelTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 1;
  scenario.robots.speedMetersPerSecond = 3.5;
  scenario.racks.levels = 4;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const inbound = scenario.stations.find(s => s.type === "inbound") ?? scenario.stations[0];

  const level4Slot = slots.find(s => s.occupied && s.levelIndex === 3);
  if (!level4Slot) {
    return fail("high-shelf-lift-level-check", 0, [], robots, "no slots at level 4");
  }

  const mission = createManualMission(level4Slot, inbound.id, 0);
  const assigned = assignMissionToRobot(mission, robots[0], slots, []);
  if (!assigned.ok) return fail("high-shelf-lift-level-check", 0, [mission], robots, "assignment failed");

  const congestionMap = new Map<string, number>();
  let sawTargetLevel4 = false;
  let sawExtending = false;
  let sawLoaded = false;
  let maxExt = 0;

  for (let tick = 1; tick <= 1200; tick++) {
    tickRobots(robots, [mission], slots, scenario, graph, congestionMap, true, tick);
    const lt = robots[0].liftTelemetry;
    if (lt.targetLevel === 3) sawTargetLevel4 = true;
    if (lt.payloadState === "extending") sawExtending = true;
    if (lt.payloadState === "loaded") sawLoaded = true;
    maxExt = Math.max(maxExt, lt.currentExtensionPct);
    if (mission.status === "done") break;
  }

  const result = summarize("high-shelf-lift-level-check", 1200, [mission], robots,
    `targetL4=${sawTargetLevel4}, extending=${sawExtending}, loaded=${sawLoaded}, maxExt=${maxExt.toFixed(0)}%`);
  result.passed = mission.status === "done" && sawTargetLevel4 && sawExtending && sawLoaded && maxExt >= 90;
  return result;
}

function runManyRobotsParkingBoundsTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 12;
  scenario.simulation.routing = "reservation-table";
  scenario.simulation.collisionAvoidance = true;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const halfW = scenario.warehouse.width / 2;
  const halfD = scenario.warehouse.depth / 2;

  const allInsideWarehouse = robots.every(r =>
    r.position.x > -halfW && r.position.x < halfW &&
    r.position.z > -halfD && r.position.z < halfD
  );
  const parkingBays = getParkingBays();
  const baysInsideWarehouse = parkingBays.every(b =>
    b.position.x > -halfW && b.position.x < halfW &&
    b.position.z > -halfD && b.position.z < halfD
  );
  const assignedBayIds = robots.map(r => r.assignedParkingBayId).filter(Boolean);
  const uniqueBayIds = new Set(assignedBayIds);
  const noDuplicateTarget = uniqueBayIds.size === assignedBayIds.length;

  const result = summarize("many-robots-parking-bounds", 0, [], robots,
    `inside=${allInsideWarehouse}, baysInside=${baysInsideWarehouse}, noDupe=${noDuplicateTarget}`);
  result.passed = allInsideWarehouse && baysInsideWarehouse && noDuplicateTarget;
  return result;
}

function runAccelerationBoundsTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 1;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const inbound = scenario.stations.find(s => s.type === "inbound") ?? scenario.stations[0];
  // Pick a far source slot so the robot has a long straight run to reach cruise speed.
  const source = slots.filter(s => s.occupied).sort((a, b) =>
    Math.hypot(b.position.x - robots[0].position.x, b.position.z - robots[0].position.z) -
    Math.hypot(a.position.x - robots[0].position.x, a.position.z - robots[0].position.z)
  )[0];
  const mission = createManualMission(source, inbound.id, 0);
  const assigned = assignMissionToRobot(mission, robots[0], slots, []);
  if (!assigned.ok) return fail("acceleration-deceleration-bounds", 0, [mission], robots, "assignment failed");

  const dt = scenario.simulation.tickMs / 1000;
  const maxAccel = scenario.robots.maxAccelerationMps2 ?? 2.4;
  const accelBound = maxAccel * dt;
  const maxSpeed = scenario.robots.speedMetersPerSecond;
  const congestionMap = new Map<string, number>();

  let prevSpeed = 0;
  let prevState = robots[0].state;
  let maxUpDelta = 0;
  let maxObservedSpeed = 0;
  let rampSamples = 0; // ticks at an intermediate cruising speed (proves gradual change)
  const movingStates = new Set(["to-pick", "to-drop", "to-point", "returning"]);

  for (let tick = 1; tick <= 1500; tick++) {
    tickRobots(robots, [mission], slots, scenario, graph, congestionMap, true, tick);
    const r = robots[0];
    const speed = r.currentSpeedMps ?? 0;
    const continuousMove = movingStates.has(r.state) && movingStates.has(prevState);
    if (continuousMove) {
      const up = speed - prevSpeed;
      if (up > maxUpDelta) maxUpDelta = up;
      if (speed > 0.1 && speed < maxSpeed * 0.95) rampSamples++;
    }
    maxObservedSpeed = Math.max(maxObservedSpeed, speed);
    prevSpeed = speed;
    prevState = r.state;
    if (mission.status === "done") break;
  }

  const boundsRespected = maxUpDelta <= accelBound * 1.25 + 0.01;
  const reachedCruise = maxObservedSpeed >= maxSpeed * 0.7;
  const gradual = rampSamples >= 3;
  const result = summarize("acceleration-deceleration-bounds", 1500, [mission], robots,
    `maxUpDelta=${maxUpDelta.toFixed(3)}, bound=${accelBound.toFixed(3)}, maxSpeed=${maxObservedSpeed.toFixed(2)}, rampSamples=${rampSamples}`);
  result.passed = mission.status === "done" && boundsRespected && reachedCruise && gradual;
  return result;
}

function runScissorLiftLevelExtensionTest(): TestResult {
  const peakStagesForLevel = (levelIndex: number): { stages: number; ext: number; done: boolean } => {
    const scenario = createDefaultScenario();
    scenario.robots.count = 1;
    scenario.racks.levels = 3;
    const slots = generateSlots(scenario);
    const graph = buildNavigationGraph(scenario);
    const robots = initRobots(scenario);
    const inbound = scenario.stations.find(s => s.type === "inbound") ?? scenario.stations[0];
    const slot = slots.find(s => s.occupied && s.levelIndex === levelIndex);
    if (!slot) return { stages: 0, ext: 0, done: false };
    const mission = createManualMission(slot, inbound.id, 0);
    const assigned = assignMissionToRobot(mission, robots[0], slots, []);
    if (!assigned.ok) return { stages: 0, ext: 0, done: false };
    const congestionMap = new Map<string, number>();
    let peakStages = 0;
    let peakExt = 0;
    for (let tick = 1; tick <= 1400; tick++) {
      tickRobots(robots, [mission], slots, scenario, graph, congestionMap, true, tick);
      peakStages = Math.max(peakStages, robots[0].liftTelemetry.activeStages);
      peakExt = Math.max(peakExt, robots[0].liftTelemetry.currentExtensionPct);
      if (mission.status === "done") break;
    }
    return { stages: peakStages, ext: peakExt, done: mission.status === "done" };
  };

  const l1 = peakStagesForLevel(0);
  const l2 = peakStagesForLevel(1);
  const l3 = peakStagesForLevel(2);

  const increasing = l1.stages < l2.stages && l2.stages < l3.stages;
  const allExtended = l1.ext > 50 && l2.ext > 50 && l3.ext > 50;
  const allDone = l1.done && l2.done && l3.done;

  const result: TestResult = {
    name: "scissor-lift-level-extension",
    passed: increasing && allExtended && allDone,
    ticks: 0,
    done: [l1, l2, l3].filter(x => x.done).length,
    failed: 0,
    moving: 0,
    totalDistance: 1,
    totalWait: 0,
    details: `stages L1=${l1.stages} L2=${l2.stages} L3=${l3.stages}, ext L1=${l1.ext.toFixed(0)} L2=${l2.ext.toFixed(0)} L3=${l3.ext.toFixed(0)}`,
  };
  return result;
}

function runOppositeDirectionLaneSeparationTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 2;
  scenario.simulation.routing = "reservation-table";
  scenario.simulation.collisionAvoidance = true;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const packA = scenario.stations.find(s => s.id === "PACK_A") ?? scenario.stations[0];
  const packB = scenario.stations.find(s => s.id === "PACK_B") ?? scenario.stations[0];

  // Force opposing travel: a left-side robot picks a right-side slot bound for the right
  // station, while a right-side robot picks a left-side slot bound for the left station.
  const occupied = slots.filter(s => s.occupied && s.levelIndex === 0);
  const rightSlot = occupied.filter(s => s.position.x > 8).sort((a, b) => a.position.z - b.position.z)[0];
  const leftSlot = occupied.filter(s => s.position.x < -8).sort((a, b) => a.position.z - b.position.z)[0];
  if (!rightSlot || !leftSlot) return fail("opposite-direction-lane-separation", 0, [], robots, "no opposing slots");

  const mA = createManualMission(rightSlot, packB.id, 0);
  const mB = createManualMission(leftSlot, packA.id, 0);
  if (!assignMissionToRobot(mA, robots[0], slots, []).ok) return fail("opposite-direction-lane-separation", 0, [mA], robots, "assign A failed");
  if (!assignMissionToRobot(mB, robots[1], slots, [mA]).ok) return fail("opposite-direction-lane-separation", 0, [mB], robots, "assign B failed");

  const missions = [mA, mB];
  const radius = robotRadius(scenario);
  const minSafe = radius * 2; // centers must never overlap footprints
  const congestionMap = new Map<string, number>();
  let collisions = 0;
  let minSeparation = Infinity;

  for (let tick = 1; tick <= 2500; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions, scenario, congestionMap);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    const sep = Math.hypot(robots[0].position.x - robots[1].position.x, robots[0].position.z - robots[1].position.z);
    minSeparation = Math.min(minSeparation, sep);
    if (sep < minSafe) collisions++;
    if (missions.every(m => m.status === "done")) break;
  }

  const done = missions.filter(m => m.status === "done").length;
  const result = summarize("opposite-direction-lane-separation", 2500, missions, robots,
    `done=${done}, minSeparation=${minSeparation.toFixed(2)}, minSafe=${minSafe.toFixed(2)}, collisions=${collisions}`);
  result.passed = collisions === 0 && done === 2 && minSeparation >= minSafe;
  return result;
}

function runStartupBurstNoCollisionsTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 12;
  scenario.simulation.missionCount = 10;
  scenario.simulation.routing = "reservation-table";
  scenario.simulation.collisionAvoidance = true;
  scenario.simulation.parkingStrategy = "home-slots";
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, 10, 0);
  const congestionMap = new Map<string, number>();

  for (let tick = 1; tick <= 300; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions, scenario, congestionMap);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
  }

  const physical = getPhysicalCollisionCount();
  const result = summarize("startup-burst-no-collisions", 300, missions, robots,
    `physicalCollisions=${physical}, moving=${robots.filter(r => r.state !== "idle").length}`);
  result.passed = physical === 0 && robots.some(r => r.totalDistance > 0);
  return result;
}

function runLongJuryDemoZeroCollisionsTest(): TestResult {
  // Mirrors the actual in-app Jury Demo (see startJuryDemo): 12 robots, 11 missions,
  // reservation-table routing, home-slot parking. Asserts every mission completes, every
  // robot returns to its original home slot, and there are zero physical collisions.
  const scenario = createDefaultScenario();
  scenario.robots.count = 12;
  scenario.simulation.routing = "reservation-table";
  scenario.simulation.allocator = "nearest-robot";
  scenario.simulation.collisionAvoidance = true;
  scenario.simulation.maxActiveMissions = 4;
  scenario.simulation.autoScaleActiveMissions = true;
  scenario.simulation.parkingStrategy = "home-slots";
  resetMissionCounter();
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, 11, 0);
  const congestionMap = new Map<string, number>();

  let allDoneTick = -1;
  let allHomeTick = -1;
  let physicalDuringRun = 0;
  for (let tick = 1; tick <= 6000; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions, scenario, congestionMap);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    physicalDuringRun = getPhysicalCollisionCount();
    if (allDoneTick < 0 && missions.every(m => m.status === "done")) allDoneTick = tick;
    if (allDoneTick > 0 && allRobotsAtOrganizedStandby(robots)) { allHomeTick = tick; break; }
  }

  const done = missions.filter(m => m.status === "done").length;
  const result = summarize("long-jury-demo-zero-collisions", allHomeTick > 0 ? allHomeTick : 6000, missions, robots,
    `done=${done}/11, allDone=${allDoneTick}, allHome=${allHomeTick}, physicalCollisions=${physicalDuringRun}`);
  result.passed = done === 11 && allDoneTick > 0 && allHomeTick > 0 && physicalDuringRun === 0;
  return result;
}

function runCollisionCounterNoInfiniteRepeatTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 2;
  const slots = generateSlots(scenario);
  buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  resetCollisionTracking();

  // Inject an artificial overlap and hold it for many ticks.
  robots[0].position = { x: 0, z: 0 };
  robots[1].position = { x: 0.1, z: 0 };
  for (let tick = 1; tick <= 12; tick++) __detectPhysicalCollisionsForTest(robots, scenario, tick);
  const heldCount = getPhysicalCollisionCount(); // expect exactly 1

  // Separate the robots; no new episodes.
  robots[1].position = { x: 12, z: 0 };
  for (let tick = 13; tick <= 18; tick++) __detectPhysicalCollisionsForTest(robots, scenario, tick);
  const afterSeparation = getPhysicalCollisionCount(); // still 1

  // Overlap again -> a distinct, second episode.
  robots[1].position = { x: 0.1, z: 0 };
  for (let tick = 19; tick <= 24; tick++) __detectPhysicalCollisionsForTest(robots, scenario, tick);
  const secondEpisode = getPhysicalCollisionCount(); // expect 2

  resetCollisionTracking();
  void slots;

  const result: TestResult = {
    name: "collision-counter-no-infinite-repeat",
    passed: heldCount === 1 && afterSeparation === 1 && secondEpisode === 2,
    ticks: 24, done: 0, failed: 0, moving: 0, totalDistance: 1, totalWait: 0,
    details: `heldOverlap12ticks=${heldCount}, afterSeparation=${afterSeparation}, secondEpisode=${secondEpisode}`,
  };
  return result;
}

function runNoPathThroughRacksTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 8;
  scenario.simulation.missionCount = 10;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, 10, 0);
  const congestionMap = new Map<string, number>();

  // Raw solids (no extra margin) = the literal rack/post/station/wall geometry.
  const solids = buildSolidObstacles(scenario);
  let badSegments = 0;
  let checkedRobots = 0;
  // Sample planned paths over the early part of the run as robots pick up missions.
  for (let tick = 1; tick <= 250; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions, scenario, congestionMap);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    if (tick % 25 !== 0) continue;
    for (const robot of robots) {
      if (robot.path.length < 3) continue;
      checkedRobots++;
      // Skip the final approach segment (legitimately ends at the shelf face / station).
      for (let i = robot.pathIndex; i < robot.path.length - 2; i++) {
        if (!isClearSegment(robot.path[i], robot.path[i + 1], solids)) badSegments++;
      }
    }
  }

  const result = summarize("no-path-through-racks-or-posts", 0, missions, robots,
    `checkedRobots=${checkedRobots}, badSegments=${badSegments}`);
  result.passed = checkedRobots > 0 && badSegments === 0;
  result.totalDistance = Math.max(result.totalDistance, 1);
  return result;
}

function runStartupLaunchSpacingTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 12;
  scenario.simulation.missionCount = 11;
  scenario.simulation.routing = "reservation-table";
  scenario.simulation.collisionAvoidance = true;
  scenario.simulation.parkingStrategy = "home-slots";
  resetMissionCounter();
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, 11, 0);
  const congestionMap = new Map<string, number>();
  const minSafe = robotRadius(scenario) * 2; // robot footprints must never overlap

  let assignedAtTick1 = 0;
  let movedAtTick1 = 0;
  let maxHeldObserved = 0;
  let spacingViolations = 0;

  for (let tick = 1; tick <= 300; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions, scenario, congestionMap);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    if (tick === 1) {
      assignedAtTick1 = robots.filter(r => r.missionId !== undefined).length;
      movedAtTick1 = robots.filter(r => r.totalDistance > 0.001).length;
    }
    maxHeldObserved = Math.max(maxHeldObserved, getStartupDispatchStats().heldNow);
    spacingViolations += countRobotCollisions(robots, minSafe);
  }

  const physical = getPhysicalCollisionCount();
  const progressed = missions.filter(m => m.status !== "queued").length;
  const result = summarize("startup-launch-spacing", 300, missions, robots,
    `assigned@t1=${assignedAtTick1}, moved@t1=${movedAtTick1}, maxHeld=${maxHeldObserved}, spacingViolations=${spacingViolations}, physical=${physical}, progressed=${progressed}`);
  result.passed =
    assignedAtTick1 >= 4 &&
    movedAtTick1 < assignedAtTick1 &&
    maxHeldObserved >= 1 &&
    physical === 0 &&
    spacingViolations === 0 &&
    progressed > 0 &&
    robots.some(r => r.totalDistance > 1);
  return result;
}

/** Place two robots in the same parking column: index 0 deep in the bay, index 1 nearer the exit. */
function stackTwoRobotsInParkingColumn(robots: RobotRuntime[], scenario: WarehouseScenario, spacingMeters: number) {
  const halfD = scenario.warehouse.depth / 2;
  const colX = robots[0].homePosition.x;
  const backZ = -halfD + 3.4;
  const frontZ = backZ + spacingMeters;
  robots[0].position = { x: colX, z: backZ };
  robots[0].homePosition = { x: colX, z: backZ };
  robots[0].assignedParkingPosition = { x: colX, z: backZ };
  robots[1].position = { x: colX, z: frontZ };
  robots[1].homePosition = { x: colX, z: frontZ };
  robots[1].assignedParkingPosition = { x: colX, z: frontZ };
}

function runClosestToExitPriorityTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 2;
  scenario.simulation.routing = "reservation-table";
  scenario.simulation.collisionAvoidance = true;
  scenario.simulation.parkingStrategy = "home-slots";
  scenario.simulation.maxActiveMissions = 2;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  stackTwoRobotsInParkingColumn(robots, scenario, 2.6);

  const inbound = scenario.stations.find(s => s.type === "inbound") ?? scenario.stations[0];
  const sources = slots.filter(s => s.occupied && s.levelIndex === 0).slice(0, 2);
  if (sources.length < 2) return fail("closest-to-exit-priority", 0, [], robots, "not enough source slots");
  const mBack = createManualMission(sources[0], inbound.id, 0);
  const mFront = createManualMission(sources[1], inbound.id, 0);
  if (!assignMissionToRobot(mBack, robots[0], slots, []).ok) return fail("closest-to-exit-priority", 0, [mBack], robots, "assign back failed");
  if (!assignMissionToRobot(mFront, robots[1], slots, [mBack]).ok) return fail("closest-to-exit-priority", 0, [mFront], robots, "assign front failed");
  const missions = [mBack, mFront];
  const congestionMap = new Map<string, number>();
  const minSafe = robotRadius(scenario) * 2;

  let frontFirstMove = -1;
  let backFirstMove = -1;
  let backHeldWhileFrontMoved = false;
  let collisions = 0;

  for (let tick = 1; tick <= 2000; tick++) {
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    if (frontFirstMove < 0 && robots[1].totalDistance > 0.05) frontFirstMove = tick;
    if (backFirstMove < 0 && robots[0].totalDistance > 0.05) backFirstMove = tick;
    if (robots[0].launchCleared === false && robots[1].totalDistance > 0.05) backHeldWhileFrontMoved = true;
    collisions += countRobotCollisions(robots, minSafe);
    if (missions.every(m => m.status === "done")) break;
  }

  const result = summarize("closest-to-exit-priority", 2000, missions, robots,
    `frontFirstMove=${frontFirstMove}, backFirstMove=${backFirstMove}, backHeldWhileFrontMoved=${backHeldWhileFrontMoved}, collisions=${collisions}`);
  result.passed =
    frontFirstMove > 0 &&
    backFirstMove > frontFirstMove &&
    backHeldWhileFrontMoved &&
    collisions === 0;
  return result;
}

function runNoStartupDeadlockTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 12;
  scenario.simulation.routing = "reservation-table";
  scenario.simulation.allocator = "nearest-robot";
  scenario.simulation.collisionAvoidance = true;
  scenario.simulation.maxActiveMissions = 4;
  scenario.simulation.autoScaleActiveMissions = true;
  scenario.simulation.parkingStrategy = "home-slots";
  resetMissionCounter();
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, 11, 0);
  const congestionMap = new Map<string, number>();

  let allDoneTick = -1;
  let allHomeTick = -1;
  for (let tick = 1; tick <= 6000; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions, scenario, congestionMap);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    if (allDoneTick < 0 && missions.every(m => m.status === "done")) allDoneTick = tick;
    if (allDoneTick > 0 && allRobotsAtOrganizedStandby(robots)) { allHomeTick = tick; break; }
  }

  const sd = getStartupDispatchStats();
  const stillHeld = robots.filter(r => r.launchCleared === false).length;
  const done = missions.filter(m => m.status === "done").length;
  const physical = getPhysicalCollisionCount();
  const result = summarize("no-startup-deadlock", allHomeTick > 0 ? allHomeTick : 6000, missions, robots,
    `done=${done}/11, allDone=${allDoneTick}, allHome=${allHomeTick}, holds=${sd.totalHolds}, clearances=${sd.totalClearances}, stillHeld=${stillHeld}, physical=${physical}`);
  result.passed =
    done === 11 &&
    allDoneTick > 0 &&
    allHomeTick > 0 &&
    physical === 0 &&
    stillHeld === 0 &&
    sd.heldNow === 0 &&
    sd.totalHolds >= 1; // launch control actually engaged, then released every hold
  return result;
}

function runStartupSpeedGovernorTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 2;
  scenario.simulation.routing = "reservation-table";
  scenario.simulation.collisionAvoidance = true;
  scenario.simulation.parkingStrategy = "home-slots";
  scenario.simulation.maxActiveMissions = 2;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  // Tighter than normal bay spacing so the rear robot starts inside the unsafe band.
  stackTwoRobotsInParkingColumn(robots, scenario, 2.0);

  const inbound = scenario.stations.find(s => s.type === "inbound") ?? scenario.stations[0];
  const sources = slots.filter(s => s.occupied && s.levelIndex === 0).slice(0, 2);
  if (sources.length < 2) return fail("startup-speed-governor", 0, [], robots, "not enough source slots");
  const mBack = createManualMission(sources[0], inbound.id, 0);
  const mFront = createManualMission(sources[1], inbound.id, 0);
  if (!assignMissionToRobot(mBack, robots[0], slots, []).ok) return fail("startup-speed-governor", 0, [mBack], robots, "assign back failed");
  if (!assignMissionToRobot(mFront, robots[1], slots, [mBack]).ok) return fail("startup-speed-governor", 0, [mFront], robots, "assign front failed");
  const missions = [mBack, mFront];
  const congestionMap = new Map<string, number>();

  const dt = scenario.simulation.tickMs / 1000;
  const maxSpeed = scenario.robots.speedMetersPerSecond;
  const maxAccel = scenario.robots.maxAccelerationMps2 ?? 2.4;
  const accelBound = maxAccel * dt;
  const radius = robotRadius(scenario);
  const clearance = scenario.simulation.robotClearanceMeters ?? 0.12;
  const unsafeDistance = radius * 2 + clearance + 0.9;
  const maxStepBound = maxSpeed * dt * 1.5; // anything beyond this would be a teleport

  let governedZeroTickSeen = false;
  let maxBackSpeedWhileClose = 0;
  let maxDisplacement = 0;
  let maxUpDelta = 0;
  const prevPositions = robots.map(r => ({ ...r.position }));
  const prevSpeeds = robots.map(r => r.currentSpeedMps ?? 0);
  const prevStates = robots.map(r => r.state as string);
  const movingStates = new Set(["to-pick", "to-drop", "to-point", "returning"]);

  for (let tick = 1; tick <= 1200; tick++) {
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    const separation = Math.hypot(
      robots[0].position.x - robots[1].position.x,
      robots[0].position.z - robots[1].position.z
    );
    const backSpeed = robots[0].currentSpeedMps ?? 0;
    // The startup governor applies while the rear robot is still launching from its bay.
    const launchZone = Math.max(4.5, radius * 5);
    const backInLaunchZone =
      (robots[0].state === "to-pick" || robots[0].state === "to-point") &&
      Math.hypot(
        robots[0].position.x - robots[0].homePosition.x,
        robots[0].position.z - robots[0].homePosition.z
      ) <= launchZone;
    if (separation < unsafeDistance && backInLaunchZone) {
      maxBackSpeedWhileClose = Math.max(maxBackSpeedWhileClose, backSpeed);
      if (backSpeed <= 0.001) governedZeroTickSeen = true;
    }
    for (let i = 0; i < robots.length; i++) {
      const moved = Math.hypot(
        robots[i].position.x - prevPositions[i].x,
        robots[i].position.z - prevPositions[i].z
      );
      maxDisplacement = Math.max(maxDisplacement, moved);
      const speed = robots[i].currentSpeedMps ?? 0;
      if (movingStates.has(robots[i].state) && movingStates.has(prevStates[i])) {
        maxUpDelta = Math.max(maxUpDelta, speed - prevSpeeds[i]);
      }
      prevPositions[i] = { ...robots[i].position };
      prevSpeeds[i] = speed;
      prevStates[i] = robots[i].state;
    }
    if (missions.every(m => m.status === "done")) break;
  }

  const result = summarize("startup-speed-governor", 1200, missions, robots,
    `governedZeroTick=${governedZeroTickSeen}, maxBackSpeedClose=${maxBackSpeedWhileClose.toFixed(2)}, maxStep=${maxDisplacement.toFixed(3)}/${maxStepBound.toFixed(3)}, maxUpDelta=${maxUpDelta.toFixed(3)}/${accelBound.toFixed(3)}`);
  result.passed =
    governedZeroTickSeen &&
    maxBackSpeedWhileClose <= maxSpeed * 0.75 &&
    maxDisplacement <= maxStepBound &&
    maxUpDelta <= accelBound * 1.25 + 0.01;
  return result;
}

type PackStressMetrics = {
  doneCount: number;
  missionTotal: number;
  allDoneTick: number;
  allHomeTick: number;
  physical: number;
  spacingViolations: number;
  maxQueueDepth: number;
  distinctBays: boolean;
  robots: RobotRuntime[];
  missions: Mission[];
};

/** 12 robots, 10 missions all bound for one packing station; run to full completion + re-park. */
function runPackStationStress(stationId: string): PackStressMetrics {
  const scenario = createDefaultScenario();
  scenario.robots.count = 12;
  scenario.simulation.routing = "reservation-table";
  scenario.simulation.collisionAvoidance = true;
  scenario.simulation.parkingStrategy = "home-slots";
  scenario.simulation.allocator = "nearest-robot";
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const station = scenario.stations.find(s => s.id === stationId)!;
  const sources = slots
    .filter(s => s.occupied && s.levelIndex === 0)
    .sort((a, b) =>
      Math.hypot(a.position.x - station.position.x, a.position.z - station.position.z) -
      Math.hypot(b.position.x - station.position.x, b.position.z - station.position.z))
    .slice(0, 10);
  const missions = sources.map(slot => createManualMission(slot, stationId, 0));
  const congestionMap = new Map<string, number>();
  const minSafe = robotRadius(scenario) * 2;

  let spacingViolations = 0;
  let maxQueueDepth = 0;
  let allDoneTick = -1;
  let allHomeTick = -1;
  for (let tick = 1; tick <= 9000; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions, scenario, congestionMap);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    spacingViolations += countRobotCollisions(robots, minSafe);
    const queue = getStationQueues().find(q => q.stationId === stationId);
    if (queue) maxQueueDepth = Math.max(maxQueueDepth, queue.occupiedBy.length);
    if (allDoneTick < 0 && missions.every(m => m.status === "done")) allDoneTick = tick;
    if (allDoneTick > 0 && allRobotsAtOrganizedStandby(robots)) { allHomeTick = tick; break; }
  }

  const bayIds = new Set(robots.map(r => r.assignedParkingBayId ?? `none-${r.id}`));
  return {
    doneCount: missions.filter(m => m.status === "done").length,
    missionTotal: missions.length,
    allDoneTick,
    allHomeTick,
    physical: getPhysicalCollisionCount(),
    spacingViolations,
    maxQueueDepth,
    distinctBays: bayIds.size === robots.length,
    robots,
    missions,
  };
}

function runPackAStressTest(m: PackStressMetrics): TestResult {
  const result = summarize("packa-12robots-10missions-no-collisions", m.allHomeTick > 0 ? m.allHomeTick : 9000, m.missions, m.robots,
    `done=${m.doneCount}/${m.missionTotal}, allDone=${m.allDoneTick}, allHome=${m.allHomeTick}, physical=${m.physical}, spacingViolations=${m.spacingViolations}`);
  result.passed =
    m.doneCount === m.missionTotal &&
    m.allDoneTick > 0 &&
    m.allHomeTick > 0 &&
    m.physical === 0 &&
    m.spacingViolations === 0;
  return result;
}

function runPackAQueueTest(m: PackStressMetrics): TestResult {
  const result = summarize("packa-station-queue-multi-robot", m.allHomeTick > 0 ? m.allHomeTick : 9000, m.missions, m.robots,
    `maxQueueDepth=${m.maxQueueDepth}, done=${m.doneCount}/${m.missionTotal}, physical=${m.physical}`);
  result.passed = m.maxQueueDepth >= 2 && m.doneCount === m.missionTotal && m.physical === 0;
  return result;
}

function runPackAReturnDistinctBaysTest(m: PackStressMetrics): TestResult {
  const allParked = m.allHomeTick > 0 && allRobotsAtOrganizedStandby(m.robots);
  const result = summarize("packa-return-distinct-bays", m.allHomeTick > 0 ? m.allHomeTick : 9000, m.missions, m.robots,
    `allParked=${allParked}, distinctBays=${m.distinctBays}, allHome=${m.allHomeTick}`);
  result.passed = allParked && m.distinctBays;
  return result;
}

function runPackSymmetryTest(a: PackStressMetrics, b: PackStressMetrics): TestResult {
  const bothComplete = a.doneCount === a.missionTotal && b.doneCount === b.missionTotal &&
    a.allHomeTick > 0 && b.allHomeTick > 0;
  const ratio = bothComplete
    ? Math.max(a.allDoneTick, b.allDoneTick) / Math.max(1, Math.min(a.allDoneTick, b.allDoneTick))
    : Infinity;
  const result = summarize("packa-packb-symmetry-stress", Math.max(a.allHomeTick, b.allHomeTick), [...a.missions, ...b.missions], a.robots,
    `A: done=${a.doneCount} allDone=${a.allDoneTick} physical=${a.physical} | B: done=${b.doneCount} allDone=${b.allDoneTick} physical=${b.physical} | ratio=${ratio.toFixed(2)}`);
  result.passed =
    bothComplete &&
    a.physical === 0 && b.physical === 0 &&
    a.spacingViolations === 0 && b.spacingViolations === 0 &&
    ratio <= 1.6;
  return result;
}

function runPackAMissionCrossingParkingTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 12;
  scenario.simulation.routing = "reservation-table";
  scenario.simulation.collisionAvoidance = true;
  scenario.simulation.parkingStrategy = "home-slots";
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);

  // Deepest robot on the Pack A side: its launch corridor crosses the left parking depot.
  const deepRobot = [...robots].sort((a, b) =>
    (a.homePosition.x - b.homePosition.x) || (a.homePosition.z - b.homePosition.z))[0];
  const source = slots
    .filter(s => s.occupied && s.levelIndex === 0)
    .sort((a, b) => a.position.x - b.position.x)[0];
  if (!source) return fail("packa-mission-crossing-parking-yield", 0, [], robots, "no source slot");
  const mission = createManualMission(source, "PACK_A", 0);
  if (!assignMissionToRobot(mission, deepRobot, slots, []).ok) {
    return fail("packa-mission-crossing-parking-yield", 0, [mission], robots, "assignment failed");
  }

  const congestionMap = new Map<string, number>();
  const minSafe = robotRadius(scenario) * 2;
  let collisions = 0;
  let crossedNearParked = false;
  let ticksUsed = 4000;

  for (let tick = 1; tick <= 4000; tick++) {
    tickRobots(robots, [mission], slots, scenario, graph, congestionMap, true, tick);
    collisions += countRobotCollisions(robots, minSafe);
    if (!crossedNearParked && (deepRobot.state === "to-pick" || deepRobot.state === "to-drop")) {
      crossedNearParked = robots.some(r =>
        r.id !== deepRobot.id &&
        Math.hypot(deepRobot.position.x - r.homePosition.x, deepRobot.position.z - r.homePosition.z) < 4
      );
    }
    if (mission.status === "done" && allRobotsAtOrganizedStandby(robots)) { ticksUsed = tick; break; }
  }

  const allHome = allRobotsAtOrganizedStandby(robots);
  const result = summarize("packa-mission-crossing-parking-yield", ticksUsed, [mission], robots,
    `done=${mission.status}, crossedNearParked=${crossedNearParked}, collisions=${collisions}, allHome=${allHome}`);
  result.passed = mission.status === "done" && crossedNearParked && collisions === 0 && allHome;
  return result;
}

function runNoDiagonalPathsTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 12;
  scenario.simulation.missionCount = 10;
  resetMissionCounter();
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, 10, 0);
  const congestionMap = new Map<string, number>();

  // Yielding escape pockets are deliberately free-form; every planned mission/return path
  // must be strictly axis-aligned.
  const checkedStates = new Set(["to-pick", "to-drop", "to-point", "returning", "to-charge"]);
  let diagonalSegments = 0;
  let checkedSegments = 0;
  let allHome = false;

  for (let tick = 1; tick <= 4000; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions, scenario, congestionMap);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    if (tick % 10 === 0) {
      for (const robot of robots) {
        if (!checkedStates.has(robot.state)) continue;
        for (let i = Math.max(1, robot.pathIndex); i < robot.path.length; i++) {
          const a = robot.path[i - 1];
          const b = robot.path[i];
          checkedSegments++;
          if (Math.abs(a.x - b.x) > 0.06 && Math.abs(a.z - b.z) > 0.06) diagonalSegments++;
        }
      }
    }
    if (missions.every(m => m.status === "done") && allRobotsAtOrganizedStandby(robots)) { allHome = true; break; }
  }

  const result = summarize("no-diagonal-paths", 4000, missions, robots,
    `checkedSegments=${checkedSegments}, diagonalSegments=${diagonalSegments}, allHome=${allHome}`);
  result.passed = checkedSegments > 50 && diagonalSegments === 0;
  return result;
}

function runPackANoPathThroughObstaclesTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 12;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const station = scenario.stations.find(s => s.id === "PACK_A")!;
  const sources = slots
    .filter(s => s.occupied && s.levelIndex === 0)
    .sort((a, b) =>
      Math.hypot(a.position.x - station.position.x, a.position.z - station.position.z) -
      Math.hypot(b.position.x - station.position.x, b.position.z - station.position.z))
    .slice(0, 10);
  const missions = sources.map(slot => createManualMission(slot, "PACK_A", 0));
  const congestionMap = new Map<string, number>();
  const solids = buildSolidObstacles(scenario);
  const halfW = scenario.warehouse.width / 2;
  const halfD = scenario.warehouse.depth / 2;
  const radius = robotRadius(scenario);

  let badSegments = 0;
  let outOfBoundsWaypoints = 0;
  let checkedRobots = 0;
  for (let tick = 1; tick <= 400; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions, scenario, congestionMap);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    if (tick % 25 !== 0) continue;
    for (const robot of robots) {
      if (robot.path.length < 3) continue;
      checkedRobots++;
      for (let i = robot.pathIndex; i < robot.path.length - 2; i++) {
        if (!isClearSegment(robot.path[i], robot.path[i + 1], solids)) badSegments++;
      }
      for (const point of robot.path.slice(robot.pathIndex)) {
        if (
          point.x < -halfW + radius * 0.5 || point.x > halfW - radius * 0.5 ||
          point.z < -halfD + radius * 0.5 || point.z > halfD - radius * 0.5
        ) {
          outOfBoundsWaypoints++;
        }
      }
    }
  }

  const result = summarize("packa-no-path-through-obstacles", 400, missions, robots,
    `checkedRobots=${checkedRobots}, badSegments=${badSegments}, outOfBounds=${outOfBoundsWaypoints}`);
  result.passed = checkedRobots > 0 && badSegments === 0 && outOfBoundsWaypoints === 0;
  result.totalDistance = Math.max(result.totalDistance, 1);
  return result;
}

function runDirectionalLaneRoutingTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 2;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const ext = computeWarehouseExtents(scenario);
  const aisleCenterZ = ext.rackBlockStartZ + scenario.racks.rowPitch / 2;
  const halfAisle = scenario.racks.aisleWidth / 2;

  // Planner-level check: east and west traversals of the same rack aisle must use
  // different (directional) lanes.
  const dominantLaneZ = (path: { x: number; z: number }[]): number | undefined => {
    const zs: number[] = [];
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      if (Math.abs(b.x - a.x) < 1.5) continue;
      const z = (a.z + b.z) / 2;
      if (Math.abs(z - aisleCenterZ) > halfAisle) continue;
      if (Math.max(a.x, b.x) < -20 || Math.min(a.x, b.x) > 20) continue;
      zs.push(z);
    }
    if (zs.length === 0) return undefined;
    return zs.reduce((s, z) => s + z, 0) / zs.length;
  };
  const eastPath = pathToPoint(graph, { x: -26, z: aisleCenterZ }, { x: 26, z: aisleCenterZ });
  const westPath = pathToPoint(graph, { x: 26, z: aisleCenterZ }, { x: -26, z: aisleCenterZ });
  const eastLaneZ = dominantLaneZ(eastPath);
  const westLaneZ = dominantLaneZ(westPath);
  const lanesSeparated =
    eastLaneZ !== undefined && westLaneZ !== undefined &&
    eastLaneZ < aisleCenterZ && westLaneZ > aisleCenterZ &&
    westLaneZ - eastLaneZ > 2.0;

  // Live check: two robots crossing the same aisle in opposite directions at once.
  for (const [i, x] of [-26, 26].entries()) {
    robots[i].position = { x, z: aisleCenterZ };
    robots[i].homePosition = { x, z: aisleCenterZ };
    robots[i].assignedParkingPosition = { x, z: aisleCenterZ };
  }
  const mA = createMoveToPointMission({ x: 26, z: aisleCenterZ }, 0);
  const mB = createMoveToPointMission({ x: -26, z: aisleCenterZ }, 0);
  if (!assignMissionToRobot(mA, robots[0], slots, []).ok) return fail("directional-lane-routing", 0, [mA], robots, "assign A failed");
  if (!assignMissionToRobot(mB, robots[1], slots, [mA]).ok) return fail("directional-lane-routing", 0, [mB], robots, "assign B failed");
  const missions = [mA, mB];
  const congestionMap = new Map<string, number>();
  const minSafe = robotRadius(scenario) * 2;
  let collisions = 0;
  let minSeparation = Infinity;
  let ticksUsed = 1500;
  for (let tick = 1; tick <= 1500; tick++) {
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    const sep = Math.hypot(robots[0].position.x - robots[1].position.x, robots[0].position.z - robots[1].position.z);
    minSeparation = Math.min(minSeparation, sep);
    collisions += countRobotCollisions(robots, minSafe);
    if (missions.every(m => m.status === "done")) { ticksUsed = tick; break; }
  }

  const result = summarize("directional-lane-routing", ticksUsed, missions, robots,
    `eastLaneZ=${eastLaneZ?.toFixed(2)}, westLaneZ=${westLaneZ?.toFixed(2)}, center=${aisleCenterZ.toFixed(2)}, lanesSeparated=${lanesSeparated}, minSep=${minSeparation.toFixed(2)}, collisions=${collisions}`);
  result.passed =
    lanesSeparated &&
    missions.every(m => m.status === "done") &&
    collisions === 0 &&
    minSeparation >= minSafe;
  return result;
}

function runMissionEstimationAnalysisTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 12;
  scenario.simulation.missionCount = 10;
  resetMissionCounter();
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, 10, 0);
  const congestionMap = new Map<string, number>();

  let ticksUsed = 6000;
  for (let tick = 1; tick <= 6000; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions, scenario, congestionMap, tick);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    if (missions.every(m => m.status === "done")) { ticksUsed = tick; break; }
  }

  const records = getMissionAnalysis();
  const allRecorded = records.length === missions.length;
  const allDone = records.every(r => r.status === "done");
  const fieldsValid = records.every(r =>
    r.actualTimeTicks > 0 &&
    r.actualDistance > 0 &&
    (r.estimatedTimeTicks ?? 0) > 0 &&
    (r.estimatedDistance ?? 0) > 0 &&
    r.assignedAtTick >= 0 &&
    r.completedAtTick > r.assignedAtTick &&
    r.delayTicks === r.actualTimeTicks - (r.estimatedTimeTicks ?? 0) &&
    Array.isArray(r.problems)
  );
  const estimatesAtAssignment = missions.every(m => (m.assignedAtTick ?? 0) >= 1 && (m.estimatedTime ?? 0) > 0);

  const result = summarize("mission-estimation-analysis", ticksUsed, missions, robots,
    `records=${records.length}/${missions.length}, fieldsValid=${fieldsValid}, estimatesAtAssignment=${estimatesAtAssignment}, withProblems=${records.filter(r => r.problems.length > 0).length}`);
  result.passed = allRecorded && allDone && fieldsValid && estimatesAtAssignment &&
    missions.every(m => m.status === "done");
  return result;
}

function runRoundTripBoxReturnTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 1;
  scenario.robots.speedMetersPerSecond = 3.2;
  scenario.simulation.returnBoxesToShelf = true;
  scenario.simulation.operatorProcessTicks = 60;
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const inbound = scenario.stations.find(s => s.type === "inbound") ?? scenario.stations[0];
  const source = chooseSourceSlot(slots);
  const mission = createManualMission(source, inbound.id, 0);
  if (!assignMissionToRobot(mission, robots[0], slots, [], scenario, 0).ok) {
    return fail("roundtrip-box-return", 0, [mission], robots, "assignment failed");
  }
  const oneWayEstimate = mission.estimatedDistance ?? 0;

  const congestionMap = new Map<string, number>();
  let boxHiddenWhileCarried = false;
  let operatorWaitSeen = false;
  let returnLegSeen = false;
  let ticksUsed = 3000;
  for (let tick = 1; tick <= 3000; tick++) {
    tickRobots(robots, [mission], slots, scenario, graph, congestionMap, true, tick);
    if (robots[0].carryingSlotId && !source.occupied) boxHiddenWhileCarried = true;
    if (mission.statusNote?.includes("operator processing")) operatorWaitSeen = true;
    if (mission.returnLeg) returnLegSeen = true;
    if (mission.status === "done" && robots[0].state === "idle" &&
        Math.hypot(robots[0].position.x - robots[0].homePosition.x, robots[0].position.z - robots[0].homePosition.z) <= 0.35) {
      ticksUsed = tick;
      break;
    }
  }

  const boxBackOnShelf = source.occupied === true;
  const result = summarize("roundtrip-box-return", ticksUsed, [mission], robots,
    `boxHidden=${boxHiddenWhileCarried}, operatorWait=${operatorWaitSeen}, returnLeg=${returnLegSeen}, boxBack=${boxBackOnShelf}, dist=${mission.distanceMeters.toFixed(1)} est=${mission.estimatedDistance}`);
  result.passed =
    mission.status === "done" &&
    boxHiddenWhileCarried &&
    operatorWaitSeen &&
    returnLegSeen &&
    boxBackOnShelf &&
    oneWayEstimate > 0 &&
    mission.distanceMeters > 0;
  return result;
}

function runChargingDockCycleTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 12; // full registry so rear bays exist near the charger
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  // Nearly empty battery: the robot must drive to the charger, dock, charge to a safe
  // level, then park at the nearest free bay (rear bays beside the charger) instead of
  // trekking back across the warehouse.
  robots[0].batteryMinutes = 4.5;
  const threshold = scenario.simulation.lowBatteryThreshold ?? 15;
  const charger = scenario.stations.find(s => s.type === "charging")!;

  const congestionMap = new Map<string, number>();
  const minSafe = robotRadius(scenario) * 2;
  let sawToCharge = false;
  let sawCharging = false;
  let collisions = 0;
  let ticksUsed = 5000;
  for (let tick = 1; tick <= 5000; tick++) {
    tickRobots(robots, [], slots, scenario, graph, congestionMap, true, tick);
    sawToCharge ||= robots[0].state === "to-charge";
    sawCharging ||= robots[0].state === "charging";
    collisions += countRobotCollisions(robots, minSafe);
    const target = robots[0].assignedParkingPosition ?? robots[0].homePosition;
    const parkDist = Math.hypot(robots[0].position.x - target.x, robots[0].position.z - target.z);
    const othersSettled = robots.slice(1).every(r =>
      r.state === "idle" &&
      Math.hypot(r.position.x - r.homePosition.x, r.position.z - r.homePosition.z) <= 0.35
    );
    if (sawCharging && robots[0].state === "idle" && parkDist <= 0.35 && othersSettled) {
      ticksUsed = tick;
      break;
    }
  }

  const target = robots[0].assignedParkingPosition ?? robots[0].homePosition;
  const parkDist = Math.hypot(robots[0].position.x - target.x, robots[0].position.z - target.z);
  const bayNearCharger =
    Math.hypot(target.x - charger.position.x, target.z - charger.position.z) <
    Math.hypot(robots[0].homePosition.x - charger.position.x, robots[0].homePosition.z - charger.position.z) * 0.6;
  const othersStayedParked = robots.slice(1).every(r =>
    r.state === "idle" &&
    Math.hypot(r.position.x - r.homePosition.x, r.position.z - r.homePosition.z) <= 0.35
  );
  const result = summarize("charging-dock-cycle", ticksUsed, [], robots,
    `sawToCharge=${sawToCharge}, sawCharging=${sawCharging}, battery=${robots[0].batteryMinutes.toFixed(1)}, parkDist=${parkDist.toFixed(2)}, tempBay=${robots[0].usingTemporaryBay === true}, bayNearCharger=${bayNearCharger}, othersParked=${othersStayedParked}, collisions=${collisions}`);
  result.passed =
    sawToCharge &&
    sawCharging &&
    robots[0].state === "idle" &&
    parkDist <= 0.35 &&
    robots[0].usingTemporaryBay === true &&
    bayNearCharger &&
    othersStayedParked &&
    robots[0].batteryMinutes >= threshold * 2 - 1 &&
    collisions === 0;
  return result;
}

function runNoEndgameTeleportTest(): TestResult {
  const scenario = createDefaultScenario();
  scenario.robots.count = 12;
  scenario.simulation.missionCount = 4;
  resetMissionCounter();
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const missions = generateMissions(scenario, slots, 4, 0);
  const congestionMap = new Map<string, number>();

  // The old final-auto-dock teleported returning robots across the warehouse once the
  // wave completed. No robot may ever move further than a small recovery hop per tick.
  // One motion step per tick (plus float slack). The old 3.5 m limit tolerated the
  // docking snap and the multi-metre reverseOneStep teleport.
  const maxAllowedHop = scenario.robots.speedMetersPerSecond * (scenario.simulation.tickMs / 1000) * 1.02 + 1e-6;
  let maxHop = 0;
  const prev = robots.map(r => ({ ...r.position }));
  let allHomeTick = -1;
  for (let tick = 1; tick <= 4000; tick++) {
    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations, scenario.simulation.maxActiveMissions, scenario, congestionMap, tick);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, true, tick);
    for (let i = 0; i < robots.length; i++) {
      const hop = Math.hypot(robots[i].position.x - prev[i].x, robots[i].position.z - prev[i].z);
      maxHop = Math.max(maxHop, hop);
      prev[i] = { ...robots[i].position };
    }
    if (missions.every(m => m.status === "done") && allRobotsAtOrganizedStandby(robots)) { allHomeTick = tick; break; }
  }

  const result = summarize("no-endgame-teleport", allHomeTick > 0 ? allHomeTick : 4000, missions, robots,
    `maxHop=${maxHop.toFixed(2)}m (limit ${maxAllowedHop}m), allHome=${allHomeTick}`);
  result.passed =
    missions.every(m => m.status === "done") &&
    allHomeTick > 0 &&
    maxHop <= maxAllowedHop;
  return result;
}


/**
 * Regression: robots used to converge on the single charger dock (capacity 6, one
 * physical dock point) and trade yields forever. Four drained robots must be served one
 * at a time from FIFO queue slots, all must charge, and none may touch another.
 */
function runChargerQueueFifoTest(): TestResult {
  const scenario = createDefaultScenario();
  normalizeScenarioGeometry(scenario);
  resetCollisionTracking();
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const charger = scenario.stations.find(s => s.type === "charging")!;
  const drained = [...robots]
    .sort((a, b) => Math.hypot(a.homePosition.x - charger.position.x, a.homePosition.z - charger.position.z) -
      Math.hypot(b.homePosition.x - charger.position.x, b.homePosition.z - charger.position.z))
    .slice(0, 4);
  for (const r of drained) r.batteryMinutes = 6;
  const congestionMap = new Map<string, number>();
  const charged = new Set<number>();
  let maxCharging = 0;
  let maxQueued = 0;
  let ticks = 9000;
  for (let tick = 1; tick <= 9000; tick++) {
    tickRobots(robots, [], slots, scenario, graph, congestionMap, true, tick);
    const charging = robots.filter(r => r.state === "charging");
    maxCharging = Math.max(maxCharging, charging.length);
    for (const r of charging) charged.add(r.id);
    maxQueued = Math.max(maxQueued, robots.filter(r => r.state === "to-charge").length);
    if (charged.size === drained.length && robots.every(r => r.state === "idle")) { ticks = tick; break; }
  }
  const result = summarize("charger-queue-fifo", ticks, [], robots,
    `charged=${charged.size}/${drained.length}, maxCharging=${maxCharging}, maxQueued=${maxQueued}, physical=${getPhysicalCollisionCount()}`);
  result.passed = charged.size === drained.length && maxCharging === 1 && getPhysicalCollisionCount() === 0 &&
    drained.every(r => r.batteryMinutes >= (scenario.simulation.lowBatteryThreshold ?? 15));
  return result;
}

/**
 * Regression: a robot with battery below the low threshold used to be handed new work
 * (assignment runs before the tick that sends it to charge), so busy fleets never let it
 * charge. With a charger present it must not be assigned.
 */
function runLowBatteryNotAssignedTest(): TestResult {
  const scenario = createDefaultScenario();
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario).slice(0, 2);
  robots[0].batteryMinutes = (scenario.simulation.lowBatteryThreshold ?? 15) - 2;
  const missions = generateMissions(scenario, slots, 2, 0);
  assignMissions(missions, robots, graph, slots, "nearest-robot", scenario.stations, 4, scenario);
  const lowRobotAssigned = missions.some(m => m.assignedRobotId === robots[0].id);
  const result = summarize("low-battery-robot-not-assigned", 0, missions, robots,
    `floor=${assignmentBatteryFloor(scenario)}, lowRobotAssigned=${lowRobotAssigned}, healthyAssigned=${missions.some(m => m.assignedRobotId === robots[1].id)}`);
  result.passed = !lowRobotAssigned && missions.some(m => m.assignedRobotId === robots[1].id);
  return result;
}

/**
 * Regression: the station load cap ignored missions in the "picking" phase, so more
 * missions than the dock + queue could hold were sent to one station.
 */
function runStationGateCountsPickingTest(): TestResult {
  const scenario = createDefaultScenario();
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  const station = scenario.stations.find(s => s.id === "PACK_A")!;
  const missions = generateMissions(scenario, slots, 10, 0);
  for (const m of missions) m.targetStationId = station.id;
  // Pretend dock + queue are already committed: robots in the lifting phase.
  const busy = missions.slice(0, station.queueCapacity + 1);
  busy.forEach((m, i) => { m.status = "picking"; m.assignedRobotId = robots[i].id; robots[i].state = "picking"; robots[i].missionId = m.id; });
  assignMissions(missions, robots, graph, slots, "nearest-robot", scenario.stations, 20, scenario);
  const extra = missions.filter(m => m.status === "assigned").length;
  const result = summarize("station-gate-counts-picking", 0, missions, robots, `inFlight=${busy.length}, newlyAssigned=${extra}`);
  result.passed = extra === 0;
  return result;
}

/**
 * Regression: routes from off-graph positions joined the plain nearest graph node with
 * a straight segment that could cut through a station bollard or rack corner; the robot
 * then waited at the obstacle forever and every replan rebuilt the same connector. Every
 * segment of a planned route must be passable for the robot body (motion clearance).
 */
function runPathConnectorsBodyClearTest(): TestResult {
  const scenario = createDefaultScenario();
  normalizeScenarioGeometry(scenario);
  const graph = buildNavigationGraph(scenario);
  const solids = buildSolidObstacles(scenario);
  const radius = robotRadius(scenario);
  const bodyHits = (a: { x: number; z: number }, b: { x: number; z: number }) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      if (solids.some(r => circleIntersectsRect(x, z, radius - 0.02, r))) return true;
    }
    return false;
  };
  const free = (x: number, z: number) => !solids.some(r => circleIntersectsRect(x, z, radius + 0.02, r));
  let checked = 0;
  let bad = 0;
  const examples: string[] = [];
  for (const station of scenario.stations) {
    for (let dx = -6; dx <= 6; dx += 0.75) {
      for (let dz = -5; dz <= 5; dz += 0.75) {
        const from = { x: station.position.x + dx, z: station.position.z + dz };
        if (!free(from.x, from.z)) continue;
        if (Math.abs(from.x) > scenario.warehouse.width / 2 - radius - 0.3 || Math.abs(from.z) > scenario.warehouse.depth / 2 - radius - 0.3) continue;
        for (const target of scenario.stations) {
          if (target.id === station.id) continue;
          const path = pathToStation(graph, from, target);
          checked++;
          for (let i = 1; i < path.length; i++) {
            if (bodyHits(path[i - 1], path[i])) {
              bad++;
              if (examples.length < 3) examples.push(`${station.id}+(${dx},${dz})->${target.id}`);
              break;
            }
          }
        }
      }
    }
  }
  const result = summarize("path-connectors-body-clear", 0, [], [], `routes=${checked}, impassable=${bad} ${examples.join(" ")}`);
  result.passed = checked > 200 && bad === 0;
  return result;
}

/**
 * Regression bundle: the instrumented stress scenarios that reproduced the original
 * failures (multi-metre teleports, 13 000+ tick deadlocks in 40/60-mission batches, the
 * charger corner livelock, depot row livelocks). Each must finish every mission, park,
 * never move faster than one motion step per tick, and never touch another robot.
 */
function runReproducedFailureStressTests(): TestResult[] {
  const names = ["large-batch-12r-40m", "large-fleet-20r-60m", "low-battery-fleet-12r-20m", "single-station-12r-24m-PACK_A", "raw-layout-11-missions"];
  return names.map(name => {
    const report = runStressCase(STRESS_CASES.find(c => c.name === name)!);
    return {
      name: `stress-${name}`,
      passed: report.passed,
      ticks: report.allParkedTick,
      done: report.done,
      failed: report.failed,
      moving: report.missions - report.done,
      totalDistance: 0,
      totalWait: 0,
      details: `${report.failures.join("; ") || "ok"} maxHop=${report.maxHop} stall=${report.maxMissionStallTicks}/${report.maxReturnStallTicks}`,
    };
  });
}

const packAStress = runPackStationStress("PACK_A");
const packBStress = runPackStationStress("PACK_B");

const results: TestResult[] = [
  runManualMission("default-manual-inbound", () => {}),
  runManualMission("compact-cross-aisles", scenario => {
    scenario.racks.rowCount = 6;
    scenario.racks.baysPerRow = 8;
    scenario.racks.crossAisleEveryBays = 2;
    scenario.racks.crossAisleWidth = 3.5;
    scenario.robots.count = 6;
    scenario.robots.speedMetersPerSecond = 2.8;
    scenario.robots.footprintWidth = 1.1;
    scenario.robots.footprintDepth = 1.0;
  }),
  runGeneratedMissionBatch("generated-10-robots-6-missions", scenario => {
    scenario.robots.count = 10;
    scenario.robots.speedMetersPerSecond = 3.2;
    scenario.simulation.missionCount = 6;
    scenario.simulation.allocator = "nearest-robot";
    scenario.simulation.maxActiveMissions = 3;
    scenario.simulation.robotClearanceMeters = 0.08;
    scenario.racks.crossAisleEveryBays = 3;
    scenario.racks.crossAisleWidth = 3.0;
  }),
  runDuplicateSourceReservationTest(),
  runMissionChainingTest(),
  runNoReturnBetweenQueuedMissionsTest(),
  runUnassignedRobotsStayParkedTest(),
  runReturnToStandbyTest(),
  runIdleAwayAutoRehomeTest(),
  runMoveToPointTest(),
  runHighShelfLiftTest(),
  runCollisionPredictionStressTest(),
  runLargeRackAutoFitGeometryTest(),
  runRobotRackCollisionTest(),
  runRobotWallCollisionTest(),
  runRobotStationCollisionTest(),
  runRobotColumnCollisionTest(),
  runHeadOnYieldPocketTest(),
  runDeadlockDetectionTest(),
  runStationQueueTest(),
  runTimeWindowReservationTest(),
  runLiftTelemetryTest(),
  runTraceRecordingTest(),
  runSameStationQueueConflictTest(),
  runNarrowAislePassingTest(),
  runLoadedVsEmptyPriorityTest(),
  runNoRepeatedYieldLoopTest(),
  runYieldBayGenerationTest(),
  runPredictiveVsNormalTest(),
  runPhysicalQueueSlotsTest(),
  runThreeRobotChainConflictTest(),
  runParkingExitConflictTest(),
  runTwoRobotsSameAislePassingTest(),
  runPredictiveNoCollisionComparisonTest(),
  runTenMissionDefaultRegressionTest(),
  run12Robots11MissionsAllParkedTest(),
  runStaleIdleAutoRehomeTest(),
  runBlockedParkingReassignTest(),
  runDuplicateParkingReservationTest(),
  runMissionCrossingParkingYieldTest(),
  runTrafficStress12Robots20MissionsTest(),
  runAutoRampActiveMissionLimitTest(),
  runHighShelfLiftLevelTest(),
  runManyRobotsParkingBoundsTest(),
  runAccelerationBoundsTest(),
  runScissorLiftLevelExtensionTest(),
  runOppositeDirectionLaneSeparationTest(),
  runStartupBurstNoCollisionsTest(),
  runStartupLaunchSpacingTest(),
  runClosestToExitPriorityTest(),
  runNoStartupDeadlockTest(),
  runStartupSpeedGovernorTest(),
  runCollisionCounterNoInfiniteRepeatTest(),
  runNoPathThroughRacksTest(),
  runLongJuryDemoZeroCollisionsTest(),
  runPackAStressTest(packAStress),
  runPackAQueueTest(packAStress),
  runPackAReturnDistinctBaysTest(packAStress),
  runPackSymmetryTest(packAStress, packBStress),
  runPackAMissionCrossingParkingTest(),
  runNoDiagonalPathsTest(),
  runPackANoPathThroughObstaclesTest(),
  runDirectionalLaneRoutingTest(),
  runMissionEstimationAnalysisTest(),
  runRoundTripBoxReturnTest(),
  runChargingDockCycleTest(),
  runNoEndgameTeleportTest(),
  runChargerQueueFifoTest(),
  runLowBatteryNotAssignedTest(),
  runStationGateCountsPickingTest(),
  runPathConnectorsBodyClearTest(),
  ...runReproducedFailureStressTests(),
];

function countRobotCollisions(robots: RobotRuntime[], minDistance: number): number {
  let collisions = 0;
  for (let i = 0; i < robots.length; i++) {
    for (let j = i + 1; j < robots.length; j++) {
      const a = robots[i];
      const b = robots[j];
      if (Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z) < minDistance) {
        collisions++;
      }
    }
  }
  return collisions;
}

for (const result of results) {
  console.log(JSON.stringify({
    ...result,
    totalDistance: Number(result.totalDistance.toFixed(1)),
  }));
}

if (results.some(result => !result.passed)) {
  process.exitCode = 1;
}
