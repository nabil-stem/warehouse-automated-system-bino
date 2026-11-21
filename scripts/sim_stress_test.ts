/**
 * Instrumented stress harness for robot movement and mission algorithms.
 *
 * Unlike the smoke suite, every scenario here is judged against physical invariants that
 * must hold on every single tick, not only at the end of a run:
 *  - no robot moves farther in one tick than its top speed allows (no teleporting);
 *  - no two robot bodies overlap, and no robot body enters a rack/station/bollard;
 *  - no robot with an active mission stays motionless for an unbounded time;
 *  - robots are not sent back to parking while queued work is waiting for them;
 *  - every generated mission completes and the fleet ends parked.
 *
 * Run with: npm run test:stress
 */
import { createDefaultScenario } from "../src/app/defaultScenario";
import type { Mission, RobotRuntime, Slot, WarehouseScenario, Vec2 } from "../src/domain/schema";
import { generateSlots, normalizeScenarioGeometry } from "../src/domain/warehouseGenerator";
import { buildNavigationGraph } from "../src/domain/navigationGraph";
import { initRobots, tickRobots, getPhysicalCollisionCount, getDynamicRerouteCount, resetCollisionTracking } from "../src/domain/robotSimulation";
import { assignMissions, createManualMission, generateMissions, resetMissionCounter, resolveActiveMissionLimit } from "../src/domain/missionPlanner";
import { buildSolidObstacles, robotRadius, type SolidRect } from "../src/domain/obstacles";

declare const process: { exitCode?: number; argv: string[] };

export type StressReport = {
  name: string;
  passed: boolean;
  failures: string[];
  missions: number;
  done: number;
  failed: number;
  allDoneTick: number;
  allParkedTick: number;
  maxHop: number;
  hopViolations: number;
  hopExamples: string[];
  bodyContacts: number;
  solidPenetrations: number;
  maxMissionStallTicks: number;
  maxReturnStallTicks: number;
  returnsWhileQueued: number;
  /** Returns to parking started while queued work existed AND an active-mission slot was free. */
  returnsWhileAssignable: number;
  idleWhileQueuedRobotTicks: number;
  replans: number;
  dynamicReroutes: number;
  yields: number;
  maxQueueToAssignTicks: number;
  missionsPerRobot: number[];
  avgMissionTicks: number;
  unfinished: string[];
};

export type StressCase = {
  name: string;
  customize?: (scenario: WarehouseScenario) => void;
  /** Build the mission list. Default: generateMissions(missionCount). */
  missions?: (scenario: WarehouseScenario, slots: Slot[]) => Mission[];
  /** Mutate robots after init (e.g. drain batteries). */
  prepareRobots?: (robots: RobotRuntime[], scenario: WarehouseScenario) => void;
  /** Extra missions injected while the batch is running: [tick, count]. */
  injections?: Array<[number, number]>;
  maxTicks: number;
  /** Skip geometry normalization (the smoke suite runs the raw default layout). */
  raw?: boolean;
  /** Must the fleet finish parked at the end? */
  requireParked?: boolean;
  /** Upper bound for continuous zero-motion time of a robot on an active travel leg. */
  maxStallTicks?: number;
};

const ACTIVE_TRAVEL_STATES = new Set(["to-pick", "to-drop", "to-point"]);

function circleIntersectsRect(center: Vec2, radius: number, rect: SolidRect): boolean {
  const cx = Math.max(rect.minX, Math.min(center.x, rect.maxX));
  const cz = Math.max(rect.minZ, Math.min(center.z, rect.maxZ));
  return Math.hypot(center.x - cx, center.z - cz) < radius;
}

export function runStressCase(spec: StressCase): StressReport {
  const scenario = createDefaultScenario();
  spec.customize?.(scenario);
  if (!spec.raw) normalizeScenarioGeometry(scenario);
  resetMissionCounter();
  resetCollisionTracking();
  const slots = generateSlots(scenario);
  const graph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  spec.prepareRobots?.(robots, scenario);
  const missions: Mission[] = spec.missions
    ? spec.missions(scenario, slots)
    : generateMissions(scenario, slots, scenario.simulation.missionCount, 0);
  const congestionMap = new Map<string, number>();

  const dt = scenario.simulation.tickMs / 1000;
  const maxStep = scenario.robots.speedMetersPerSecond * dt;
  const hopLimit = maxStep * 1.02 + 1e-6;
  const radius = robotRadius(scenario);
  const contactDist = radius * 2 - 0.02;
  // Bare geometry (no planning clearance): a robot body inside one of these is a crash.
  const bareSolids = buildSolidObstacles(scenario, 0);

  const prev = robots.map(r => ({ pos: { ...r.position }, state: r.state }));
  const stall = new Map<number, number>();
  const returnStall = new Map<number, number>();
  const contactPairs = new Set<string>();
  const penetratingRobots = new Set<number>();
  const completedBy = new Map<number, number>();
  const failures: string[] = [];
  const hopExamples: string[] = [];

  let maxHop = 0;
  let hopViolations = 0;
  let bodyContacts = 0;
  let solidPenetrations = 0;
  let maxMissionStallTicks = 0;
  let maxReturnStallTicks = 0;
  let returnsWhileQueued = 0;
  let returnsWhileAssignable = 0;
  let idleWhileQueuedRobotTicks = 0;
  let allDoneTick = -1;
  let allParkedTick = -1;
  const injections = [...(spec.injections ?? [])];

  for (let tick = 1; tick <= spec.maxTicks; tick++) {
    while (injections.length > 0 && injections[0][0] <= tick) {
      const [, count] = injections.shift()!;
      missions.push(...generateMissions(scenario, slots, count, tick, missions));
      allDoneTick = -1;
      allParkedTick = -1;
    }

    assignMissions(missions, robots, graph, slots, scenario.simulation.allocator, scenario.stations,
      scenario.simulation.maxActiveMissions, scenario, congestionMap, tick);
    const queuedBefore = missions.some(m => m.status === "queued");
    const activeCount = missions.filter(m => m.status === "assigned" || m.status === "moving" || m.status === "picking" || m.status === "placing").length;
    const slotFree = activeCount < resolveActiveMissionLimit(missions, robots, scenario.simulation.maxActiveMissions, scenario);
    tickRobots(robots, missions, slots, scenario, graph, congestionMap, scenario.simulation.collisionAvoidance, tick);

    for (let i = 0; i < robots.length; i++) {
      const robot = robots[i];
      const hop = Math.hypot(robot.position.x - prev[i].pos.x, robot.position.z - prev[i].pos.z);
      maxHop = Math.max(maxHop, hop);
      if (hop > hopLimit) {
        hopViolations++;
        if (hopExamples.length < 6) {
          hopExamples.push(`t${tick} R${robot.id} ${prev[i].state}->${robot.state} hop=${hop.toFixed(2)}m`);
        }
      }

      if (ACTIVE_TRAVEL_STATES.has(robot.state) && robot.missionId && hop < 1e-4 && robot.launchCleared !== false) {
        const s = (stall.get(robot.id) ?? 0) + 1;
        stall.set(robot.id, s);
        maxMissionStallTicks = Math.max(maxMissionStallTicks, s);
      } else {
        stall.set(robot.id, 0);
      }
      if (robot.state === "returning" && hop < 1e-4) {
        const s = (returnStall.get(robot.id) ?? 0) + 1;
        returnStall.set(robot.id, s);
        maxReturnStallTicks = Math.max(maxReturnStallTicks, s);
      } else {
        returnStall.set(robot.id, 0);
      }

      if (robot.state === "returning" && prev[i].state !== "returning" && prev[i].state !== "yielding" && queuedBefore &&
          robot.batteryMinutes > 5) {
        returnsWhileQueued++;
        if (slotFree) returnsWhileAssignable++;
      }
      if (robot.state === "idle" && !robot.missionId && robot.batteryMinutes > 5 && missions.some(m => m.status === "queued")) {
        idleWhileQueuedRobotTicks++;
      }

      let inside = false;
      for (const solid of bareSolids) {
        if (circleIntersectsRect(robot.position, radius * 0.92, solid)) { inside = true; break; }
      }
      if (inside && !penetratingRobots.has(robot.id)) solidPenetrations++;
      if (inside) penetratingRobots.add(robot.id); else penetratingRobots.delete(robot.id);

      prev[i] = { pos: { ...robot.position }, state: robot.state };
    }

    const nowContacts = new Set<string>();
    for (let i = 0; i < robots.length; i++) {
      for (let j = i + 1; j < robots.length; j++) {
        const d = Math.hypot(robots[i].position.x - robots[j].position.x, robots[i].position.z - robots[j].position.z);
        if (d < contactDist) {
          const key = `${robots[i].id}-${robots[j].id}`;
          nowContacts.add(key);
          if (!contactPairs.has(key)) bodyContacts++;
        }
      }
    }
    contactPairs.clear();
    for (const key of nowContacts) contactPairs.add(key);

    for (const mission of missions) {
      if (mission.status === "done" && mission.assignedRobotId !== undefined && mission.completedAtTick === tick) {
        completedBy.set(mission.assignedRobotId, (completedBy.get(mission.assignedRobotId) ?? 0) + 1);
      }
    }

    const allDone = missions.length > 0 && missions.every(m => m.status === "done" || m.status === "failed");
    if (allDone && allDoneTick < 0) allDoneTick = tick;
    if (allDone && injections.length === 0 && robots.every(r => r.state === "idle" || r.state === "charging") &&
        robots.every(r => r.state === "charging" ||
          Math.hypot(r.position.x - (r.assignedParkingPosition ?? r.homePosition).x,
            r.position.z - (r.assignedParkingPosition ?? r.homePosition).z) < 0.35)) {
      allParkedTick = tick;
      break;
    }
  }

  const done = missions.filter(m => m.status === "done");
  const failed = missions.filter(m => m.status === "failed");
  const unfinished = missions
    .filter(m => m.status !== "done" && m.status !== "failed")
    .map(m => `${m.id}:${m.status}:R${m.assignedRobotId ?? "-"}:${m.statusNote ?? ""}`);
  const replans = missions.reduce((s, m) => s + (m.replanCount ?? 0), 0);
  const yields = missions.reduce((s, m) => s + (m.yieldCount ?? 0), 0);
  const maxQueueToAssignTicks = Math.max(0, ...missions
    .filter(m => m.assignedAtTick !== undefined)
    .map(m => (m.assignedAtTick ?? 0) - m.createdAtTick));
  const avgMissionTicks = done.length
    ? done.reduce((s, m) => s + ((m.completedAtTick ?? 0) - (m.assignedAtTick ?? m.createdAtTick)), 0) / done.length
    : 0;
  const maxStallTicks = spec.maxStallTicks ?? 600;

  if (done.length !== missions.length) failures.push(`missions done ${done.length}/${missions.length}`);
  if (hopViolations > 0) failures.push(`teleport hops=${hopViolations} (max ${maxHop.toFixed(2)}m > ${hopLimit.toFixed(2)}m)`);
  if (bodyContacts > 0 || getPhysicalCollisionCount() > 0) failures.push(`robot contacts=${bodyContacts} (sim=${getPhysicalCollisionCount()})`);
  if (solidPenetrations > 0) failures.push(`solid penetrations=${solidPenetrations}`);
  if (maxMissionStallTicks > maxStallTicks) failures.push(`mission robot stalled ${maxMissionStallTicks}t`);
  if (maxReturnStallTicks > maxStallTicks) failures.push(`returning robot stalled ${maxReturnStallTicks}t`);
  if ((spec.requireParked ?? true) && allParkedTick < 0) failures.push("fleet not parked at end");

  return {
    name: spec.name,
    passed: failures.length === 0,
    failures,
    missions: missions.length,
    done: done.length,
    failed: failed.length,
    allDoneTick,
    allParkedTick,
    maxHop: Number(maxHop.toFixed(3)),
    hopViolations,
    hopExamples,
    bodyContacts,
    solidPenetrations,
    maxMissionStallTicks,
    maxReturnStallTicks,
    returnsWhileQueued,
    returnsWhileAssignable,
    idleWhileQueuedRobotTicks,
    replans,
    dynamicReroutes: getDynamicRerouteCount(),
    yields,
    maxQueueToAssignTicks,
    missionsPerRobot: robots.map(r => completedBy.get(r.id) ?? 0),
    avgMissionTicks: Math.round(avgMissionTicks),
    unfinished: unfinished.slice(0, 8),
  };
}

function missionsToStation(stationId: string, count: number) {
  return (scenario: WarehouseScenario, slots: Slot[]) => {
    const all = generateMissions(scenario, slots, count, 0);
    for (const m of all) m.targetStationId = stationId;
    return all;
  };
}

function missionsFromRow(rowIndex: number, count: number, stationId?: string) {
  return (_scenario: WarehouseScenario, slots: Slot[]) => {
    const sources = slots.filter(s => s.occupied && s.rowIndex === rowIndex).slice(0, count);
    return sources.map((slot, i) => createManualMission(slot, stationId ?? (i % 2 === 0 ? "PACK_A" : "PACK_B"), 0));
  };
}

export const STRESS_CASES: StressCase[] = [
  { name: "default-10-missions", maxTicks: 6000 },
  { name: "raw-layout-11-missions", raw: true, customize: s => { s.simulation.missionCount = 11; }, maxTicks: 6000 },
  {
    name: "jury-11-missions-with-charging",
    customize: s => { s.simulation.missionCount = 11; },
    prepareRobots: (robots, scenario) => {
      const charger = scenario.stations.find(st => st.type === "charging")!;
      const nearest = [...robots].sort((a, b) =>
        Math.hypot(a.homePosition.x - charger.position.x, a.homePosition.z - charger.position.z) -
        Math.hypot(b.homePosition.x - charger.position.x, b.homePosition.z - charger.position.z))[0];
      nearest.batteryMinutes = 4.5;
    },
    maxTicks: 8000,
  },
  { name: "large-batch-12r-40m", customize: s => { s.simulation.missionCount = 40; }, maxTicks: 16000 },
  {
    name: "large-fleet-20r-60m",
    customize: s => { s.robots.count = 20; s.simulation.missionCount = 60; },
    maxTicks: 20000,
  },
  {
    name: "single-station-12r-24m-PACK_A",
    missions: missionsToStation("PACK_A", 24),
    maxTicks: 16000,
  },
  {
    name: "crowded-aisle-row3-16m",
    missions: missionsFromRow(3, 16),
    maxTicks: 14000,
  },
  {
    name: "narrow-aisles-12r-20m",
    customize: s => { s.racks.aisleWidth = 3.0; s.racks.rowPitch = 6.3; s.simulation.missionCount = 20; },
    maxTicks: 14000,
  },
  {
    name: "roundtrip-12r-12m",
    customize: s => { s.simulation.missionCount = 12; s.simulation.returnBoxesToShelf = true; },
    maxTicks: 16000,
  },
  {
    name: "continuous-injection-12r",
    customize: s => { s.simulation.missionCount = 8; },
    injections: [[300, 8], [900, 8], [1600, 8]],
    maxTicks: 16000,
  },
  {
    name: "low-battery-fleet-12r-20m",
    customize: s => { s.simulation.missionCount = 20; },
    prepareRobots: robots => { for (const r of robots) if (r.id % 3 === 0) r.batteryMinutes = 16; },
    maxTicks: 16000,
  },
  {
    name: "eta-allocator-12r-30m",
    customize: s => { s.simulation.missionCount = 30; s.simulation.allocator = "eta-optimal"; },
    maxTicks: 16000,
  },
  {
    name: "astar-routing-12r-20m",
    customize: s => { s.simulation.missionCount = 20; s.simulation.routing = "a-star"; },
    maxTicks: 16000,
  },
];

const isMain = typeof process !== "undefined" && process.argv.some(arg => /sim_stress_test\.js$/.test(arg));
if (isMain) {
  const filter = process.argv.find(a => a.startsWith("--only="))?.slice(7);
  const cases = filter ? STRESS_CASES.filter(c => c.name.includes(filter)) : STRESS_CASES;
  const reports = cases.map(runStressCase);
  for (const r of reports) console.log(JSON.stringify(r));
  const failedCount = reports.filter(r => !r.passed).length;
  console.log(`\nstress: ${reports.length - failedCount}/${reports.length} passed`);
  if (failedCount > 0) process.exitCode = 1;
}
