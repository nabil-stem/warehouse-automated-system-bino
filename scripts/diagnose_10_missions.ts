import { createDefaultScenario } from "../src/app/defaultScenario";
import { generateSlots } from "../src/domain/warehouseGenerator";
import { buildNavigationGraph } from "../src/domain/navigationGraph";
import { initRobots, tickRobots, getTrafficEvents, getDeadlockStats } from "../src/domain/robotSimulation";
import { assignMissions, generateMissions, resetMissionCounter } from "../src/domain/missionPlanner";
import { computeMetrics } from "../src/domain/metrics";

const scenario = createDefaultScenario();
scenario.simulation.timeScale = 5;
scenario.simulation.missionCount = 10;
scenario.simulation.maxActiveMissions = 4;
scenario.simulation.routing = "reservation-table";
scenario.simulation.allocator = "nearest-robot";

resetMissionCounter();
const slots = generateSlots(scenario);
const graph = buildNavigationGraph(scenario);
const robots = initRobots(scenario);
const missions = generateMissions(scenario, slots, scenario.simulation.missionCount, 0);
const congestionMap = new Map<string, number>();

let allDoneTick = -1;
let allClearTick = -1;
let maxBlocked = 0;
let maxWait = 0;

for (let tick = 1; tick <= 6000; tick++) {
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
  maxBlocked = Math.max(maxBlocked, ...robots.map(robot => robot.blockedTicks));
  maxWait = Math.max(maxWait, ...missions.map(mission => mission.waitTicks));

  if (allDoneTick < 0 && missions.every(mission => mission.status === "done" || mission.status === "failed")) {
    allDoneTick = tick;
  }
  if (allDoneTick > 0 && robots.every(robot => robot.state === "idle" || robot.state === "charging")) {
    allClearTick = tick;
    break;
  }
}

const metrics = computeMetrics(robots, missions, slots, congestionMap, Math.max(allClearTick, allDoneTick, 6000), scenario.simulation.tickMs, [], scenario.stations);
const byStatus = missions.reduce<Record<string, number>>((acc, mission) => {
  acc[mission.status] = (acc[mission.status] ?? 0) + 1;
  return acc;
}, {});

console.log(JSON.stringify({
  missions: byStatus,
  allDoneTick,
  allClearTick,
  maxBlocked,
  maxWait,
  activeRobots: metrics.activeRobots,
  avgWait: metrics.avgWaitTime,
  deadlocks: getDeadlockStats(),
  events: getTrafficEvents().reduce<Record<string, number>>((acc, event) => {
    acc[event.type] = (acc[event.type] ?? 0) + 1;
    return acc;
  }, {}),
  robots: robots.map(robot => ({
    id: robot.id,
    state: robot.state,
    missionId: robot.missionId,
    blockedTicks: robot.blockedTicks,
    waitTicks: robot.totalWaitTicks,
    pos: {
      x: Number(robot.position.x.toFixed(1)),
      z: Number(robot.position.z.toFixed(1)),
    },
    home: {
      x: Number(robot.homePosition.x.toFixed(1)),
      z: Number(robot.homePosition.z.toFixed(1)),
    },
    pathIndex: robot.pathIndex,
    pathLength: robot.path.length,
    next: robot.path[robot.pathIndex]
      ? {
        x: Number(robot.path[robot.pathIndex].x.toFixed(1)),
        z: Number(robot.path[robot.pathIndex].z.toFixed(1)),
      }
      : undefined,
  })),
  unfinished: missions.filter(mission => mission.status !== "done" && mission.status !== "failed").map(mission => ({
    id: mission.id,
    status: mission.status,
    assignedRobotId: mission.assignedRobotId,
    sourceSlotId: mission.sourceSlotId,
    targetStationId: mission.targetStationId,
    waitTicks: mission.waitTicks,
    note: mission.statusNote,
  })),
}, null, 2));
