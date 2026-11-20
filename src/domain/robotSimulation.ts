import type { RobotRuntime, Mission, Slot, WarehouseScenario, NavGraph, Vec2, StationQueueState, RobotState, TrafficEvent, AisleLaneConfig, PhysicalQueueSlot, SupervisorDecision, SupervisorCommand, ParkingBayInfo, ParkingReassignment, ParkingStrategy, CollisionState, LaunchDecision, StartupDispatchStats, MissionAnalysisRecord } from "./schema";
import { pathToPoint, pathToSlot, pathToStation, findNearestNodeId, aStar, pathToSlotPredictive, pathToStationPredictive, pathToPointPredictive, type CongestionContext } from "./navigationGraph";
import { buildSolidObstacles, isClearSegment, pointInsideSolid, robotRadius, stationApproachPosition, type SolidRect } from "./obstacles";
import { computeWarehouseExtents } from "./warehouseGenerator";
import { recordTick } from "./traceRecorder";

type TimeWindowReservation = {
  cellKey: string;
  robotId: number;
  tickOffset: number;
};

type ReservationContext = {
  nextCells: Map<string, number>;
  edgeWinners: Map<string, number>;
  priorities: Map<number, number>;
  timeWindows: TimeWindowReservation[];
};

export type YieldBay = {
  id: string;
  position: Vec2;
  aisleIndex: number;
  occupied: boolean;
};

const YIELD_BLOCKED_TICKS = 12;
const YIELD_WAIT_TICKS = 18;
const MAX_CONSECUTIVE_YIELDS = 3;
const NEXT_MISSION_DWELL_TICKS = 35;

/**
 * Startup dispatch control. When a mission batch starts, many robots want to leave the
 * parking area at once. The dispatch controller ranks them (closest to the parking exit
 * first), clears only a limited number into the launch zone at a time and holds the rest
 * stopped at their bays, so the first seconds of a batch look staged instead of chaotic.
 */
const LAUNCH_ZONE_RADIUS_MIN = 4.5;
const MAX_CONCURRENT_LAUNCHES = 3;
const LAUNCH_CORRIDOR_METERS = 3.5;
const LAUNCH_FORCE_CLEAR_TICKS = 450;
const LAUNCH_DECISION_LOG_LIMIT = 40;

let deadlocksDetected = 0;
let deadlocksResolved = 0;
let timeWindowReservationCount = 0;
let stationQueues: StationQueueState[] = [];
let trafficEvents: TrafficEvent[] = [];
let yieldBays: YieldBay[] = [];
let routeReservationTable: Map<string, Set<number>> = new Map();
let dynamicRerouteCount = 0;
let physicalQueueSlots: PhysicalQueueSlot[] = [];
let supervisorDecisions: SupervisorDecision[] = [];
let parkingBayRegistry: ParkingBayInfo[] = [];
let parkingReassignments: ParkingReassignment[] = [];
const REROUTE_DELAY_THRESHOLD = 40;

let launchWaveCounter = 0;
let activeLaunchWaveId = 0;
let launchWaveActive = false;
let launchDecisions: LaunchDecision[] = [];
let launchHoldsTotal = 0;
let launchClearancesTotal = 0;
let launchHeldNow = 0;
let launchClearedInZoneNow = 0;

export function getStartupDispatchStats(): StartupDispatchStats {
  return {
    activeWaveId: activeLaunchWaveId,
    heldNow: launchHeldNow,
    clearedInZone: launchClearedInZoneNow,
    totalHolds: launchHoldsTotal,
    totalClearances: launchClearancesTotal,
    recentDecisions: launchDecisions,
  };
}

let missionAnalysis: MissionAnalysisRecord[] = [];
const MISSION_ANALYSIS_LIMIT = 200;

export function getMissionAnalysis(): MissionAnalysisRecord[] {
  return missionAnalysis;
}

/**
 * Build the post-completion analysis record for a mission: estimate vs actual time and
 * distance, plus a list of the problems encountered (startup holds, traffic waits,
 * yields, replans, overruns). Powers the Mission Analysis debug section.
 */
function recordMissionOutcome(
  mission: Mission,
  robot: RobotRuntime | undefined,
  scenario: WarehouseScenario,
  tick: number
) {
  const assignedAt = mission.assignedAtTick ?? mission.createdAtTick;
  const actualTimeTicks = Math.max(0, tick - assignedAt);
  const tickMs = scenario.simulation.tickMs;
  const estimatedTimeTicks = mission.estimatedTime !== undefined
    ? Math.max(1, Math.round((mission.estimatedTime * 1000) / tickMs))
    : undefined;

  const problems: string[] = [];
  if (mission.status === "failed") problems.push(`failed: ${mission.failReason ?? "unknown reason"}`);
  if ((mission.startupHoldTicks ?? 0) > 0) problems.push(`held ${mission.startupHoldTicks}t at startup for launch spacing`);
  if (mission.waitTicks >= 80) problems.push(`heavy traffic: waited ${mission.waitTicks}t for clearance`);
  else if (mission.waitTicks >= 20) problems.push(`traffic wait ${mission.waitTicks}t`);
  if ((mission.yieldCount ?? 0) > 0) problems.push(`yielded right-of-way ${mission.yieldCount}x`);
  if ((mission.replanCount ?? 0) > 0) problems.push(`route replanned ${mission.replanCount}x`);
  if (estimatedTimeTicks !== undefined && actualTimeTicks > estimatedTimeTicks * 1.5) {
    problems.push(`ran ${Math.round((actualTimeTicks / estimatedTimeTicks - 1) * 100)}% over time estimate`);
  }
  if (mission.estimatedDistance !== undefined && mission.estimatedDistance > 0 &&
      mission.distanceMeters > mission.estimatedDistance * 1.4) {
    problems.push(`route ${Math.round((mission.distanceMeters / mission.estimatedDistance - 1) * 100)}% longer than estimate`);
  }

  missionAnalysis.push({
    missionId: mission.id,
    robotId: robot?.id ?? mission.assignedRobotId,
    status: mission.status === "failed" ? "failed" : "done",
    targetStationId: mission.targetStationId,
    assignedAtTick: assignedAt,
    completedAtTick: tick,
    estimatedTimeTicks,
    actualTimeTicks,
    estimatedDistance: mission.estimatedDistance,
    actualDistance: Math.round(mission.distanceMeters * 10) / 10,
    waitTicks: mission.waitTicks,
    startupHoldTicks: mission.startupHoldTicks ?? 0,
    yieldCount: mission.yieldCount ?? 0,
    replanCount: mission.replanCount ?? 0,
    delayTicks: estimatedTimeTicks !== undefined ? actualTimeTicks - estimatedTimeTicks : undefined,
    problems,
  });
  if (missionAnalysis.length > MISSION_ANALYSIS_LIMIT) {
    missionAnalysis = missionAnalysis.slice(-MISSION_ANALYSIS_LIMIT);
  }
}

/**
 * Physical-collision tracking. A "physical collision" is an actual footprint overlap
 * between two robot bodies. It is counted once per contact *episode* (when the overlap
 * begins) and NOT every tick the pair stays overlapped — that is the fix for the
 * counter that previously climbed without limit. Avoided/predicted conflicts (head-on
 * events, deadlock detections) are tracked separately and are expected to be non-zero.
 */
export type CollisionEpisode = {
  tick: number;
  robotA: number;
  robotB: number;
  position: Vec2;
  separation: number;
  reason: string;
};
let physicalCollisionEpisodes = 0;
let overlappingPairs = new Set<string>();
let collisionEpisodeLog: CollisionEpisode[] = [];
let collisionPairCooldownUntil = new Map<string, number>();

export function getPhysicalCollisionCount(): number {
  return physicalCollisionEpisodes;
}

export function getCollisionEpisodes(): CollisionEpisode[] {
  return collisionEpisodeLog;
}

export function resetCollisionTracking() {
  physicalCollisionEpisodes = 0;
  overlappingPairs = new Set();
  collisionEpisodeLog = [];
  collisionPairCooldownUntil = new Map();
}

/** Test-only hook: run the physical-collision episode detector against an arbitrary fleet snapshot. */
export function __detectPhysicalCollisionsForTest(robots: RobotRuntime[], scenario: WarehouseScenario, tick: number) {
  detectPhysicalCollisions(robots, scenario, tick);
}

/**
 * Detect genuine footprint overlaps and count each contact episode once.
 * Centers closer than 2*radius means the robot bodies physically intersect.
 */
function detectPhysicalCollisions(robots: RobotRuntime[], scenario: WarehouseScenario, tick: number) {
  const radius = robotRadius(scenario);
  const contactDist = radius * 2 - 0.02;
  const current = new Set<string>();
  for (let i = 0; i < robots.length; i++) {
    for (let j = i + 1; j < robots.length; j++) {
      const a = robots[i];
      const b = robots[j];
      const d = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
      if (d < contactDist) {
        const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
        current.add(key);
        const cooldownUntil = collisionPairCooldownUntil.get(key) ?? -Infinity;
        if (!overlappingPairs.has(key) && tick >= cooldownUntil) {
          physicalCollisionEpisodes++;
          collisionPairCooldownUntil.set(key, tick + 5);
          if (collisionEpisodeLog.length < 200) {
            collisionEpisodeLog.push({
              tick,
              robotA: a.id,
              robotB: b.id,
              position: { x: (a.position.x + b.position.x) / 2, z: (a.position.z + b.position.z) / 2 },
              separation: d,
              reason: `footprint overlap (centers ${d.toFixed(2)}m < ${contactDist.toFixed(2)}m)`,
            });
          }
        }
      }
    }
  }
  overlappingPairs = current;
  for (const [key, until] of collisionPairCooldownUntil) {
    if (tick > until + 60 && !current.has(key)) collisionPairCooldownUntil.delete(key);
  }
}

function updateCollisionStates(robots: RobotRuntime[], scenario: WarehouseScenario) {
  const radius = robotRadius(scenario);
  const clearance = scenario.simulation.robotClearanceMeters ?? 0.12;
  const physicalLimit = radius * 2 - 0.02;
  const nearLimit = radius * 2 + Math.max(0.06, clearance * 0.6);
  const watchLimit = radius * 2 + Math.max(0.8, clearance + 0.55);

  for (const robot of robots) {
    let nearest: RobotRuntime | undefined;
    let nearestDistance = Infinity;
    for (const other of robots) {
      if (other.id === robot.id) continue;
      const d = distance(robot.position, other.position);
      if (d < nearestDistance) {
        nearestDistance = d;
        nearest = other;
      }
    }

    const gap = Number.isFinite(nearestDistance) ? nearestDistance - radius * 2 : undefined;
    let state: CollisionState = "clear";
    let reason = robot.state === "idle" ? "Docked and clear" : "Clear route envelope";

    if (nearest && nearestDistance < physicalLimit) {
      state = "physical-contact";
      reason = `Physical footprint overlap with R${String(nearest.id).padStart(2, "0")}`;
    } else if (nearest && nearestDistance < nearLimit) {
      state = "near-miss";
      reason = `Near-miss spacing to R${String(nearest.id).padStart(2, "0")} (${Math.max(0, gap ?? 0).toFixed(2)}m gap)`;
    } else if (robot.blockedTicks >= YIELD_BLOCKED_TICKS) {
      state = "blocked";
      reason = robot.waitingForRobotId
        ? `Blocked by reserved clearance behind R${String(robot.waitingForRobotId).padStart(2, "0")}`
        : "Blocked while waiting for reserved clearance";
    } else if (robot.state === "yielding") {
      state = "yielding";
      reason = robot.waitingForRobotId
        ? `Yielding right-of-way to R${String(robot.waitingForRobotId).padStart(2, "0")}`
        : "Yielding into a clearance pocket";
    } else if (robot.waitingForRobotId !== undefined || robot.blockedTicks > 0) {
      state = "reserved";
      reason = robot.waitingForRobotId
        ? `Reservation wait behind R${String(robot.waitingForRobotId).padStart(2, "0")}`
        : "Waiting for time-window reservation";
    } else if (nearest && nearestDistance < watchLimit) {
      state = "watch";
      reason = `Monitoring R${String(nearest.id).padStart(2, "0")} (${Math.max(0, gap ?? 0).toFixed(2)}m gap)`;
    } else if (robot.state === "returning") {
      state = "clear";
      reason = "Returning to home slot with clear envelope";
    }

    robot.collisionState = state;
    robot.collisionStateReason = reason;
    robot.collisionClearanceMeters = gap;
  }
}

export function getDeadlockStats() {
  return { deadlocksDetected, deadlocksResolved, timeWindowReservations: timeWindowReservationCount };
}

export function getStationQueues(): StationQueueState[] {
  return stationQueues;
}

export function getTrafficEvents(): TrafficEvent[] {
  return trafficEvents;
}

export function getYieldBays(): YieldBay[] {
  return yieldBays;
}

export function clearTrafficEvents() {
  trafficEvents = [];
}

export function getSupervisorDecisions(): SupervisorDecision[] {
  return supervisorDecisions;
}

export function getParkingBays(): ParkingBayInfo[] {
  return parkingBayRegistry;
}

export function getParkingReassignments(): ParkingReassignment[] {
  return parkingReassignments;
}

function isHomeParkingStrategy(scenario: WarehouseScenario): boolean {
  return (scenario.simulation.parkingStrategy ?? "home-slots") === "home-slots";
}

function canDynamicallyReassignParking(scenario: WarehouseScenario): boolean {
  return !isHomeParkingStrategy(scenario);
}

function enforceHomeParkingTargets(robots: RobotRuntime[], scenario: WarehouseScenario) {
  if (!isHomeParkingStrategy(scenario)) return;
  const tolerance = standbyArrivalTolerance(scenario) * 3;
  for (const robot of robots) {
    // A robot resting at a temporary bay (post-charge) keeps it until its next mission.
    if (robot.usingTemporaryBay && robot.assignedParkingPosition) continue;
    const homeBayId = findBayIdForPosition(robot.homePosition, tolerance);
    if (robot.assignedParkingBayId && robot.assignedParkingBayId !== homeBayId) {
      releaseParkingBay(robot);
    }
    robot.assignedParkingPosition = { ...robot.homePosition };
    robot.assignedParkingBayId = homeBayId;
  }
}

export function initRobots(scenario: WarehouseScenario): RobotRuntime[] {
  const robots: RobotRuntime[] = [];
  const count = scenario.robots.count;
  const parkingPositions = buildParkingPositions(scenario, count);

  deadlocksDetected = 0;
  deadlocksResolved = 0;
  timeWindowReservationCount = 0;
  stationQueues = [];
  trafficEvents = [];
  yieldBays = buildYieldBays(scenario);
  routeReservationTable = new Map();
  dynamicRerouteCount = 0;
  physicalQueueSlots = buildPhysicalQueueSlots(scenario);
  supervisorDecisions = [];
  physicalCollisionEpisodes = 0;
  overlappingPairs = new Set();
  collisionEpisodeLog = [];
  parkingReassignments = [];
  launchWaveCounter = 0;
  activeLaunchWaveId = 0;
  launchWaveActive = false;
  launchDecisions = [];
  launchHoldsTotal = 0;
  launchClearancesTotal = 0;
  launchHeldNow = 0;
  launchClearedInZoneNow = 0;
  missionAnalysis = [];

  const allParkingPositions = buildParkingPositions(scenario, Math.max(count + 24, count * 4));
  parkingBayRegistry = allParkingPositions.map((pos, i) => ({
    id: `PB-${String(i + 1).padStart(2, "0")}`,
    position: { ...pos },
    state: "free" as const,
  }));

  for (let i = 0; i < count; i++) {
    const parking = parkingPositions[i];
    const x = parking.x;
    const z = parking.z;
    const bayId = parkingBayRegistry[i]?.id ?? `PB-${String(i + 1).padStart(2, "0")}`;
    if (parkingBayRegistry[i]) {
      parkingBayRegistry[i].state = "occupied";
      parkingBayRegistry[i].assignedRobotId = i + 1;
    }
    robots.push({
      id: i + 1,
      position: { x, z },
      homePosition: { x, z },
      assignedParkingPosition: { x, z },
      assignedParkingBayId: bayId,
      heading: 0,
      homeHeading: 0,
      state: "idle",
      batteryMinutes: scenario.robots.batteryCapacityMinutes,
      path: [],
      pathIndex: 0,
      waitTicks: 0,
      blockedTicks: 0,
      totalDistance: 0,
      totalWaitTicks: 0,
      currentSpeedMps: 0,
      liftTelemetry: { targetLevel: 0, currentExtensionPct: 0, activeStages: 0, payloadState: "empty" },
      deadlockRecoveries: 0,
      waitingForRobotId: undefined,
      consecutiveYields: 0,
      collisionState: "clear",
      collisionStateReason: "Parked at home slot",
      collisionClearanceMeters: undefined,
    });
  }
  return robots;
}

export function tickRobots(
  robots: RobotRuntime[],
  missions: Mission[],
  slots: Slot[],
  scenario: WarehouseScenario,
  graph: NavGraph,
  congestionMap: Map<string, number>,
  collisionAvoidance: boolean,
  _tick: number
) {
  const solids = buildSolidObstacles(scenario);
  const reservations = collisionAvoidance ? buildReservationContext(robots, scenario) : undefined;
  const parkingOnlyMode = isCompletedMissionWaveParkingMode(robots, missions);

  updateStationQueues(scenario, robots, missions);

  const usePredictive = collisionAvoidance && scenario.simulation.routing === "reservation-table";
  const congestionCtx = usePredictive ? buildCongestionContextForTick(congestionMap, scenario) : undefined;

  enforceHomeParkingTargets(robots, scenario);

  updateStartupDispatch(robots, missions, scenario, graph, collisionAvoidance, _tick);

  if (collisionAvoidance && !parkingOnlyMode) {
    detectAndResolveDeadlocks(robots, scenario, missions, congestionMap, solids, _tick);
  } else if (collisionAvoidance && parkingOnlyMode) {
    // During the final parking phase, returning (or charge-bound) robots can still be
    // physically blocked by an already-parked neighbor in the same depot column. Keep
    // the persistent-block resolver active so the parked robot shuffles aside instead
    // of the blocked robot being teleported into its bay (the old auto-dock glitch).
    resolvePersistentRobotBlocks(robots, scenario, missions, congestionMap, solids, _tick);
  }

  if (usePredictive && congestionCtx) {
    for (const robot of robots) {
      checkDynamicReroute(robot, robots, scenario, graph, missions, slots, congestionCtx, _tick);
    }
  }

  updateParkingBayStates(robots, scenario);
  assignCompletedWaveParking(robots, missions, scenario, graph, solids, usePredictive ? congestionCtx : undefined, _tick);
  if (!parkingOnlyMode) {
    resolveReturningRobotParkingClusters(robots, scenario, missions, congestionMap, solids, _tick);
  }

  const chargingStation = scenario.stations.find(s => s.type === "charging");
  const lowBatteryThreshold = scenario.simulation.lowBatteryThreshold ?? 15;
  const pickPlaceTimePerLevel = scenario.simulation.pickPlaceTimePerLevel ?? 3;

  for (const robot of robots) {
    if (robot.state === "idle") {
      robot.liftTelemetry = { targetLevel: 0, currentExtensionPct: 0, activeStages: 0, payloadState: "empty" };
      const validParking = isRobotInValidParking(robot, robots, scenario);
      if (!validParking && hasQueuedMissions(missions) && robot.waitTicks > 0) {
        robot.waitTicks--;
        robot.totalWaitTicks++;
        robot.currentSpeedMps = 0;
        continue;
      }
      if (
        (shouldReturnIdleRobotHome(missions) || !validParking) &&
        !robot.missionId &&
        !robot.carryingSlotId &&
        !validParking &&
        !holdForInboundDeeperColumnRobot(robot, robots, scenario)
      ) {
        startReturnToStandby(robot, robots, scenario, graph, usePredictive ? congestionCtx : undefined, _tick);
        continue;
      }
      if (chargingStation && robot.batteryMinutes < lowBatteryThreshold) {
        robot.state = "to-charge";
        clearRobotRouteReservations(robot.id);
        robot.path = usePredictive && congestionCtx
          ? pathToStationPredictive(graph, robot.position, chargingStation, congestionCtx)
          : pathToStation(graph, robot.position, chargingStation);
        robot.pathIndex = 0;
        registerRouteReservations(robot, robot.path, _tick, scenario);
      }
      continue;
    }

    if (robot.state === "to-charge") {
      if (robot.path.length === 0 && chargingStation) {
        clearRobotRouteReservations(robot.id);
        robot.path = usePredictive && congestionCtx
          ? pathToStationPredictive(graph, robot.position, chargingStation, congestionCtx)
          : pathToStation(graph, robot.position, chargingStation);
        robot.pathIndex = 0;
        registerRouteReservations(robot, robot.path, _tick, scenario);
      }
      if (moveAlongPath(robot, robots, scenario, solids, collisionAvoidance, congestionMap, undefined, reservations)) {
        robot.state = "charging";
        robot.waitTicks = 300;
        robot.path = [];
        robot.pathIndex = 0;
        clearRobotRouteReservations(robot.id);
      }
      robot.batteryMinutes -= scenario.simulation.tickMs / 60000;
      if (robot.batteryMinutes < 0) robot.batteryMinutes = 0;
      continue;
    }

    if (robot.state === "charging") {
      robot.waitTicks--;
      robot.batteryMinutes = Math.min(
        scenario.robots.batteryCapacityMinutes,
        robot.batteryMinutes + (scenario.simulation.tickMs / 60000) * 10
      );
      // Undock when full enough, or once the minimum charge dwell is over and the battery
      // is safely above the low threshold (so a demo charge cycle completes in minutes,
      // and the robot will not turn straight back to the charger).
      const safeBattery = (scenario.simulation.lowBatteryThreshold ?? 15) * 2;
      if (
        robot.batteryMinutes >= scenario.robots.batteryCapacityMinutes * 0.9 ||
        (robot.waitTicks <= 0 && robot.batteryMinutes >= safeBattery)
      ) {
        robot.state = "idle";
        robot.waitTicks = 0;
        adoptNearestParkingBayAfterCharge(robot, robots, scenario, _tick);
      }
      continue;
    }

    if (robot.state === "yielding") {
      const mission = missions.find(m => m.id === robot.missionId);
      if (robot.path.length > 0) {
        if (moveAlongPath(robot, robots, scenario, solids, collisionAvoidance, congestionMap, undefined, reservations)) {
          robot.path = [];
          robot.pathIndex = 0;
          robot.waitTicks = Math.max(robot.waitTicks, YIELD_WAIT_TICKS);
          robot.heading = rotateToward(robot.heading, robot.heading + Math.PI / 2, scenario.robots.turnSpeedRadPerSecond * (scenario.simulation.tickMs / 1000));
          if (mission) mission.statusNote = "Yielding in side pocket to let traffic pass";
        } else if (robot.blockedTicks > 35) {
          robot.path = [];
          robot.pathIndex = 0;
          robot.waitTicks = Math.max(robot.waitTicks, Math.floor(YIELD_WAIT_TICKS / 2));
          robot.blockedTicks = 0;
          if (mission) mission.statusNote = "Yield pocket blocked; waiting then replanning";
        }
      } else if (robot.waitTicks > 0) {
        robot.waitTicks--;
        robot.totalWaitTicks++;
        if (mission) mission.waitTicks++;
        if (robot.yieldTarget) {
          robot.heading = rotateToward(robot.heading, Math.atan2(robot.yieldTarget.x - robot.position.x, robot.yieldTarget.z - robot.position.z), scenario.robots.turnSpeedRadPerSecond * (scenario.simulation.tickMs / 1000));
        }
      } else {
        resumeAfterYield(robot, missions);
      }
      robot.batteryMinutes -= scenario.simulation.tickMs / 60000;
      if (robot.batteryMinutes < 0) robot.batteryMinutes = 0;
      continue;
    }

    if (robot.state === "returning") {
      if (!parkingOnlyMode && isReturningRobotBlockingStationExit(robot, robots, scenario, missions)) {
        const yieldResult = yieldReturningRobotFromStation(robot, robots, scenario, missions, congestionMap, solids, _tick);
        if (yieldResult) {
          robot.batteryMinutes -= scenario.simulation.tickMs / 60000;
          if (robot.batteryMinutes < 0) robot.batteryMinutes = 0;
          continue;
        }
      }

      if (parkingOnlyMode && tryFinalAutoDock(robot, robots, scenario, missions, _tick)) {
        clearRobotRouteReservations(robot.id);
        updateBayStateForRobot(robot, "occupied");
        robot.batteryMinutes -= scenario.simulation.tickMs / 60000;
        if (robot.batteryMinutes < 0) robot.batteryMinutes = 0;
        continue;
      }

      if (robot.path.length === 0) {
        clearRobotRouteReservations(robot.id);
        robot.path = buildReturnPathToStandby(robot, robots, scenario, graph, solids, usePredictive ? congestionCtx : undefined);
        robot.pathIndex = 0;
        if (robot.path.length === 0 && distance(robot.position, parkingTarget(robot)) > standbyArrivalTolerance(scenario)) {
          const oldBayId = robot.assignedParkingBayId;
          if (canDynamicallyReassignParking(scenario)) {
            releaseParkingBay(robot);
            robot.assignedParkingPosition = undefined;
            robot.assignedParkingBayId = undefined;
          }
          robot.path = buildReturnPathToStandby(robot, robots, scenario, graph, solids, usePredictive ? congestionCtx : undefined);
          robot.pathIndex = 0;
          robot.blockedTicks = 0;
          robot.parkingReassignReason = "unreachable-return-path";
          parkingReassignments.push({
            tick: _tick,
            robotId: robot.id,
            fromBayId: oldBayId,
            toBayId: robot.assignedParkingBayId ?? "unknown",
            reason: "Return path was empty, reassigned to reachable parking bay",
          });
          if (parkingReassignments.length > 100) parkingReassignments = parkingReassignments.slice(-60);
        }
        registerRouteReservations(robot, robot.path, _tick, scenario);
      }
      if (moveAlongPath(robot, robots, scenario, solids, collisionAvoidance, congestionMap, undefined, reservations)) {
        const target = parkingTarget(robot);
        const distanceParking = distance(robot.position, target);
        if (distanceParking <= standbyArrivalTolerance(scenario)) {
          dockRobotAtParkingTarget(robot, scenario, "docked-at-parking-target");
          clearRobotRouteReservations(robot.id);
          updateBayStateForRobot(robot, "occupied");
        } else {
          const oldBayId = robot.assignedParkingBayId;
          if (canDynamicallyReassignParking(scenario)) {
            releaseParkingBay(robot);
            robot.assignedParkingPosition = undefined;
            robot.assignedParkingBayId = undefined;
          }
          clearRobotRouteReservations(robot.id);
          robot.parkingReassignReason = "return-ended-away-from-parking";
          robot.path = [];
          robot.pathIndex = 0;
          robot.waitTicks = 1;
          robot.blockedTicks = 0;
          robot.totalWaitTicks++;
          parkingReassignments.push({
            tick: _tick,
            robotId: robot.id,
            fromBayId: oldBayId,
            toBayId: "pending",
            reason: "Return route ended before parking target; releasing stale bay",
          });
          if (parkingReassignments.length > 100) parkingReassignments = parkingReassignments.slice(-60);
        }
      } else if (
        robot.blockedTicks > (parkingOnlyMode ? 10 : 30) &&
        robot.waitingForRobotId === undefined &&
        startYieldManeuver(robot, robots, scenario, missions, congestionMap, solids,
          "Repositioning around obstruction to resume return", _tick)
      ) {
        // Pinned against world geometry (e.g. a station bollard) with no robot to wait
        // for: a straight replan would rebuild the same impassable route. Side-step into
        // a validated clear pocket first, then plan home from there.
      } else if (robot.blockedTicks > (parkingOnlyMode ? 12 : 45)) {
        const oldBayId = robot.assignedParkingBayId;
        if (canDynamicallyReassignParking(scenario)) {
          releaseParkingBay(robot);
          robot.assignedParkingPosition = undefined;
          robot.assignedParkingBayId = undefined;
        }
        clearRobotRouteReservations(robot.id);
        robot.path = buildReturnPathToStandby(robot, robots, scenario, graph, solids, usePredictive ? congestionCtx : undefined);
        robot.pathIndex = 0;
        robot.blockedTicks = 0;
        robot.parkingReassignReason = "blocked-too-long";
        registerRouteReservations(robot, robot.path, _tick, scenario);
        parkingReassignments.push({
          tick: _tick,
          robotId: robot.id,
          fromBayId: oldBayId,
          toBayId: robot.assignedParkingBayId ?? "unknown",
          reason: "Blocked for 45+ ticks, reassigned to alternative bay",
        });
        if (parkingReassignments.length > 100) parkingReassignments = parkingReassignments.slice(-60);
      }
      robot.batteryMinutes -= scenario.simulation.tickMs / 60000;
      if (robot.batteryMinutes < 0) robot.batteryMinutes = 0;
      continue;
    }

    const mission = missions.find(m => m.id === robot.missionId);
    if (!mission) { robot.state = "idle"; continue; }

    if ((robot.state === "to-pick" || robot.state === "to-point") && isLaunchHeld(robot)) {
      // Startup dispatch hold: stay stopped at the bay (no path, no reservations, no
      // jitter) until the dispatch controller clears this robot to launch.
      robot.currentSpeedMps = 0;
      robot.totalWaitTicks++;
      mission.waitTicks++;
      mission.startupHoldTicks = (mission.startupHoldTicks ?? 0) + 1;
      mission.statusNote = robot.launchReason ?? "Holding for startup launch clearance";
      robot.batteryMinutes -= scenario.simulation.tickMs / 60000;
      if (robot.batteryMinutes < 0) robot.batteryMinutes = 0;
      continue;
    }

    if (robot.state === "to-point" && robot.path.length === 0) {
      const target = mission.targetPosition;
      if (!target) {
        mission.status = "failed";
        mission.failReason = "Target position not found";
        recordMissionOutcome(mission, robot, scenario, _tick);
        robot.state = "idle";
        robot.missionId = undefined;
        continue;
      }
      clearRobotRouteReservations(robot.id);
      robot.path = usePredictive && congestionCtx
        ? pathToPointPredictive(graph, robot.position, target, congestionCtx)
        : pathToPoint(graph, robot.position, target);
      robot.pathIndex = 0;
      registerRouteReservations(robot, robot.path, _tick, scenario);
      mission.status = "moving";
      mission.statusNote = "Driving to selected position";
    }

    if (robot.state === "to-pick" && robot.path.length === 0) {
      const slot = slots.find(s => s.id === mission.sourceSlotId);
      if (!slot) {
        mission.status = "failed";
        mission.failReason = "Source slot not found";
        recordMissionOutcome(mission, robot, scenario, _tick);
        robot.state = "idle";
        robot.missionId = undefined;
        continue;
      }
      clearRobotRouteReservations(robot.id);
      const slotPos = { x: slot.position.x, z: slot.position.z };
      robot.path = usePredictive && congestionCtx
        ? pathToSlotPredictive(graph, robot.position, slotPos, congestionCtx)
        : pathToSlot(graph, robot.position, slotPos);
      robot.pathIndex = 0;
      registerRouteReservations(robot, robot.path, _tick, scenario);
      mission.status = "moving";
    }

    if (robot.state === "to-drop" && robot.path.length === 0) {
      const station = scenario.stations.find(s => s.id === mission.targetStationId);
      if (!station) {
        mission.status = "failed";
        mission.failReason = "Target station not found";
        recordMissionOutcome(mission, robot, scenario, _tick);
        robot.state = "idle";
        robot.missionId = undefined;
        continue;
      }
      if (!isStationApproachClear(station, robot, robots, scenario)) {
        const nearSlot = physicalQueueSlots.find(qs =>
          qs.stationId === station.id &&
          Math.hypot(qs.position.x - robot.position.x, qs.position.z - robot.position.z) < 1.5
        );
        if (nearSlot) {
          nearSlot.assignedRobotId = robot.id;
          robot.waitTicks = 1;
          mission.statusNote = `Waiting at queue slot ${nearSlot.id}`;
          robot.totalWaitTicks++;
          mission.waitTicks++;
        } else {
          const availSlot = findAvailableQueueSlot(station.id, robot.id);
          if (availSlot) {
            availSlot.assignedRobotId = robot.id;
            clearRobotRouteReservations(robot.id);
            robot.path = usePredictive && congestionCtx
              ? pathToPointPredictive(graph, robot.position, availSlot.position, congestionCtx)
              : pathToPoint(graph, robot.position, availSlot.position);
            robot.pathIndex = 0;
            registerRouteReservations(robot, robot.path, _tick, scenario);
            mission.statusNote = `Routing to queue slot ${availSlot.id}`;
          } else {
            robot.waitTicks = 1;
            mission.statusNote = "Queuing for station approach";
            robot.totalWaitTicks++;
            mission.waitTicks++;
          }
        }
        if (robot.blockedTicks === 0) {
          recordTrafficEvent(_tick, "queue-wait", robot, undefined, `Queuing for ${station.id}`);
        }
        continue;
      }
      releaseQueueSlot(robot.id);
      clearRobotRouteReservations(robot.id);
      robot.path = usePredictive && congestionCtx
        ? pathToStationPredictive(graph, robot.position, station, congestionCtx)
        : pathToStation(graph, robot.position, station);
      robot.pathIndex = 0;
      registerRouteReservations(robot, robot.path, _tick, scenario);
      mission.status = "moving";
    }

    if (robot.state === "to-point" && robot.path.length > 0) {
      if (moveAlongPath(robot, robots, scenario, solids, collisionAvoidance, congestionMap, mission, reservations)) {
        robot.state = "idle";
        robot.missionId = undefined;
        mission.status = "done";
        mission.completedAtTick = _tick;
        mission.statusNote = "Arrived at selected position";
        recordMissionOutcome(mission, robot, scenario, _tick);
        robot.path = [];
        robot.pathIndex = 0;
        clearRobotRouteReservations(robot.id);
      }
    }

    if ((robot.state === "to-pick" || robot.state === "to-drop") && robot.path.length > 0) {
      if (moveAlongPath(robot, robots, scenario, solids, collisionAvoidance, congestionMap, mission, reservations)) {
        if (robot.state === "to-pick") {
          const slot = slots.find(s => s.id === mission.sourceSlotId);
          const levelIndex = slot?.levelIndex ?? 0;
          const baseTime = 60;
          robot.state = "picking";
          robot.waitTicks = baseTime + levelIndex * pickPlaceTimePerLevel;
          mission.status = mission.returnLeg ? "placing" : "picking";
          mission.statusNote = mission.returnLeg
            ? `Scissor lift returning box to level ${levelIndex + 1}`
            : `Scissor lift extending to level ${levelIndex + 1}`;
          robot.liftTelemetry = {
            targetLevel: levelIndex,
            currentExtensionPct: 0,
            activeStages: Math.min(levelIndex + 1, 3),
            payloadState: "extending",
          };
        } else {
          const roundTrip = (scenario.simulation.returnBoxesToShelf ?? false) && mission.type !== "move-to-point";
          const operatorTicks = roundTrip ? Math.max(20, scenario.simulation.operatorProcessTicks ?? 120) : 0;
          robot.state = "placing";
          robot.waitTicks = 15 + operatorTicks;
          mission.status = "placing";
          mission.statusNote = roundTrip
            ? "At station: operator processing the box"
            : "Scissor lift lowering for drop-off";
          robot.liftTelemetry = {
            ...robot.liftTelemetry,
            payloadState: "lowering",
          };
        }
        robot.path = [];
        robot.pathIndex = 0;
      }
    }

    if (robot.state === "picking") {
      const slot = slots.find(s => s.id === mission.sourceSlotId);
      const levelIndex = slot?.levelIndex ?? 0;
      const baseTime = 60;
      const totalPickTime = baseTime + levelIndex * pickPlaceTimePerLevel;
      const elapsed = totalPickTime - robot.waitTicks;
      const halfPoint = totalPickTime / 2;

      // Number of scissor stages that open scales with the shelf level:
      // level 1 -> 1 stage, level 2 -> 2 stages, level 3+ -> 3 stages.
      const levelStages = Math.min(levelIndex + 1, 3);
      const pctPerStage = 100 / levelStages;
      if (elapsed < halfPoint) {
        robot.liftTelemetry.currentExtensionPct = Math.min(100, (elapsed / halfPoint) * 100);
        robot.liftTelemetry.payloadState = "extending";
        robot.liftTelemetry.activeStages = Math.min(levelStages, Math.ceil(robot.liftTelemetry.currentExtensionPct / pctPerStage));
      } else {
        robot.liftTelemetry.currentExtensionPct = Math.max(0, 100 - ((elapsed - halfPoint) / halfPoint) * 100);
        robot.liftTelemetry.payloadState = "loaded";
        robot.liftTelemetry.activeStages = Math.min(levelStages, Math.max(1, Math.ceil(robot.liftTelemetry.currentExtensionPct / pctPerStage)));
      }

      robot.waitTicks--;
      if (robot.waitTicks <= 0) {
        if (mission.returnLeg) {
          // Round-trip mode: the lift just put the processed box back on its shelf.
          const returnedSlot = slots.find(s => s.id === mission.sourceSlotId);
          if (returnedSlot) returnedSlot.occupied = true;
          robot.carryingSlotId = undefined;
          robot.missionId = undefined;
          mission.status = "done";
          mission.completedAtTick = _tick;
          mission.statusNote = `Box returned to shelf ${mission.sourceSlotId}`;
          recordMissionOutcome(mission, robot, scenario, _tick);
          robot.liftTelemetry = { targetLevel: 0, currentExtensionPct: 0, activeStages: 0, payloadState: "empty" };
          releaseQueueSlot(robot.id);
          clearRobotRouteReservations(robot.id);
          if (!hasQueuedMissions(missions)) {
            startReturnToStandby(robot, robots, scenario, graph, usePredictive ? congestionCtx : undefined, _tick);
          } else {
            robot.state = "idle";
            robot.path = [];
            robot.pathIndex = 0;
            robot.waitTicks = NEXT_MISSION_DWELL_TICKS;
            robot.blockedTicks = 0;
            robot.currentSpeedMps = 0;
          }
        } else {
          robot.carryingSlotId = mission.sourceSlotId;
          const pickedSlot = slots.find(s => s.id === mission.sourceSlotId);
          if (pickedSlot) {
            pickedSlot.occupied = false;
          }
          robot.state = "to-drop";
          mission.statusNote = `Box secured from level ${levelIndex + 1}, lowering for travel`;
          robot.liftTelemetry = {
            targetLevel: levelIndex,
            currentExtensionPct: 0,
            activeStages: 0,
            payloadState: "loaded",
          };
        }
      }
    }

    if (robot.state === "placing") {
      robot.liftTelemetry.currentExtensionPct = Math.max(0, robot.liftTelemetry.currentExtensionPct - 8);
      robot.liftTelemetry.payloadState = "lowering";
      robot.waitTicks--;
      if (robot.waitTicks <= 0) {
        const roundTrip = (scenario.simulation.returnBoxesToShelf ?? false) &&
          mission.type !== "move-to-point" && !mission.returnLeg;
        if (roundTrip) {
          // Operator finished: carry the processed box back to its original shelf slot.
          mission.returnLeg = true;
          mission.status = "moving";
          mission.statusNote = `Operator done; returning box to ${mission.sourceSlotId}`;
          robot.state = "to-pick";
          robot.path = [];
          robot.pathIndex = 0;
          robot.waitTicks = 0;
          robot.blockedTicks = 0;
          robot.liftTelemetry = { ...robot.liftTelemetry, payloadState: "loaded", currentExtensionPct: 0, activeStages: 0 };
          releaseQueueSlot(robot.id);
          clearRobotRouteReservations(robot.id);
        } else {
          robot.carryingSlotId = undefined;
          robot.missionId = undefined;
          mission.status = "done";
          mission.completedAtTick = _tick;
          recordMissionOutcome(mission, robot, scenario, _tick);
          const waitForNextMission = hasQueuedMissions(missions);
          mission.statusNote = "Delivered; robot waiting for next mission";
          robot.liftTelemetry = { targetLevel: 0, currentExtensionPct: 0, activeStages: 0, payloadState: "empty" };
          releaseQueueSlot(robot.id);
          clearRobotRouteReservations(robot.id);
          if (!waitForNextMission) {
            mission.statusNote = "Delivered; no queued work, robot returning home";
            startReturnToStandby(robot, robots, scenario, graph, usePredictive ? congestionCtx : undefined, _tick);
          } else {
            robot.state = "idle";
            robot.path = [];
            robot.pathIndex = 0;
            robot.waitTicks = NEXT_MISSION_DWELL_TICKS;
            robot.blockedTicks = 0;
            robot.currentSpeedMps = 0;
          }
        }
      }
    }

    robot.batteryMinutes -= scenario.simulation.tickMs / 60000;
    if (robot.batteryMinutes < 0) robot.batteryMinutes = 0;
  }

  enforceExactHomeDockingWhenComplete(robots, missions, scenario, graph, solids, usePredictive ? congestionCtx : undefined, _tick);
  detectPhysicalCollisions(robots, scenario, _tick);
  updateCollisionStates(robots, scenario);

  recordTick(robots, missions, _tick);
}

/**
 * After charging, do not force a long trek back across the warehouse: if a free parking
 * bay meaningfully closer than the robot's home slot exists (e.g. the rear bays beside
 * the charger), reserve it as a temporary bay. The robot keeps it until its next
 * mission, after which normal home-slot parking resumes.
 */
function adoptNearestParkingBayAfterCharge(
  robot: RobotRuntime,
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  tick: number
) {
  if (!isHomeParkingStrategy(scenario)) return;
  const homeDistance = distance(robot.position, robot.homePosition);
  if (homeDistance < 12) return; // home is nearby anyway

  const radius = robotRadius(scenario);
  const clearance = scenario.simulation.robotClearanceMeters ?? 0.12;
  const minRobotDistance = radius * 2 + clearance + 0.65;
  const solids = buildSolidObstacles(scenario);
  const best = parkingBayRegistry
    .filter(bay => bay.state === "free")
    .filter(bay => isParkingCandidateAvailable(bay.position, robot, robots, scenario, solids, minRobotDistance, radius))
    .sort((a, b) => distance(a.position, robot.position) - distance(b.position, robot.position))[0];
  if (!best) return;
  if (distance(best.position, robot.position) > homeDistance * 0.6) return; // not meaningfully closer

  const oldBayId = robot.assignedParkingBayId;
  releaseParkingBay(robot);
  robot.assignedParkingBayId = best.id;
  robot.assignedParkingPosition = { ...best.position };
  robot.usingTemporaryBay = true;
  robot.parkingReassignReason = "post-charge-nearest-bay";
  best.state = "reserved";
  best.assignedRobotId = robot.id;
  parkingReassignments.push({
    tick,
    robotId: robot.id,
    fromBayId: oldBayId,
    toBayId: best.id,
    reason: "Charged: parking at nearest free bay instead of crossing back home",
  });
  if (parkingReassignments.length > 100) parkingReassignments = parkingReassignments.slice(-60);
}

function launchZoneRadius(scenario: WarehouseScenario): number {
  return Math.max(LAUNCH_ZONE_RADIUS_MIN, robotRadius(scenario) * 5);
}

function isLaunchHeld(robot: RobotRuntime): boolean {
  return robot.launchCleared === false;
}

function clearLaunchFields(robot: RobotRuntime) {
  robot.launchCleared = undefined;
  robot.startupHoldTicks = undefined;
  robot.launchPriority = undefined;
  robot.launchReason = undefined;
  robot.launchWaveId = undefined;
}

/** Z of the parking band exit. Mirrors dispatchRouteStart's parking band threshold. */
function parkingBandExitZ(scenario: WarehouseScenario): number {
  return -scenario.warehouse.depth / 2 + 8.5;
}

/**
 * Distance from the robot to the parking exit. Inside the rear parking band robots leave
 * straight toward the main aisle (+z, matching dispatchRouteStart), so the exit distance
 * is the remaining depth of the band; elsewhere the nearest navigation node stands in.
 */
function launchExitDistance(robot: RobotRuntime, graph: NavGraph, scenario: WarehouseScenario): number {
  const bandZ = parkingBandExitZ(scenario);
  if (robot.position.z <= bandZ) return bandZ - robot.position.z;
  const nodeId = findNearestNodeId(graph.nodes, robot.position);
  const node = nodeId ? graph.nodes.get(nodeId) : undefined;
  return node ? distance(robot.position, node.position) : 0;
}

/**
 * First metres of a robot's launch route. Uses the planned path when one exists; before
 * path planning, robots inside the parking band launch straight toward the band exit
 * (+z, like dispatchRouteStart routes them), others head for the nearest nav node.
 */
function launchCorridorSegment(robot: RobotRuntime, graph: NavGraph, scenario: WarehouseScenario): { a: Vec2; b: Vec2 } {
  if (robot.path.length > robot.pathIndex) {
    return { a: { ...robot.position }, b: projectRobotPosition(robot, LAUNCH_CORRIDOR_METERS) };
  }
  if (robot.position.z <= parkingBandExitZ(scenario)) {
    return {
      a: { ...robot.position },
      b: { x: robot.position.x, z: robot.position.z + LAUNCH_CORRIDOR_METERS },
    };
  }
  const nodeId = findNearestNodeId(graph.nodes, robot.position);
  const node = nodeId ? graph.nodes.get(nodeId) : undefined;
  if (!node) return { a: { ...robot.position }, b: { ...robot.position } };
  const d = distance(robot.position, node.position);
  if (d <= LAUNCH_CORRIDOR_METERS) return { a: { ...robot.position }, b: { ...node.position } };
  const t = LAUNCH_CORRIDOR_METERS / d;
  return {
    a: { ...robot.position },
    b: {
      x: robot.position.x + (node.position.x - robot.position.x) * t,
      z: robot.position.z + (node.position.z - robot.position.z) * t,
    },
  };
}

function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const lenSq = abx * abx + abz * abz;
  if (lenSq <= 1e-9) return Math.hypot(p.x - a.x, p.z - a.z);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / lenSq));
  return Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t));
}

function segmentsIntersect2D(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): boolean {
  const orient = (p: Vec2, q: Vec2, r: Vec2) =>
    Math.sign((q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x));
  const o1 = orient(a1, a2, b1);
  const o2 = orient(a1, a2, b2);
  const o3 = orient(b1, b2, a1);
  const o4 = orient(b1, b2, a2);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o3 !== 0;
}

function segmentsMinDistance(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): number {
  if (segmentsIntersect2D(a1, a2, b1, b2)) return 0;
  return Math.min(
    pointSegmentDistance(a1, b1, b2),
    pointSegmentDistance(a2, b1, b2),
    pointSegmentDistance(b1, a1, a2),
    pointSegmentDistance(b2, a1, a2)
  );
}

function recordLaunchDecision(tick: number, robot: RobotRuntime, action: "cleared" | "held", reason: string) {
  launchDecisions.push({
    tick,
    robotId: robot.id,
    action,
    waveId: activeLaunchWaveId,
    priority: robot.launchPriority ?? 0,
    reason,
  });
  if (launchDecisions.length > LAUNCH_DECISION_LOG_LIMIT) {
    launchDecisions = launchDecisions.slice(-LAUNCH_DECISION_LOG_LIMIT);
  }
}

/**
 * Startup dispatch controller. Runs once per tick before robots move.
 *
 * Robots that just received a mission and are still at (or near) their parking bay form
 * the launch queue. They are ranked deterministically: closest to the parking exit first,
 * then loaded robots, then mission urgency, then lowest robot id. At most
 * MAX_CONCURRENT_LAUNCHES robots may be inside the launch zone at once, a robot is never
 * cleared into a corridor that crosses an already-cleared launch, and a robot whose first
 * metres are physically occupied by another launching robot waits for it to pull away.
 * Held robots keep speed 0 via the launch-hold gate in tickRobots.
 */
function updateStartupDispatch(
  robots: RobotRuntime[],
  missions: Mission[],
  scenario: WarehouseScenario,
  graph: NavGraph,
  collisionAvoidance: boolean,
  tick: number
) {
  launchHeldNow = 0;
  launchClearedInZoneNow = 0;

  if (!collisionAvoidance) {
    for (const robot of robots) {
      if (robot.launchCleared === false) {
        robot.launchCleared = true;
        robot.launchReason = "Cleared: launch control inactive without collision avoidance";
      }
    }
    launchWaveActive = false;
    return;
  }

  const zoneRadius = launchZoneRadius(scenario);
  const launching: RobotRuntime[] = [];

  for (const robot of robots) {
    const isMissionStart = (robot.state === "to-pick" || robot.state === "to-point") && robot.missionId !== undefined;
    if (!isMissionStart) {
      if (
        robot.launchCleared !== undefined &&
        (robot.state === "idle" || robot.state === "returning" || robot.state === "charging")
      ) {
        clearLaunchFields(robot);
      }
      continue;
    }
    const origin = parkingTarget(robot);
    if (distance(robot.position, origin) > zoneRadius) {
      if (robot.launchCleared !== true) {
        // Assigned mid-floor (mission chaining) or already past the zone: nothing to stage.
        robot.launchCleared = true;
        robot.startupHoldTicks = robot.startupHoldTicks ?? 0;
        robot.launchReason = robot.launchReason ?? "Cleared: launched outside parking zone";
      }
      continue;
    }
    launching.push(robot);
  }

  if (launching.length === 0) {
    launchWaveActive = false;
    return;
  }
  if (!launchWaveActive) {
    launchWaveActive = true;
    activeLaunchWaveId = ++launchWaveCounter;
  }

  const cleared = launching.filter(r => r.launchCleared === true);
  const pending = launching.filter(r => r.launchCleared !== true);

  const ranked = pending
    .map(robot => {
      const mission = missions.find(m => m.id === robot.missionId);
      const urgency = mission ? tick - mission.createdAtTick + mission.waitTicks : 0;
      return {
        robot,
        exitDistance: launchExitDistance(robot, graph, scenario),
        loaded: robot.carryingSlotId ? 1 : 0,
        urgency,
      };
    })
    .sort((a, b) =>
      a.exitDistance - b.exitDistance ||
      b.loaded - a.loaded ||
      b.urgency - a.urgency ||
      a.robot.id - b.robot.id
    );

  const radius = robotRadius(scenario);
  const clearanceM = scenario.simulation.robotClearanceMeters ?? 0.12;
  const corridorSeparation = radius * 2 + clearanceM + 0.6;

  const occupiedCorridors = cleared.map(r => launchCorridorSegment(r, graph, scenario));
  let slotsLeft = Math.max(0, MAX_CONCURRENT_LAUNCHES - cleared.length);

  ranked.forEach((entry, index) => {
    const robot = entry.robot;
    robot.launchPriority = index + 1;
    robot.launchWaveId = activeLaunchWaveId;
    const seg = launchCorridorSegment(robot, graph, scenario);

    let holdReason: string | undefined;
    if (slotsLeft <= 0) {
      holdReason = `Held for startup spacing: launch slots full (queue #${index + 1})`;
    } else if (occupiedCorridors.some(c => segmentsMinDistance(seg.a, seg.b, c.a, c.b) < corridorSeparation)) {
      holdReason = "Held for startup spacing: corridor crosses an active launch";
    } else {
      const dirX = seg.b.x - seg.a.x;
      const dirZ = seg.b.z - seg.a.z;
      const segLen = Math.hypot(dirX, dirZ);
      const blockerAhead = segLen > 0.05 && launching.some(other => {
        if (other.id === robot.id) return false;
        // Only robots in front along the launch direction count; one parked directly
        // behind this bay must not veto the launch.
        const along = ((other.position.x - seg.a.x) * dirX + (other.position.z - seg.a.z) * dirZ) / segLen;
        if (along <= 0.1) return false;
        return pointSegmentDistance(other.position, seg.a, seg.b) < corridorSeparation;
      });
      if (blockerAhead) holdReason = "Held for startup spacing: robot ahead in launch lane";
    }

    const heldTooLong = (robot.startupHoldTicks ?? 0) >= LAUNCH_FORCE_CLEAR_TICKS;
    if (!holdReason || heldTooLong) {
      robot.launchCleared = true;
      robot.launchReason = heldTooLong && holdReason
        ? "Cleared to launch: hold expired (anti-deadlock valve)"
        : `Cleared to launch (exit ${entry.exitDistance.toFixed(1)}m, wave ${activeLaunchWaveId})`;
      occupiedCorridors.push(seg);
      slotsLeft--;
      launchClearancesTotal++;
      recordLaunchDecision(tick, robot, "cleared", robot.launchReason);
    } else {
      const newlyHeld = robot.launchCleared !== false;
      robot.launchCleared = false;
      robot.startupHoldTicks = (robot.startupHoldTicks ?? 0) + 1;
      robot.launchReason = holdReason;
      if (newlyHeld) {
        launchHoldsTotal++;
        recordLaunchDecision(tick, robot, "held", holdReason);
      }
    }
  });

  launchHeldNow = launching.filter(r => r.launchCleared === false).length;
  launchClearedInZoneNow = launching.filter(r => r.launchCleared === true).length;
}

function updateStationQueues(scenario: WarehouseScenario, robots: RobotRuntime[], missions: Mission[]) {
  stationQueues = scenario.stations.map(station => {
    const approach = stationApproachPosition(station, scenario);
    const margin = robotRadius(scenario) + 0.5;
    const positions: Vec2[] = [
      approach,
      { x: approach.x - margin, z: approach.z },
      { x: approach.x + margin, z: approach.z },
    ];
    const occupiedBy: number[] = [];
    for (const robot of robots) {
      if (robot.state === "to-drop" || robot.state === "placing") {
        const m = missions.find(mi => mi.id === robot.missionId);
        if (m && m.targetStationId === station.id) {
          occupiedBy.push(robot.id);
        }
      }
    }
    return { stationId: station.id, approachPositions: positions, occupiedBy };
  });
}

function isStationApproachClear(
  station: WarehouseScenario["stations"][0],
  robot: RobotRuntime,
  robots: RobotRuntime[],
  scenario: WarehouseScenario
): boolean {
  const queue = stationQueues.find(q => q.stationId === station.id);
  if (!queue) return true;
  const otherAtStation = queue.occupiedBy.filter(id => id !== robot.id);
  return otherAtStation.length < station.queueCapacity;
}

function detectAndResolveDeadlocks(
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  missions: Mission[],
  congestionMap: Map<string, number>,
  solids: SolidRect[],
  tick: number
) {
  resolveImmediateRobotClusters(robots, scenario, missions, congestionMap, solids, tick);
  resolveMultiRobotTrafficChains(robots, scenario, missions, congestionMap, solids, tick);
  resolvePersistentRobotBlocks(robots, scenario, missions, congestionMap, solids, tick);
  const blockedRobots = robots.filter(r => r.blockedTicks >= 15 && r.path.length > 0 && r.state !== "yielding");
  if (blockedRobots.length < 2) return;

  const waitForGraph = new Map<number, number>();
  const minDist = robotRadius(scenario) * 2 + (scenario.simulation.robotClearanceMeters ?? 0.12);

  for (const robot of blockedRobots) {
    const target = robot.path[robot.pathIndex];
    if (!target) continue;

    for (const other of robots) {
      if (other.id === robot.id) continue;
      if (Math.hypot(other.position.x - target.x, other.position.z - target.z) < minDist * 1.5) {
        waitForGraph.set(robot.id, other.id);
        robot.waitingForRobotId = other.id;
        break;
      }
    }
  }

  const cycles = findCycles(waitForGraph);
  for (const cycle of cycles) {
    deadlocksDetected++;

    const sorted = cycle.map(id => robots.find(r => r.id === id)!).filter(Boolean);
    sorted.sort((a, b) => robotPriority(a) - robotPriority(b));
    const victim = sorted[0];

    recordTrafficEvent(tick, "deadlock", victim, undefined, `Deadlock cycle with ${cycle.length} robots`);
    if (startYieldManeuver(victim, robots, scenario, missions, congestionMap, solids, "Deadlock: yielding into side pocket", tick)) {
      deadlocksResolved++;
      continue;
    }

    const reversed = reverseOneStep(victim, robots, scenario);
    if (reversed) {
      victim.deadlockRecoveries++;
      deadlocksResolved++;
      const mission = missions.find(m => m.id === victim.missionId);
      if (mission) mission.statusNote = "Deadlock: reversed one step";
      continue;
    }

    victim.path = [];
    victim.pathIndex = 0;
    victim.blockedTicks = 0;
    victim.deadlockRecoveries++;
    deadlocksResolved++;
    const mission = missions.find(m => m.id === victim.missionId);
    if (mission) mission.statusNote = "Deadlock: priority escalation, replanning";
  }
}

function supervisorProtectionScore(robot: RobotRuntime, missions: Mission[], scenario: WarehouseScenario): number {
  const mission = missions.find(m => m.id === robot.missionId);
  const loadedBonus = robot.carryingSlotId ? 3000 : 0;
  const batteryUrgency = robot.batteryMinutes < 20 ? 1500 : 0;
  const returningPenalty = robot.state === "returning" && !mission && !robot.carryingSlotId ? -1600 : 0;
  const remainingPath = robot.path.length - robot.pathIndex;
  const speed = scenario.robots.speedMetersPerSecond * (scenario.simulation.tickMs / 1000);
  const etaTicks = remainingPath > 0 ? remainingPath / Math.max(speed, 0.01) : 999;
  const etaBonus = Math.max(0, 500 - etaTicks * 2);
  const missionUrgency = mission ? (mission.waitTicks * 5) : 0;
  return loadedBonus + batteryUrgency + returningPenalty + etaBonus + missionUrgency + robotPriority(robot);
}

function resolveMultiRobotTrafficChains(
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  missions: Mission[],
  congestionMap: Map<string, number>,
  solids: SolidRect[],
  tick: number
) {
  const blocked = robots.filter(robot =>
    robot.waitingForRobotId !== undefined &&
    robot.blockedTicks >= YIELD_BLOCKED_TICKS &&
    robot.state !== "yielding" &&
    robot.state !== "picking" &&
    robot.state !== "placing"
  );
  const handled = new Set<number>();

  for (const robot of blocked) {
    if (handled.has(robot.id)) continue;
    const chain = buildWaitChain(robot, robots);
    if (chain.length < 3) continue;

    const protectedRobot = chain.reduce((best, current) =>
      supervisorProtectionScore(current, missions, scenario) > supervisorProtectionScore(best, missions, scenario)
        ? current : best
    );

    const protectedReasons: string[] = [];
    if (protectedRobot.carryingSlotId) protectedReasons.push("loaded");
    if (protectedRobot.batteryMinutes < 20) protectedReasons.push("low-battery");
    const pMission = missions.find(m => m.id === protectedRobot.missionId);
    if (pMission && pMission.waitTicks > 30) protectedReasons.push("urgent-mission");
    if (protectedReasons.length === 0) protectedReasons.push("highest-priority");

    const blockers = chain
      .filter(candidate => candidate.id !== protectedRobot.id)
      .sort((a, b) => supervisorProtectionScore(a, missions, scenario) - supervisorProtectionScore(b, missions, scenario));

    const decision: SupervisorDecision = {
      tick,
      clusterSize: chain.length,
      protectedRobotId: protectedRobot.id,
      protectedReason: protectedReasons.join(", "),
      commands: [],
    };

    let moved = 0;
    for (const blocker of blockers) {
      if (moved >= 2) break;

      let command: SupervisorCommand;
      let success = false;
      let reason: string;

      const bayTarget = findNearestYieldBay(blocker, robots, scenario, solids);
      if (bayTarget) {
        command = "yield-to-bay";
        reason = `Yield to bay at (${bayTarget.x.toFixed(1)}, ${bayTarget.z.toFixed(1)})`;
        success = startYieldManeuver(
          blocker, robots, scenario, missions, congestionMap, solids,
          `Supervisor: ${reason} for R${String(protectedRobot.id).padStart(2, "0")}`, tick
        );
      } else if (reverseOneStep(blocker, robots, scenario)) {
        command = "reverse";
        reason = "Reversed one step to clear path";
        success = true;
        blocker.deadlockRecoveries++;
        const bMission = missions.find(m => m.id === blocker.missionId);
        if (bMission) bMission.statusNote = `Supervisor: ${reason}`;
      } else {
        const pocketTarget = findYieldTarget(blocker, robots, scenario, solids);
        if (pocketTarget) {
          command = "move-to-pocket";
          reason = "Move to side pocket";
          success = startYieldManeuver(
            blocker, robots, scenario, missions, congestionMap, solids,
            `Supervisor: ${reason} for R${String(protectedRobot.id).padStart(2, "0")}`, tick
          );
        } else {
          command = "wait";
          reason = "No clear path; waiting";
          blocker.waitTicks = Math.max(blocker.waitTicks, YIELD_WAIT_TICKS);
          success = true;
        }
      }

      if (success) {
        moved++;
        handled.add(blocker.id);
        decision.commands.push({ robotId: blocker.id, command, reason });
        recordTrafficEvent(
          tick, "cluster-resolve", protectedRobot, blocker.id,
          `Supervisor: R${String(blocker.id).padStart(2, "0")} ${command} to free R${String(protectedRobot.id).padStart(2, "0")}`
        );
      }
    }

    if (moved > 0) {
      deadlocksDetected++;
      deadlocksResolved++;
      supervisorDecisions.push(decision);
      if (supervisorDecisions.length > 100) supervisorDecisions = supervisorDecisions.slice(-60);
      for (const member of chain) handled.add(member.id);
    }
  }
}

function resolveImmediateRobotClusters(
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  missions: Mission[],
  congestionMap: Map<string, number>,
  solids: SolidRect[],
  tick: number
) {
  const clusters = findImmediateConflictClusters(robots, scenario);
  const handled = new Set<number>();

  for (const cluster of clusters) {
    const liveCluster = cluster.filter(robot => !handled.has(robot.id));
    if (liveCluster.length < 3 || !clusterNeedsSupervisor(liveCluster, robots, scenario)) continue;

    const protectedRobot = liveCluster.reduce((best, current) =>
      supervisorProtectionScore(current, missions, scenario) > supervisorProtectionScore(best, missions, scenario)
        ? current : best
    );

    const blockers = liveCluster
      .filter(robot => robot.id !== protectedRobot.id)
      .sort((a, b) => supervisorProtectionScore(a, missions, scenario) - supervisorProtectionScore(b, missions, scenario));

    const decision: SupervisorDecision = {
      tick,
      clusterSize: liveCluster.length,
      protectedRobotId: protectedRobot.id,
      protectedReason: protectedRobot.carryingSlotId ? "loaded-cluster-priority" : "mission-cluster-priority",
      commands: [],
    };

    let moved = 0;
    for (const blocker of blockers) {
      if (moved >= Math.min(3, liveCluster.length - 1)) break;
      if (blocker.state === "picking" || blocker.state === "placing" || blocker.state === "charging") continue;

      let command: SupervisorCommand = "wait";
      let reason = "Cluster wait";
      let success = false;

      const escapeTarget = findClusterClearanceTarget(blocker, protectedRobot, liveCluster, robots, scenario, solids);
      if (escapeTarget && startDirectedYieldManeuver(
        blocker,
        escapeTarget,
        protectedRobot.id,
        robots,
        scenario,
        missions,
        congestionMap,
        solids,
        `3+ robot cluster: clearing lane for R${String(protectedRobot.id).padStart(2, "0")}`,
        tick
      )) {
        command = "move-to-pocket";
        reason = `Cluster escape to (${escapeTarget.x.toFixed(1)}, ${escapeTarget.z.toFixed(1)})`;
        success = true;
      } else if (startYieldManeuver(
        blocker,
        robots,
        scenario,
        missions,
        congestionMap,
        solids,
        `3+ robot cluster: yielding for R${String(protectedRobot.id).padStart(2, "0")}`,
        tick
      )) {
        command = "yield-to-bay";
        reason = "Cluster yield to nearest safe bay";
        success = true;
      } else if (reverseOneStep(blocker, robots, scenario)) {
        command = "reverse";
        reason = "Cluster reverse one waypoint";
        blocker.deadlockRecoveries++;
        blocker.waitTicks = Math.max(blocker.waitTicks, 4);
        success = true;
      } else {
        blocker.waitTicks = Math.max(blocker.waitTicks, 8);
        blocker.currentSpeedMps = 0;
        reason = "Cluster hold position";
        success = true;
      }

      if (!success) continue;
      moved++;
      handled.add(blocker.id);
      decision.commands.push({ robotId: blocker.id, command, reason });
      recordTrafficEvent(
        tick,
        "cluster-resolve",
        protectedRobot,
        blocker.id,
        `3+ robot cluster: R${String(blocker.id).padStart(2, "0")} ${command} to free R${String(protectedRobot.id).padStart(2, "0")}`
      );
    }

    if (moved > 0) {
      deadlocksDetected++;
      deadlocksResolved++;
      handled.add(protectedRobot.id);
      supervisorDecisions.push(decision);
      if (supervisorDecisions.length > 100) supervisorDecisions = supervisorDecisions.slice(-60);
    }
  }
}

function findImmediateConflictClusters(robots: RobotRuntime[], scenario: WarehouseScenario): RobotRuntime[][] {
  const candidates = robots.filter(robot =>
    robot.state !== "charging" &&
    robot.state !== "picking" &&
    robot.state !== "placing" &&
    (
      robot.path.length > 0 ||
      robot.waitingForRobotId !== undefined ||
      robot.state === "yielding"
    )
  );
  if (candidates.length < 3) return [];

  const radius = robotRadius(scenario);
  const clearance = scenario.simulation.robotClearanceMeters ?? 0.12;
  const minDistance = radius * 2 + clearance + 0.18;
  const clusterDistance = minDistance * 1.55;
  const adjacency = new Map<number, Set<number>>();

  for (const robot of candidates) adjacency.set(robot.id, new Set());
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      if (!robotsHaveImmediateConflict(a, b, scenario, minDistance, clusterDistance)) continue;
      adjacency.get(a.id)!.add(b.id);
      adjacency.get(b.id)!.add(a.id);
    }
  }

  const byId = new Map(candidates.map(robot => [robot.id, robot]));
  const visited = new Set<number>();
  const clusters: RobotRuntime[][] = [];
  for (const robot of candidates) {
    if (visited.has(robot.id)) continue;
    const stack = [robot.id];
    const cluster: RobotRuntime[] = [];
    visited.add(robot.id);
    while (stack.length > 0) {
      const id = stack.pop()!;
      const member = byId.get(id);
      if (member) cluster.push(member);
      for (const nextId of adjacency.get(id) ?? []) {
        if (visited.has(nextId)) continue;
        visited.add(nextId);
        stack.push(nextId);
      }
    }
    if (cluster.length >= 3) clusters.push(cluster);
  }

  return clusters;
}

function robotsHaveImmediateConflict(
  a: RobotRuntime,
  b: RobotRuntime,
  scenario: WarehouseScenario,
  minDistance: number,
  clusterDistance: number
): boolean {
  if (distance(a.position, b.position) < clusterDistance) return true;

  const baseStep = scenario.robots.speedMetersPerSecond * (scenario.simulation.tickMs / 1000);
  for (const horizon of [1, 2, 3, 4]) {
    const aFuture = projectRobotPosition(a, baseStep * horizon);
    const bFuture = projectRobotPosition(b, baseStep * horizon);
    if (distance(aFuture, bFuture) < minDistance) return true;
  }

  const aDir = currentPathDirection(a);
  const bDir = currentPathDirection(b);
  if (!aDir || !bDir) return false;
  const dot = aDir.x * bDir.x + aDir.z * bDir.z;
  return dot < -0.45 && distance(a.position, b.position) < clusterDistance * 1.8;
}

function clusterNeedsSupervisor(
  cluster: RobotRuntime[],
  robots: RobotRuntime[],
  scenario: WarehouseScenario
): boolean {
  const radius = robotRadius(scenario);
  const clearance = scenario.simulation.robotClearanceMeters ?? 0.12;
  const conflictDistance = radius * 2 + Math.max(0.04, clearance * 0.3);
  const hasCloseConflict = cluster.some((robot, i) =>
    cluster.slice(i + 1).some(other => distance(robot.position, other.position) < conflictDistance)
  );
  const confirmedBlocked = cluster.filter(robot =>
    robot.waitingForRobotId !== undefined && robot.blockedTicks >= 4
  ).length >= 2;
  if (!hasCloseConflict && !confirmedBlocked) return false;
  return cluster.some(robot => robot.missionId || robot.carryingSlotId || robot.state === "returning" || robot.state === "to-point") ||
    cluster.some(robot => !isRobotInValidParking(robot, robots, scenario));
}

function findClusterClearanceTarget(
  robot: RobotRuntime,
  protectedRobot: RobotRuntime,
  cluster: RobotRuntime[],
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  solids: SolidRect[]
): Vec2 | undefined {
  const radius = robotRadius(scenario);
  const clearance = scenario.simulation.robotClearanceMeters ?? 0.12;
  const minDistance = radius * 2 + clearance + 0.55;
  const center = cluster.reduce<Vec2>((acc, member) => ({
    x: acc.x + member.position.x / cluster.length,
    z: acc.z + member.position.z / cluster.length,
  }), { x: 0, z: 0 });
  const awayRaw = { x: robot.position.x - center.x, z: robot.position.z - center.z };
  const awayLen = Math.hypot(awayRaw.x, awayRaw.z) || 1;
  const away = { x: awayRaw.x / awayLen, z: awayRaw.z / awayLen };
  const pathDir = currentPathDirection(robot) ?? away;
  const left = { x: -pathDir.z, z: pathDir.x };
  const right = { x: pathDir.z, z: -pathDir.x };
  const back = { x: -pathDir.x, z: -pathDir.z };
  const protectedNext = protectedRobot.path[protectedRobot.pathIndex] ?? protectedRobot.position;

  const candidates: Vec2[] = [];
  for (const dist of [minDistance, minDistance * 1.6, minDistance * 2.3, minDistance * 3.1]) {
    candidates.push(offsetPoint(robot.position, away, dist));
    candidates.push(offsetPoint(robot.position, back, dist));
    candidates.push(offsetPoint(offsetPoint(robot.position, back, minDistance * 0.75), left, dist));
    candidates.push(offsetPoint(offsetPoint(robot.position, back, minDistance * 0.75), right, dist));
    candidates.push(offsetPoint(robot.position, left, dist));
    candidates.push(offsetPoint(robot.position, right, dist));
  }

  return candidates
    .filter(candidate =>
      distance(candidate, protectedRobot.position) > minDistance * 1.4 &&
      distance(candidate, protectedNext) > minDistance * 1.25 &&
      isYieldTargetClear(robot, candidate, robots, scenario, solids)
    )
    .sort((a, b) => {
      const aScore = distance(a, center) + distance(a, protectedNext) * 0.3;
      const bScore = distance(b, center) + distance(b, protectedNext) * 0.3;
      return bScore - aScore;
    })[0];
}

function startDirectedYieldManeuver(
  robot: RobotRuntime,
  target: Vec2,
  blockedByRobotId: number | undefined,
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  missions: Mission[],
  congestionMap: Map<string, number>,
  solids: SolidRect[],
  note: string,
  tick: number
): boolean {
  if (robot.state === "yielding" || robot.state === "picking" || robot.state === "placing") return false;
  if (robot.consecutiveYields >= MAX_CONSECUTIVE_YIELDS) return false;
  if (!isYieldTargetClear(robot, target, robots, scenario, solids)) return false;

  robot.preYieldState = robot.state;
  robot.state = "yielding";
  robot.yieldTarget = target;
  robot.path = buildYieldPath(robot.position, target, solids, robotRadius(scenario), robots, robot.id);
  robot.pathIndex = 0;
  robot.blockedTicks = 0;
  robot.waitingForRobotId = undefined;
  robot.waitTicks = 0;
  robot.currentSpeedMps = 0;
  robot.deadlockRecoveries++;
  robot.consecutiveYields++;
  congestionMap.set(aisleKey(robot.position), (congestionMap.get(aisleKey(robot.position)) ?? 0) + 1);

  recordTrafficEvent(tick, "yield", robot, blockedByRobotId, note);

  const mission = missions.find(m => m.id === robot.missionId);
  if (mission) {
    mission.statusNote = note;
    mission.yieldCount = (mission.yieldCount ?? 0) + 1;
  }
  return true;
}

function buildWaitChain(start: RobotRuntime, robots: RobotRuntime[]): RobotRuntime[] {
  const chain: RobotRuntime[] = [];
  const seen = new Set<number>();
  let current: RobotRuntime | undefined = start;
  while (current && !seen.has(current.id) && chain.length < 8) {
    chain.push(current);
    seen.add(current.id);
    current = current.waitingForRobotId !== undefined
      ? robots.find(robot => robot.id === current!.waitingForRobotId)
      : undefined;
  }
  return chain;
}

function resolvePersistentRobotBlocks(
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  missions: Mission[],
  congestionMap: Map<string, number>,
  solids: SolidRect[],
  tick: number
) {
  const candidates = robots.filter(robot =>
    robot.waitingForRobotId !== undefined &&
    robot.blockedTicks >= YIELD_BLOCKED_TICKS &&
    robot.state !== "yielding" &&
    robot.state !== "picking" &&
    robot.state !== "placing" &&
    robot.path.length > 0
  );

  const handled = new Set<number>();
  for (const robot of candidates) {
    if (handled.has(robot.id)) continue;
    const other = robots.find(r => r.id === robot.waitingForRobotId);
    if (!other || other.state === "yielding") continue;

    const isHeadOn = other.waitingForRobotId === robot.id;
    if (isHeadOn) {
      recordTrafficEvent(tick, "head-on", robot, other.id, "Head-on conflict detected");
    }

    if (isActiveMissionRobot(robot) && other.state === "idle") {
      if (startParkingShuffle(other, robot, robots, scenario, missions, congestionMap, solids, tick)) {
        deadlocksDetected++;
        deadlocksResolved++;
        handled.add(robot.id);
        handled.add(other.id);
        continue;
      }
    }

    if ((robot.state === "returning" || robot.state === "to-charge") && other.state === "idle") {
      if (robot.state === "returning" && redirectReturningRobotToFreeStandby(robot, robots, scenario, solids, tick)) {
        deadlocksDetected++;
        deadlocksResolved++;
        handled.add(robot.id);
        handled.add(other.id);
        continue;
      }
      // Home-slot parking cannot redirect the returning robot (its bay is fixed), so the
      // parked robot steps aside instead and auto-rehomes once the lane is clear again.
      if (startParkingShuffle(other, robot, robots, scenario, missions, congestionMap, solids, tick)) {
        deadlocksDetected++;
        deadlocksResolved++;
        handled.add(robot.id);
        handled.add(other.id);
        continue;
      }
    }

    const victim = chooseYieldVictim(robot, other);
    if (victim !== robot) {
      recordTrafficEvent(tick, "priority-pass", robot, other.id,
        `R${String(robot.id).padStart(2, "0")} has priority (${robot.carryingSlotId ? "loaded" : "empty"}, bat=${Math.round(robot.batteryMinutes)})`);
    }

    if (startYieldManeuver(victim, robots, scenario, missions, congestionMap, solids, "Yielding to clear head-on traffic", tick)) {
      deadlocksDetected++;
      deadlocksResolved++;
      handled.add(robot.id);
      handled.add(other.id);
    }
  }
}

/**
 * Depot columns fill deepest-bay-first: a robot must not drive into (or re-home onto)
 * its bay while another robot is still inbound to a DEEPER bay in the same column,
 * because the only access runs straight through the shallower bay. The shallower robot
 * waits (parked aside or holding) until the deeper sibling has docked.
 */
function holdForInboundDeeperColumnRobot(
  robot: RobotRuntime,
  robots: RobotRuntime[],
  scenario: WarehouseScenario
): boolean {
  const myTarget = parkingTarget(robot);
  const tolerance = standbyArrivalTolerance(scenario);
  return robots.some(other => {
    if (other.id === robot.id) return false;
    if (other.state !== "returning" && other.state !== "to-charge") return false;
    const otherTarget = other.state === "to-charge" ? undefined : parkingTarget(other);
    if (!otherTarget) return false;
    if (Math.abs(otherTarget.x - myTarget.x) > 0.6) return false;            // different column
    if (Math.sign(otherTarget.z) !== Math.sign(myTarget.z)) return false;     // different depot side
    if (Math.abs(otherTarget.z) <= Math.abs(myTarget.z) + 0.3) return false;  // not deeper
    return distance(other.position, otherTarget) > tolerance;                 // still inbound
  });
}

function isActiveMissionRobot(robot: RobotRuntime): boolean {
  return robot.missionId !== undefined &&
    robot.state !== "idle" &&
    robot.state !== "returning" &&
    robot.state !== "yielding" &&
    robot.state !== "picking" &&
    robot.state !== "placing";
}

function chooseYieldVictim(a: RobotRuntime, b: RobotRuntime): RobotRuntime {
  const pa = robotPriority(a);
  const pb = robotPriority(b);
  if (pa < pb) return a;
  if (pb < pa) return b;
  return a.id > b.id ? a : b;
}

function startYieldManeuver(
  robot: RobotRuntime,
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  missions: Mission[],
  congestionMap: Map<string, number>,
  solids: SolidRect[],
  note: string,
  tick?: number
): boolean {
  if (robot.state === "yielding" || robot.state === "picking" || robot.state === "placing") return false;
  if (robot.consecutiveYields >= MAX_CONSECUTIVE_YIELDS) return false;
  const blockedByRobotId = robot.waitingForRobotId;

  const bayTarget = scenario.simulation.showYieldBays !== false
    ? findNearestYieldBay(robot, robots, scenario, solids)
    : undefined;
  const target = bayTarget ?? findYieldTarget(robot, robots, scenario, solids);
  if (!target) return false;

  robot.preYieldState = robot.state;
  robot.state = "yielding";
  robot.yieldTarget = target;
  robot.path = buildYieldPath(robot.position, target, solids, robotRadius(scenario), robots, robot.id);
  robot.pathIndex = 0;
  robot.blockedTicks = 0;
  robot.waitingForRobotId = undefined;
  robot.waitTicks = 0;
  robot.deadlockRecoveries++;
  robot.consecutiveYields++;
  congestionMap.set(aisleKey(robot.position), (congestionMap.get(aisleKey(robot.position)) ?? 0) + 1);

  if (bayTarget) {
    const bay = yieldBays.find(b =>
      Math.hypot(b.position.x - bayTarget.x, b.position.z - bayTarget.z) < 0.1
    );
    if (bay) bay.occupied = true;
  }

  recordTrafficEvent(tick ?? 0, "yield", robot, blockedByRobotId, note);

  const mission = missions.find(m => m.id === robot.missionId);
  if (mission) {
    mission.statusNote = note;
    mission.yieldCount = (mission.yieldCount ?? 0) + 1;
  }
  return true;
}

function startParkingShuffle(
  parkedRobot: RobotRuntime,
  protectedRobot: RobotRuntime,
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  missions: Mission[],
  congestionMap: Map<string, number>,
  solids: SolidRect[],
  tick: number
): boolean {
  const target = findParkingShuffleTarget(parkedRobot, protectedRobot, robots, scenario, solids);
  if (!target) return false;

  parkedRobot.preYieldState = "idle";
  parkedRobot.state = "yielding";
  parkedRobot.yieldTarget = target;
  if (canDynamicallyReassignParking(scenario)) {
    parkedRobot.assignedParkingPosition = { ...target };
  }
  parkedRobot.path = buildYieldPath(parkedRobot.position, target, solids, robotRadius(scenario), robots, parkedRobot.id);
  parkedRobot.pathIndex = 0;
  parkedRobot.blockedTicks = 0;
  parkedRobot.waitingForRobotId = undefined;
  parkedRobot.waitTicks = 0;
  parkedRobot.deadlockRecoveries++;
  parkedRobot.consecutiveYields++;
  congestionMap.set(aisleKey(parkedRobot.position), (congestionMap.get(aisleKey(parkedRobot.position)) ?? 0) + 1);

  recordTrafficEvent(
    tick,
    "yield",
    parkedRobot,
    protectedRobot.id,
    `Parking shuffle: R${String(parkedRobot.id).padStart(2, "0")} clears dispatch lane for R${String(protectedRobot.id).padStart(2, "0")}`
  );

  const mission = missions.find(m => m.id === protectedRobot.missionId);
  if (mission) mission.statusNote = `Parking shuffle requested from R${String(parkedRobot.id).padStart(2, "0")}`;
  return true;
}

function findParkingShuffleTarget(
  parkedRobot: RobotRuntime,
  protectedRobot: RobotRuntime,
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  solids: SolidRect[]
): Vec2 | undefined {
  const radius = robotRadius(scenario);
  const clearance = scenario.simulation.robotClearanceMeters ?? 0.12;
  const minRobotDistance = radius * 2 + clearance + 0.55;
  const halfW = scenario.warehouse.width / 2;
  const halfD = scenario.warehouse.depth / 2;
  const awayFromProtectedPath = protectedRobot.path[protectedRobot.pathIndex] ?? protectedRobot.position;

  const candidates: Vec2[] = [];
  // Prefer a nearby FREE parking bay as the shuffle pocket: between occupied depot bays
  // there is often no legal ad-hoc pocket, and a free bay is guaranteed well-spaced.
  const nearbyFreeBays = parkingBayRegistry
    .filter(bay => bay.state === "free" && distance(bay.position, parkedRobot.position) <= 9)
    .sort((a, b) => distance(a.position, parkedRobot.position) - distance(b.position, parkedRobot.position))
    .slice(0, 4)
    .map(bay => ({ ...bay.position }));
  candidates.push(...nearbyFreeBays);

  const backClearance = Math.max(radius * 2.2, 1.7);
  for (const dz of [-backClearance, -backClearance * 1.7, backClearance, backClearance * 1.7]) {
    candidates.push({ x: parkedRobot.position.x, z: parkedRobot.position.z + dz });
  }
  for (const dx of [-minRobotDistance, minRobotDistance, -minRobotDistance * 1.7, minRobotDistance * 1.7]) {
    candidates.push({ x: parkedRobot.position.x + dx, z: parkedRobot.position.z });
    candidates.push({ x: parkedRobot.position.x + dx, z: parkedRobot.position.z - backClearance });
  }

  for (const candidate of candidates) {
    if (
      candidate.x - radius < -halfW ||
      candidate.x + radius > halfW ||
      candidate.z - radius < -halfD ||
      candidate.z + radius > halfD
    ) continue;
    if (!isBodyClearSegment(parkedRobot.position, candidate, solids, radius)) continue;
    if (Math.hypot(candidate.x - awayFromProtectedPath.x, candidate.z - awayFromProtectedPath.z) < minRobotDistance * 1.25) continue;
    // The pocket must clear the protected robot's WHOLE remaining route, not just its
    // next waypoint — otherwise the parked robot hops further up the same depot column
    // and blocks the protected robot again a few metres later.
    if (robotPathPassesNear(protectedRobot, candidate, minRobotDistance * 1.2)) continue;
    if (isStationTrafficKeepout(candidate, scenario)) continue;
    if (robots.some(other =>
      other.id !== parkedRobot.id &&
      Math.hypot(other.position.x - candidate.x, other.position.z - candidate.z) < minRobotDistance
    )) continue;
    return candidate;
  }

  return undefined;
}

function redirectReturningRobotToFreeStandby(
  robot: RobotRuntime,
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  solids: SolidRect[],
  tick: number
): boolean {
  if (!canDynamicallyReassignParking(scenario)) return false;

  const target = findAvailableStandbyTarget(robot, robots, scenario, solids);
  if (!target) return false;

  robot.assignedParkingPosition = { ...target };
  robot.path = buildYieldPath(robot.position, target, solids, robotRadius(scenario), robots, robot.id);
  robot.pathIndex = 0;
  robot.blockedTicks = 0;
  robot.waitingForRobotId = undefined;
  robot.deadlockRecoveries++;

  recordTrafficEvent(
    tick,
    "cluster-resolve",
    robot,
    undefined,
    `Return reroute: R${String(robot.id).padStart(2, "0")} assigned free standby bay`
  );
  return true;
}

function findAvailableStandbyTarget(
  robot: RobotRuntime,
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  solids: SolidRect[]
): Vec2 | undefined {
  const radius = robotRadius(scenario);
  const clearance = scenario.simulation.robotClearanceMeters ?? 0.12;
  const minRobotDistance = radius * 2 + clearance + 0.55;
  const candidates = [
    ...buildParkingPositions(scenario, Math.max(scenario.robots.count + 12, robots.length + 12)),
    ...nearbyStandbyOffsets(robot, minRobotDistance),
  ];

  return candidates.find(candidate => {
    if (Math.hypot(candidate.x - robot.position.x, candidate.z - robot.position.z) < minRobotDistance * 0.7) return false;
    if (!pointInsideWarehouse(candidate, scenario, radius + 0.35)) return false;
    if (!isBodyClearSegment(robot.position, candidate, solids, radius)) return false;
    if (isStationTrafficKeepout(candidate, scenario)) return false;
    return robots.every(other =>
      other.id === robot.id ||
      (
        Math.hypot(other.position.x - candidate.x, other.position.z - candidate.z) >= minRobotDistance &&
        distance(other.assignedParkingPosition ?? other.homePosition, candidate) >= minRobotDistance
      )
    );
  });
}

function nearbyStandbyOffsets(robot: RobotRuntime, spacing: number): Vec2[] {
  return [
    { x: robot.position.x - spacing, z: robot.position.z },
    { x: robot.position.x + spacing, z: robot.position.z },
    { x: robot.position.x, z: robot.position.z - spacing },
    { x: robot.position.x, z: robot.position.z + spacing },
    { x: robot.position.x - spacing, z: robot.position.z - spacing },
    { x: robot.position.x + spacing, z: robot.position.z - spacing },
  ];
}

function findYieldTarget(
  robot: RobotRuntime,
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  solids: SolidRect[]
): Vec2 | undefined {
  const target = robot.path[robot.pathIndex] ?? robot.homePosition;
  const dx = target.x - robot.position.x;
  const dz = target.z - robot.position.z;
  const len = Math.hypot(dx, dz) || 1;
  const forward = { x: dx / len, z: dz / len };
  const back = { x: -forward.x, z: -forward.z };
  const left = { x: -forward.z, z: forward.x };
  const right = { x: forward.z, z: -forward.x };
  const step = Math.max(robotRadius(scenario) * 2.8, 1.4);

  const candidates: Vec2[] = [];
  for (const dist of [step, step * 1.5, step * 2.1]) {
    candidates.push(offsetPoint(robot.position, back, dist));
    candidates.push(offsetPoint(offsetPoint(robot.position, back, step * 0.75), left, dist));
    candidates.push(offsetPoint(offsetPoint(robot.position, back, step * 0.75), right, dist));
    candidates.push(offsetPoint(robot.position, left, dist));
    candidates.push(offsetPoint(robot.position, right, dist));
    candidates.push(offsetPoint(offsetPoint(robot.position, forward, step * 0.75), left, dist));
    candidates.push(offsetPoint(offsetPoint(robot.position, forward, step * 0.75), right, dist));
    candidates.push(offsetPoint(robot.position, forward, dist));
  }

  return candidates.find(candidate => isYieldTargetClear(robot, candidate, robots, scenario, solids));
}

function offsetPoint(origin: Vec2, direction: Vec2, distance: number): Vec2 {
  return {
    x: origin.x + direction.x * distance,
    z: origin.z + direction.z * distance,
  };
}

/**
 * Segment clearance for a robot *body* (not a zero-width line): samples the swept disc
 * along the segment. isClearSegment alone misses obstacles the line passes beside but
 * the body clips — e.g. station bollards next to a yield escape lane, which used to
 * trap empty robots in an unreachable-yield-target loop at the pack stations.
 */
function isBodyClearSegment(a: Vec2, b: Vec2, solids: SolidRect[], radius: number): boolean {
  const length = distance(a, b);
  const steps = Math.max(1, Math.ceil(length / 0.3));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const point: Vec2 = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    for (const solid of solids) {
      if (circleIntersectsRect(point, radius, solid)) return false;
    }
  }
  return true;
}

function isYieldTargetClear(
  robot: RobotRuntime,
  candidate: Vec2,
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  solids: SolidRect[]
): boolean {
  const radius = robotRadius(scenario);
  const halfW = scenario.warehouse.width / 2;
  const halfD = scenario.warehouse.depth / 2;
  if (
    candidate.x - radius < -halfW ||
    candidate.x + radius > halfW ||
    candidate.z - radius < -halfD ||
    candidate.z + radius > halfD
  ) {
    return false;
  }

  if (!isBodyClearSegment(robot.position, candidate, solids, radius)) return false;

  // An empty robot must never yield into a station entrance or queue lane: it camps
  // there and livelocks every mission bound for that station. Loaded robots queueing
  // for a drop are legitimate short-term occupants and stay exempt.
  if (!robot.carryingSlotId && isStationTrafficKeepout(candidate, scenario)) return false;

  const minRobotDistance = radius * 2 + (scenario.simulation.robotClearanceMeters ?? 0.12) + 0.35;
  for (const other of robots) {
    if (other.id === robot.id) continue;
    if (Math.hypot(other.position.x - candidate.x, other.position.z - candidate.z) < minRobotDistance) {
      return false;
    }
  }

  return true;
}

function buildYieldPath(
  from: Vec2,
  target: Vec2,
  solids: SolidRect[],
  bodyRadius?: number,
  robots?: RobotRuntime[],
  selfId?: number
): Vec2[] {
  const radius = bodyRadius ?? 0;
  const legClear = (a: Vec2, b: Vec2) =>
    radius > 0 ? isBodyClearSegment(a, b, solids, radius) : isClearSegment(a, b, solids);
  const viaX: Vec2 = { x: target.x, z: from.z };
  const viaZ: Vec2 = { x: from.x, z: target.z };
  const options = [viaX, viaZ].filter(via => legClear(from, via) && legClear(via, target));

  if (options.length > 0) {
    // Prefer the L-bend whose first leg keeps the most distance to other robots, so an
    // escaping robot does not drive straight at the robot it is yielding for.
    let best = options[0];
    if (options.length > 1 && robots && robots.length > 0) {
      const firstLegRobotDistance = (via: Vec2) => {
        let minD = Infinity;
        for (const other of robots) {
          if (other.id === selfId) continue;
          minD = Math.min(minD, pointSegmentDistance(other.position, from, via));
        }
        return minD;
      };
      best = options.reduce((a, b) => (firstLegRobotDistance(b) > firstLegRobotDistance(a) ? b : a));
    }
    return [best, target].filter(point => Math.hypot(point.x - from.x, point.z - from.z) > 0.05);
  }
  return [target];
}

function resumeAfterYield(robot: RobotRuntime, missions: Mission[]) {
  const previous = robot.preYieldState;
  const mission = missions.find(m => m.id === robot.missionId);

  if (robot.yieldTarget) {
    const bay = yieldBays.find(b =>
      Math.hypot(b.position.x - robot.yieldTarget!.x, b.position.z - robot.yieldTarget!.z) < 0.1
    );
    if (bay) bay.occupied = false;
  }

  robot.preYieldState = undefined;
  robot.yieldTarget = undefined;
  robot.waitingForRobotId = undefined;
  robot.blockedTicks = 0;
  robot.path = [];
  robot.pathIndex = 0;
  robot.consecutiveYields = 0;

  if (!previous || previous === "yielding") {
    robot.state = mission ? "to-pick" : "idle";
  } else if (!mission && previous !== "returning" && previous !== "to-charge") {
    robot.state = "idle";
  } else {
    robot.state = previous;
  }

  if (mission && mission.status !== "done" && mission.status !== "failed") {
    mission.statusNote = "Resuming mission after yielding";
  }
}

function findCycles(graph: Map<number, number>): number[][] {
  const cycles: number[][] = [];
  const visited = new Set<number>();

  for (const startId of graph.keys()) {
    if (visited.has(startId)) continue;
    const path: number[] = [];
    const pathSet = new Set<number>();
    let current: number | undefined = startId;

    while (current !== undefined && !visited.has(current)) {
      if (pathSet.has(current)) {
        const cycleStart = path.indexOf(current);
        cycles.push(path.slice(cycleStart));
        break;
      }
      path.push(current);
      pathSet.add(current);
      current = graph.get(current);
    }

    for (const id of path) visited.add(id);
  }

  return cycles;
}

function reverseOneStep(
  robot: RobotRuntime,
  robots: RobotRuntime[],
  scenario: WarehouseScenario
): boolean {
  if (robot.pathIndex <= 0 || robot.path.length === 0) return false;
  const prevPos = robot.path[robot.pathIndex - 1] ?? robot.homePosition;

  const minDist = robotRadius(scenario) * 2 + (scenario.simulation.robotClearanceMeters ?? 0.12);
  for (const other of robots) {
    if (other.id === robot.id) continue;
    if (Math.hypot(other.position.x - prevPos.x, other.position.z - prevPos.z) < minDist) {
      return false;
    }
  }

  robot.position = { ...prevPos };
  robot.pathIndex = Math.max(0, robot.pathIndex - 1);
  robot.blockedTicks = 0;
  robot.path = [];
  robot.pathIndex = 0;
  return true;
}

function startReturnToStandby(
  robot: RobotRuntime,
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  graph: NavGraph,
  ctx?: CongestionContext,
  tick?: number
) {
  robot.state = "returning";
  robot.waitTicks = 0;
  robot.blockedTicks = 0;
  const solids = buildSolidObstacles(scenario);
  robot.path = buildReturnPathToStandby(robot, robots, scenario, graph, solids, ctx);
  robot.pathIndex = 0;
  updateBayStateForRobot(robot, "reserved");
  if (tick !== undefined) {
    registerRouteReservations(robot, robot.path, tick, scenario);
  }
}

function buildReturnPathToStandby(
  robot: RobotRuntime,
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  graph: NavGraph,
  solids: SolidRect[],
  ctx?: CongestionContext
): Vec2[] {
  const assignment = allocateParkingTarget(robot, robots.length > 0 ? robots : [robot], scenario, graph, solids, ctx);
  const target = assignment?.target ?? parkingTarget(robot);
  if (assignment) {
    robot.assignedParkingPosition = { ...assignment.target };
    if (!robot.assignedParkingBayId) {
      const bayId = findBayIdForPosition(assignment.target, standbyArrivalTolerance(scenario) * 3);
      if (bayId) robot.assignedParkingBayId = bayId;
    }
  }

  if (distance(robot.position, target) <= standbyArrivalTolerance(scenario)) {
    return [{ ...target }];
  }

  const directPath = assignment?.path ?? (ctx
    ? pathToPointPredictive(graph, robot.position, target, ctx)
    : pathToPoint(graph, robot.position, target));
  if (isReturnPathUsable(directPath, target, solids, scenario)) {
    return directPath;
  }

  const spacing = Math.max(scenario.robots.footprintWidth, scenario.robots.footprintDepth) +
    (scenario.simulation.robotClearanceMeters ?? 0.12) + 0.65;
  const approachCandidates = standbyApproachCandidates(target, spacing)
    .filter(candidate => !pointInsideSolid(candidate, solids))
    .filter(candidate => isClearSegment(candidate, target, solids));

  for (const candidate of approachCandidates) {
    const candidatePath = ctx
      ? pathToPointPredictive(graph, robot.position, candidate, ctx)
      : pathToPoint(graph, robot.position, candidate);
    const path = appendReturnEndpoint(candidatePath, target, solids);
    if (isReturnPathUsable(path, target, solids, scenario)) {
      return path;
    }
  }

  const nearestHomeNodeId = findNearestNodeId(graph.nodes, target);
  const nearestRobotNodeId = findNearestNodeId(graph.nodes, robot.position);
  if (nearestHomeNodeId && nearestRobotNodeId) {
    const nodePath = aStar(graph, nearestRobotNodeId, nearestHomeNodeId);
    const path = appendReturnEndpoint([{ ...robot.position }, ...nodePath], target, solids);
    if (isReturnPathUsable(path, target, solids, scenario)) {
      return path;
    }
  }

  return [{ ...robot.position }];
}

function allocateParkingTarget(
  robot: RobotRuntime,
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  graph: NavGraph,
  solids: SolidRect[],
  ctx?: CongestionContext
): { target: Vec2; path: Vec2[] } | undefined {
  if (isHomeParkingStrategy(scenario)) {
    const target = robot.usingTemporaryBay && robot.assignedParkingPosition
      ? { ...robot.assignedParkingPosition }
      : { ...robot.homePosition };
    const homeBayId = robot.usingTemporaryBay && robot.assignedParkingBayId
      ? robot.assignedParkingBayId
      : findBayIdForPosition(target, standbyArrivalTolerance(scenario) * 3);
    robot.assignedParkingPosition = { ...target };
    robot.assignedParkingBayId = homeBayId;
    if (homeBayId) {
      const bay = parkingBayRegistry.find(b => b.id === homeBayId);
      if (bay) {
        bay.state = distance(robot.position, target) <= standbyArrivalTolerance(scenario) ? "occupied" : "reserved";
        bay.assignedRobotId = robot.id;
      }
    }

    const path = ctx
      ? pathToPointPredictive(graph, robot.position, target, ctx)
      : pathToPoint(graph, robot.position, target);
    if (isReturnPathUsable(path, target, solids, scenario)) {
      return { target, path };
    }
    if (distance(robot.position, target) <= standbyArrivalTolerance(scenario)) {
      return { target, path: [{ ...target }] };
    }
  }

  const radius = robotRadius(scenario);
  const clearance = scenario.simulation.robotClearanceMeters ?? 0.12;
  const minRobotDistance = radius * 2 + clearance + 0.65;
  const strategy: ParkingStrategy = scenario.simulation.parkingStrategy ?? "farthest-free";

  const availableBays = parkingBayRegistry.filter(bay =>
    (bay.state === "free" || (bay.assignedRobotId === robot.id)) &&
    isParkingCandidateAvailable(bay.position, robot, robots, scenario, solids, minRobotDistance, radius)
  );

  const sorted = sortBaysByStrategy(availableBays, robot, robots, scenario, strategy);

  for (const bay of sorted) {
    const path = ctx
      ? pathToPointPredictive(graph, robot.position, bay.position, ctx)
      : pathToPoint(graph, robot.position, bay.position);
    if (isReturnPathUsable(path, bay.position, solids, scenario)) {
      const oldBayId = robot.assignedParkingBayId;
      if (oldBayId && oldBayId !== bay.id) {
        releaseParkingBay(robot);
      }
      robot.assignedParkingBayId = bay.id;
      bay.state = "reserved";
      bay.assignedRobotId = robot.id;
      return { target: { ...bay.position }, path };
    }
  }

  const count = Math.max(scenario.robots.count + 12, robots.length + 12);
  const fallbackCandidates = buildParkingPositions(scenario, count);
  const fallbackSorted = sortPositionsByStrategy(fallbackCandidates, robot, robots, scenario, strategy);

  for (const target of fallbackSorted) {
    if (!isParkingCandidateAvailable(target, robot, robots, scenario, solids, minRobotDistance, radius)) continue;
    const path = ctx
      ? pathToPointPredictive(graph, robot.position, target, ctx)
      : pathToPoint(graph, robot.position, target);
    if (isReturnPathUsable(path, target, solids, scenario)) {
      const bayId = findBayIdForPosition(target, standbyArrivalTolerance(scenario) * 3);
      if (bayId) {
        robot.assignedParkingBayId = bayId;
        const bay = parkingBayRegistry.find(b => b.id === bayId);
        if (bay) { bay.state = "reserved"; bay.assignedRobotId = robot.id; }
      }
      return { target, path };
    }
  }

  const fallback = parkingTarget(robot);
  const fallbackPath = ctx
    ? pathToPointPredictive(graph, robot.position, fallback, ctx)
    : pathToPoint(graph, robot.position, fallback);
  if (isReturnPathUsable(fallbackPath, fallback, solids, scenario)) {
    return { target: fallback, path: fallbackPath };
  }

  return undefined;
}

/**
 * Soft penalty for parking spots close to an active working-station approach/queue.
 * Used as the primary allocation key so robots prefer a free bay farther away over one
 * that crowds a station queue (the Pack A failure mode).
 */
function parkingQueuePenalty(pos: Vec2, scenario: WarehouseScenario, approaches?: Vec2[]): number {
  const influence = 9;
  const points = approaches ?? workingStationApproaches(scenario);
  let penalty = 0;
  for (const approach of points) {
    const d = distance(pos, approach);
    if (d < influence) penalty += influence - d;
  }
  return penalty;
}

function workingStationApproaches(scenario: WarehouseScenario): Vec2[] {
  return scenario.stations
    .filter(station => station.type !== "charging")
    .map(station => stationApproachPosition(station, scenario));
}

function sortBaysByStrategy(
  bays: ParkingBayInfo[],
  robot: RobotRuntime,
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  strategy: ParkingStrategy
): ParkingBayInfo[] {
  const copy = [...bays];
  const approaches = workingStationApproaches(scenario);
  const penaltyCache = new Map(copy.map(bay => [bay.id, parkingQueuePenalty(bay.position, scenario, approaches)]));
  const queuePenalty = (bay: ParkingBayInfo) => penaltyCache.get(bay.id) ?? 0;
  switch (strategy) {
    case "home-slots":
      return copy.sort((a, b) => {
        const aIsHome = distance(a.position, robot.homePosition) <= standbyArrivalTolerance(scenario) * 3;
        const bIsHome = distance(b.position, robot.homePosition) <= standbyArrivalTolerance(scenario) * 3;
        if (aIsHome !== bIsHome) return aIsHome ? -1 : 1;
        return (queuePenalty(a) - queuePenalty(b)) ||
          (distance(a.position, robot.homePosition) - distance(b.position, robot.homePosition));
      });
    case "farthest-free":
      return copy.sort((a, b) =>
        (queuePenalty(a) - queuePenalty(b)) ||
        (distance(b.position, robot.position) - distance(a.position, robot.position)));
    case "nearest-free":
      return copy.sort((a, b) =>
        (queuePenalty(a) - queuePenalty(b)) ||
        (distance(a.position, robot.position) - distance(b.position, robot.position)));
    case "least-congested": {
      const congestionScore = (bay: ParkingBayInfo) => {
        let score = parkingQueuePenalty(bay.position, scenario);
        const radius = robotRadius(scenario);
        for (const other of robots) {
          if (other.id === robot.id) continue;
          const d = distance(other.position, bay.position);
          if (d < radius * 8) score += (radius * 8 - d);
        }
        return score;
      };
      return copy.sort((a, b) => congestionScore(a) - congestionScore(b));
    }
    case "balanced-sides": {
      const halfW = scenario.warehouse.width / 2;
      const leftCount = robots.filter(r =>
        r.id !== robot.id &&
        (r.state === "idle" || r.state === "returning") &&
        (r.assignedParkingPosition?.x ?? r.position.x) < 0
      ).length;
      const rightCount = robots.filter(r =>
        r.id !== robot.id &&
        (r.state === "idle" || r.state === "returning") &&
        (r.assignedParkingPosition?.x ?? r.position.x) >= 0
      ).length;
      const preferLeft = leftCount <= rightCount;
      return copy.sort((a, b) => {
        const aOnPreferred = preferLeft ? a.position.x < 0 : a.position.x >= 0;
        const bOnPreferred = preferLeft ? b.position.x < 0 : b.position.x >= 0;
        if (aOnPreferred !== bOnPreferred) return aOnPreferred ? -1 : 1;
        return distance(b.position, robot.position) - distance(a.position, robot.position);
      });
    }
    default:
      return copy.sort((a, b) => distance(b.position, robot.position) - distance(a.position, robot.position));
  }
}

function sortPositionsByStrategy(
  positions: Vec2[],
  robot: RobotRuntime,
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  strategy: ParkingStrategy
): Vec2[] {
  const copy = [...positions];
  const approaches = workingStationApproaches(scenario);
  const penaltyCache = new Map(copy.map(pos => [pos, parkingQueuePenalty(pos, scenario, approaches)]));
  const queuePenalty = (pos: Vec2) => penaltyCache.get(pos) ?? 0;
  switch (strategy) {
    case "home-slots":
      return copy.sort((a, b) =>
        (distance(a, robot.homePosition) - distance(b, robot.homePosition)) ||
        (queuePenalty(a) - queuePenalty(b)));
    case "farthest-free":
      return copy.sort((a, b) =>
        (queuePenalty(a) - queuePenalty(b)) ||
        (distance(b, robot.position) - distance(a, robot.position)));
    case "nearest-free":
      return copy.sort((a, b) =>
        (queuePenalty(a) - queuePenalty(b)) ||
        (distance(a, robot.position) - distance(b, robot.position)));
    case "least-congested": {
      const congestionScore = (pos: Vec2) => {
        let score = queuePenalty(pos);
        const radius = robotRadius(scenario);
        for (const other of robots) {
          if (other.id === robot.id) continue;
          const d = distance(other.position, pos);
          if (d < radius * 8) score += (radius * 8 - d);
        }
        return score;
      };
      return copy.sort((a, b) => congestionScore(a) - congestionScore(b));
    }
    case "balanced-sides": {
      const leftCount = robots.filter(r =>
        r.id !== robot.id &&
        (r.state === "idle" || r.state === "returning") &&
        (r.assignedParkingPosition?.x ?? r.position.x) < 0
      ).length;
      const rightCount = robots.filter(r =>
        r.id !== robot.id &&
        (r.state === "idle" || r.state === "returning") &&
        (r.assignedParkingPosition?.x ?? r.position.x) >= 0
      ).length;
      const preferLeft = leftCount <= rightCount;
      return copy.sort((a, b) => {
        const aOnPreferred = preferLeft ? a.x < 0 : a.x >= 0;
        const bOnPreferred = preferLeft ? b.x < 0 : b.x >= 0;
        if (aOnPreferred !== bOnPreferred) return aOnPreferred ? -1 : 1;
        return distance(b, robot.position) - distance(a, robot.position);
      });
    }
    default:
      return copy.sort((a, b) => distance(b, robot.position) - distance(a, robot.position));
  }
}

function isParkingCandidateAvailable(
  target: Vec2,
  robot: RobotRuntime,
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  solids: SolidRect[],
  minRobotDistance: number,
  radius: number
): boolean {
  if (!pointInsideWarehouse(target, scenario, radius + 0.35)) return false;
  if (isOperationalParkingKeepout(target, scenario, radius)) return false;
  if (pointInsideSolid(target, solids)) return false;
  if (solids.some(solid => circleIntersectsRect(target, radius + 0.15, solid))) return false;

  for (const other of robots) {
    if (other.id === robot.id) continue;
    const otherTarget = other.assignedParkingPosition ?? other.homePosition;
    const otherIsParkingOrParked = other.state === "returning" || other.state === "idle" || other.state === "charging";
    if (otherIsParkingOrParked && distance(otherTarget, target) < minRobotDistance) return false;
    if (distance(other.position, target) < minRobotDistance) return false;
  }

  return true;
}

function isRobotInValidParking(robot: RobotRuntime, robots: RobotRuntime[], scenario: WarehouseScenario): boolean {
  const target = parkingTarget(robot);
  if (distance(robot.position, target) <= standbyArrivalTolerance(scenario)) return true;

  if (isHomeParkingStrategy(scenario)) {
    return false;
  }

  const radius = robotRadius(scenario);
  const clearance = scenario.simulation.robotClearanceMeters ?? 0.12;
  const minRobotDistance = radius * 2 + clearance + 0.65;
  const tolerance = standbyArrivalTolerance(scenario);

  const matchingBay = parkingBayRegistry.find(bay =>
    distance(bay.position, robot.position) <= tolerance &&
    (bay.state === "free" || bay.assignedRobotId === robot.id)
  );
  if (matchingBay) {
    const occupiedByOther = robots.some(other =>
      other.id !== robot.id &&
      distance(other.assignedParkingPosition ?? other.homePosition, matchingBay.position) < minRobotDistance
    );
    if (!occupiedByOther) {
      robot.assignedParkingPosition = { ...matchingBay.position };
      robot.assignedParkingBayId = matchingBay.id;
      matchingBay.state = "occupied";
      matchingBay.assignedRobotId = robot.id;
      return true;
    }
  }

  const slots = buildParkingPositions(scenario, Math.max(scenario.robots.count + 12, robots.length + 12));
  const occupiedSlot = slots.find(slot => distance(slot, robot.position) <= tolerance);
  if (!occupiedSlot) return false;

  const occupiedByOther = robots.some(other =>
    other.id !== robot.id &&
    distance(other.assignedParkingPosition ?? other.homePosition, occupiedSlot) < minRobotDistance
  );
  if (occupiedByOther) return false;
  robot.assignedParkingPosition = { ...occupiedSlot };
  const bayId = findBayIdForPosition(occupiedSlot, tolerance * 3);
  if (bayId) {
    robot.assignedParkingBayId = bayId;
    const bay = parkingBayRegistry.find(b => b.id === bayId);
    if (bay) { bay.state = "occupied"; bay.assignedRobotId = robot.id; }
  }
  return true;
}

function parkingTarget(robot: RobotRuntime): Vec2 {
  return robot.assignedParkingPosition ?? robot.homePosition;
}

function dockRobotAtParkingTarget(robot: RobotRuntime, scenario: WarehouseScenario, reason: string) {
  const target = parkingTarget(robot);
  robot.position = { ...target };
  if (distance(target, robot.homePosition) <= standbyArrivalTolerance(scenario) * 3) {
    robot.heading = robot.homeHeading ?? 0;
  }
  robot.state = "idle";
  robot.path = [];
  robot.pathIndex = 0;
  robot.blockedTicks = 0;
  robot.waitTicks = 0;
  robot.waitingForRobotId = undefined;
  robot.yieldTarget = undefined;
  robot.preYieldState = undefined;
  robot.consecutiveYields = 0;
  robot.currentSpeedMps = 0;
  robot.parkingReassignReason = reason;
}

function standbyApproachCandidates(target: Vec2, spacing: number): Vec2[] {
  return [
    target,
    { x: target.x, z: target.z + spacing },
    { x: target.x, z: target.z - spacing },
    { x: target.x + spacing, z: target.z },
    { x: target.x - spacing, z: target.z },
    { x: target.x + spacing, z: target.z + spacing },
    { x: target.x - spacing, z: target.z + spacing },
    { x: target.x + spacing, z: target.z - spacing },
    { x: target.x - spacing, z: target.z - spacing },
  ];
}

function appendReturnEndpoint(path: Vec2[], target: Vec2, solids?: SolidRect[]): Vec2[] {
  const result = path.length > 0 ? path.map(point => ({ ...point })) : [];
  const last = result[result.length - 1];
  if (!last) return [{ ...target }];
  if (distance(last, target) <= 0.05) return result;

  // Keep return paths axis-aligned: if the final hop would be diagonal, insert an
  // L-bend (preferring the leg that is clear of obstacles).
  if (Math.abs(last.x - target.x) > 0.05 && Math.abs(last.z - target.z) > 0.05 && solids) {
    const viaA: Vec2 = { x: target.x, z: last.z };
    const viaB: Vec2 = { x: last.x, z: target.z };
    if (isClearSegment(last, viaA, solids) && isClearSegment(viaA, target, solids)) {
      result.push(viaA);
    } else if (isClearSegment(last, viaB, solids) && isClearSegment(viaB, target, solids)) {
      result.push(viaB);
    } else {
      result.push(viaA);
    }
  }
  result.push({ ...target });
  return result;
}

function isReturnPathUsable(path: Vec2[], target: Vec2, solids: SolidRect[], scenario: WarehouseScenario): boolean {
  if (path.length === 0) return false;
  if (distance(path[path.length - 1], target) > standbyArrivalTolerance(scenario)) return false;
  return pathSegmentsClear(path, solids);
}

function pathSegmentsClear(path: Vec2[], solids: SolidRect[]): boolean {
  for (let i = 1; i < path.length; i++) {
    if (!isClearSegment(path[i - 1], path[i], solids)) return false;
  }
  return true;
}

function standbyArrivalTolerance(scenario: WarehouseScenario): number {
  return Math.max(0.28, robotRadius(scenario) * 0.45);
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function computeFallbackStandby(robot: RobotRuntime, scenario: WarehouseScenario): Vec2 {
  return buildParkingPositions(scenario, scenario.robots.count)[robot.id - 1] ??
    buildParkingPositions(scenario, robot.id)[robot.id - 1] ??
    { x: 0, z: -scenario.warehouse.depth / 2 + 4 };
}

function buildParkingPositions(scenario: WarehouseScenario, count: number): Vec2[] {
  const ext = computeWarehouseExtents(scenario);
  const halfW = scenario.warehouse.width / 2;
  const halfD = scenario.warehouse.depth / 2;
  const radius = robotRadius(scenario);
  const clearance = scenario.simulation.robotClearanceMeters ?? 0.12;
  const spacingX = Math.max(radius * 2 + clearance + 1.3, scenario.robots.footprintWidth * 2.7);
  const spacingZ = Math.max(radius * 2 + clearance + 1.05, scenario.robots.footprintDepth * 2.7);
  const minDistance = radius * 2 + clearance + 0.9;
  const solids = buildSolidObstacles(scenario);
  const positions: Vec2[] = [];
  const wallMargin = Math.max(4.8, radius * 4.2);

  // Station approach points create full-width travel lanes in the nav graph (and the
  // Manhattan bends extend them to the walls). A parked robot closer than laneClear to
  // one of those lanes physically blocks every robot driving it, so bays must keep out.
  const laneClear = radius * 2 + clearance + 0.5;
  const approachPoints = scenario.stations.map(st => stationApproachPosition(st, scenario));
  const approachLaneZs = [...new Set(approachPoints.map(a => a.z))];
  const approachLaneXs = [...new Set(approachPoints.map(a => a.x))];

  const pushCandidate = (candidate: Vec2) => {
    if (positions.length >= count) return;
    if (!pointInsideWarehouse(candidate, scenario, radius + 0.45)) return;
    if (isOperationalParkingKeepout(candidate, scenario, radius)) return;
    if (approachLaneZs.some(laneZ => Math.abs(candidate.z - laneZ) < laneClear)) return;
    if (approachLaneXs.some(laneX => Math.abs(candidate.x - laneX) < laneClear)) return;
    if (isParkingPositionClear(candidate, positions, solids, minDistance, radius)) {
      positions.push(candidate);
    }
  };

  const leftColumns = [
    -halfW + wallMargin,
    -halfW + wallMargin + spacingX,
    -halfW + wallMargin + spacingX * 2,
    -halfW + wallMargin + spacingX * 3,
  ];
  const rightColumns = [
    halfW - wallMargin,
    halfW - wallMargin - spacingX,
    halfW - wallMargin - spacingX * 2,
    halfW - wallMargin - spacingX * 3,
  ];
  const sideColumns: number[] = [];
  for (let i = 0; i < Math.max(leftColumns.length, rightColumns.length); i++) {
    if (leftColumns[i] !== undefined) sideColumns.push(leftColumns[i]);
    if (rightColumns[i] !== undefined) sideColumns.push(rightColumns[i]);
  }
  const zStart = -halfD + Math.max(2.4, radius * 2.0);
  const zLimit = Math.min(ext.rackBlockStartZ - scenario.racks.mainAisleWidth * 0.25, halfD - 6);
  const rows = Math.max(2, Math.ceil(count / sideColumns.length) + 2);

  // Pack depot rows as deep as possible while keeping every row clear of the station
  // approach lanes (nudge a row deeper into legality instead of dropping it).
  const rowStep = Math.max(radius * 2 + clearance + 1.05, scenario.robots.footprintDepth * 2.4);
  const rowZs: number[] = [];
  for (let z = zStart; z <= zLimit && rowZs.length < rows;) {
    if (approachLaneZs.some(laneZ => Math.abs(z - laneZ) < laneClear)) {
      z += 0.25;
      continue;
    }
    rowZs.push(z);
    z += rowStep;
  }

  for (let row = 0; row < rowZs.length && positions.length < count; row++) {
    const z = rowZs[row];
    const rowColumns = row % 2 === 0 ? sideColumns : [...sideColumns].reverse();
    for (const x of rowColumns) {
      pushCandidate({ x, z });
    }
  }

  // Rear depot rows (used as overflow and as post-charge bays beside the charger):
  // nudge each row between the rear station approach lanes instead of dropping it.
  const rearStart = ext.rackBlockStartZ + ext.rackBlockDepth + scenario.racks.mainAisleWidth * 0.45;
  const rearEnd = halfD - Math.max(3.2, radius * 2.4);
  const rearRowZs: number[] = [];
  for (let z = rearEnd; z >= rearStart;) {
    if (approachLaneZs.some(laneZ => Math.abs(z - laneZ) < laneClear)) {
      z -= 0.25;
      continue;
    }
    rearRowZs.push(z);
    z -= rowStep;
  }

  if (positions.length < count) {
    for (const z of rearRowZs) {
      if (positions.length >= count) break;
      for (const x of sideColumns) {
        pushCandidate({ x, z });
      }
    }
  }

  if (positions.length < count) {
    const xMin = -halfW + wallMargin;
    const xMax = halfW - wallMargin;
    for (let z = zStart; z <= zLimit && positions.length < count; z += spacingZ) {
      for (let x = xMin; x <= xMax && positions.length < count; x += spacingX) {
        pushCandidate({ x, z });
      }
      for (let x = xMax; x >= xMin && positions.length < count; x -= spacingX) {
        pushCandidate({ x, z: z + spacingZ * 0.48 });
      }
    }
  }

  if (positions.length < count) {
    const xMin = -halfW + wallMargin;
    const xMax = halfW - wallMargin;
    for (const z of rearRowZs) {
      if (positions.length >= count) break;
      for (let x = xMin; x <= xMax && positions.length < count; x += spacingX) {
        pushCandidate({ x, z });
      }
    }
  }

  return positions;
}

function pointInsideWarehouse(point: Vec2, scenario: WarehouseScenario, margin = 0): boolean {
  const halfW = scenario.warehouse.width / 2;
  const halfD = scenario.warehouse.depth / 2;
  return point.x >= -halfW + margin &&
    point.x <= halfW - margin &&
    point.z >= -halfD + margin &&
    point.z <= halfD - margin;
}

/**
 * True when a *stationary* robot at `point` would obstruct station traffic: standing on
 * or beside a working station's approach point or physical queue lane. Used to filter
 * yield pockets, parking shuffles and standby targets so robots never camp in front of
 * a station entrance (the Pack A/B livelock failure mode).
 */
function isStationTrafficKeepout(point: Vec2, scenario: WarehouseScenario): boolean {
  const radius = robotRadius(scenario);
  const clearance = scenario.simulation.robotClearanceMeters ?? 0.12;
  for (const station of scenario.stations) {
    if (station.type === "charging") continue;
    const approach = stationApproachPosition(station, scenario);
    if (distance(point, approach) < Math.max(2.6, radius * 2 + clearance + 1.2)) return true;

    const dirX = approach.x - station.position.x;
    const dirZ = approach.z - station.position.z;
    const len = Math.hypot(dirX, dirZ) || 1;
    const queueSpacing = radius * 2 + clearance + 0.5;
    const queueEnd: Vec2 = {
      x: approach.x + (dirX / len) * queueSpacing * station.queueCapacity,
      z: approach.z + (dirZ / len) * queueSpacing * station.queueCapacity,
    };
    if (pointSegmentDistance(point, approach, queueEnd) < Math.max(2.2, radius * 2 + clearance + 0.6)) {
      return true;
    }
  }
  return false;
}

function isOperationalParkingKeepout(point: Vec2, scenario: WarehouseScenario, radius: number): boolean {
  const clearance = scenario.simulation.robotClearanceMeters ?? 0.12;
  for (const station of scenario.stations) {
    if (station.type === "charging") {
      // Charging docks need a smaller halo than working stations, but parking bays must
      // never hug them: a bay squeezed between a charger and the wall creates a corridor
      // too narrow for two robots to pass (the original Pack A pinch).
      const envelopeX = station.width / 2 + Math.max(2.6, radius * 2.6);
      const envelopeZ = station.depth / 2 + Math.max(2.4, radius * 2.4);
      if (
        Math.abs(point.x - station.position.x) <= envelopeX &&
        Math.abs(point.z - station.position.z) <= envelopeZ
      ) {
        return true;
      }
      const approach = stationApproachPosition(station, scenario);
      if (distance(point, approach) < Math.max(3.0, radius * 3)) {
        return true;
      }
      continue;
    }

    const stationEnvelopeX = station.width / 2 + Math.max(4.5, radius * 4.5);
    const stationEnvelopeZ = station.depth / 2 + Math.max(4.0, radius * 4);
    if (
      Math.abs(point.x - station.position.x) <= stationEnvelopeX &&
      Math.abs(point.z - station.position.z) <= stationEnvelopeZ
    ) {
      return true;
    }

    const approach = stationApproachPosition(station, scenario);
    if (distance(point, approach) < Math.max(4.8, radius * 4.5)) {
      return true;
    }

    // Keep bays away from the whole physical queue lane (approach -> last queue slot),
    // not just the approach point, so parked robots never sit inside a station queue.
    const dirX = approach.x - station.position.x;
    const dirZ = approach.z - station.position.z;
    const len = Math.hypot(dirX, dirZ) || 1;
    const queueSpacing = radius * 2 + clearance + 0.5;
    const queueEnd: Vec2 = {
      x: approach.x + (dirX / len) * queueSpacing * station.queueCapacity,
      z: approach.z + (dirZ / len) * queueSpacing * station.queueCapacity,
    };
    if (pointSegmentDistance(point, approach, queueEnd) < Math.max(2.6, radius * 2 + clearance + 1.2)) {
      return true;
    }
  }

  return false;
}

function isParkingPositionClear(
  candidate: Vec2,
  existing: Vec2[],
  solids: SolidRect[],
  minDistance: number,
  radius: number
): boolean {
  for (const solid of solids) {
    if (circleIntersectsRect(candidate, radius + 0.35, solid)) return false;
  }
  return existing.every(pos => Math.hypot(pos.x - candidate.x, pos.z - candidate.z) >= minDistance);
}

function moveAlongPath(
  robot: RobotRuntime,
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  solids: SolidRect[],
  collisionAvoidance: boolean,
  congestionMap: Map<string, number>,
  mission?: Mission,
  reservations?: ReservationContext
): boolean {
  const target = robot.path[robot.pathIndex];
  if (!target) return true;

  const dx = target.x - robot.position.x;
  const dz = target.z - robot.position.z;
  const dist = Math.hypot(dx, dz);
  const dt = scenario.simulation.tickMs / 1000;
  const maxSpeed = scenario.robots.speedMetersPerSecond;
  const baseStep = maxSpeed * dt;
  const allowedStep = collisionAvoidance
    ? adaptiveSpeedStep(robot, robots, scenario, baseStep)
    : baseStep;

  // Smooth motion model: ramp current speed toward a target that respects zone/turn
  // braking limits and the collision-allowed step, bounded by max accel/decel.
  const limitMps = motionSpeedLimitMps(robot, scenario, dist);
  let targetMps = Math.min(limitMps, allowedStep / dt);
  if (allowedStep <= 0.001) targetMps = 0;

  const accel = scenario.robots.maxAccelerationMps2 ?? 2.4;
  const decel = scenario.robots.maxDecelerationMps2 ?? 3.2;
  // When fully blocked the robot is not moving, so decay its internal speed memory
  // gently: that lets it resume quickly after a short reservation wait instead of
  // re-accelerating from a dead stop every tick (which would crush throughput).
  const blocked = allowedStep <= 0.001;
  const downRate = blocked ? Math.min(decel, 2.5) : decel;
  let cur = robot.currentSpeedMps ?? 0;
  if (targetMps > cur) cur = Math.min(targetMps, cur + accel * dt);
  else cur = Math.max(targetMps, cur - downRate * dt);
  robot.currentSpeedMps = cur;

  const speed = Math.min(cur * dt, allowedStep);

  if (speed <= 0.001) {
    registerPhysicsWait(robot, mission, congestionMap, "Predictive speed governor: slowing before future conflict");
    return false;
  }

  if (dist < speed) {
    if (collisionAvoidance && isMoveBlocked(robot, target, robots, scenario, solids, reservations)) {
      registerPhysicsWait(robot, mission, congestionMap);
      return false;
    }

    robot.position = { ...target };
    robot.blockedTicks = 0;
    robot.waitingForRobotId = undefined;
    robot.totalDistance += dist;
    if (mission) mission.distanceMeters += dist;
    robot.pathIndex++;

    if (robot.pathIndex >= robot.path.length) {
      return true;
    }
  } else {
    const nx = robot.position.x + (dx / dist) * speed;
    const nz = robot.position.z + (dz / dist) * speed;
    const nextPos: Vec2 = { x: nx, z: nz };

    if (collisionAvoidance && isMoveBlocked(robot, nextPos, robots, scenario, solids, reservations)) {
      registerPhysicsWait(robot, mission, congestionMap);
      return false;
    }

    robot.totalDistance += speed;
    if (mission) mission.distanceMeters += speed;
    robot.position = nextPos;
    robot.blockedTicks = 0;
    robot.waitingForRobotId = undefined;
    robot.heading = rotateToward(robot.heading, Math.atan2(dx, dz), scenario.robots.turnSpeedRadPerSecond * (scenario.simulation.tickMs / 1000));
  }
  return false;
}

function rotateToward(current: number, target: number, maxStep: number): number {
  const delta = normalizeAngle(target - current);
  if (Math.abs(delta) <= maxStep) return target;
  return current + Math.sign(delta) * maxStep;
}

/**
 * Speed limit (m/s) for the smooth motion model. Robots slow down for turns, path ends,
 * station approaches and parking/launch zones so the motion looks deliberate and braked
 * rather than instantaneous. Returns a velocity cap that the accel/decel ramp converges to.
 */
function motionSpeedLimitMps(robot: RobotRuntime, scenario: WarehouseScenario, distToTarget: number): number {
  const maxSpeed = scenario.robots.speedMetersPerSecond;
  const decel = scenario.robots.maxDecelerationMps2 ?? 3.2;
  let limit = maxSpeed;

  // Slow down inside the parking / launch band where robots cluster.
  if (isParkingTrafficZone(robot.position, scenario)) {
    limit = Math.min(limit, maxSpeed * 0.84);
  }

  // Slow down on station approach (keep-out ring around each station footprint).
  for (const st of scenario.stations) {
    const d = Math.hypot(robot.position.x - st.position.x, robot.position.z - st.position.z);
    const keepout = Math.max(st.width, st.depth) / 2 + 2.0;
    if (d < keepout) { limit = Math.min(limit, maxSpeed * 0.78); break; }
  }

  // Brake smoothly toward a controlled speed at the upcoming corner or path end.
  const idx = robot.pathIndex;
  const target = robot.path[idx];
  if (target) {
    const isEnd = idx >= robot.path.length - 1;
    let corner = isEnd;
    if (!isEnd) {
      const next = robot.path[idx + 1];
      const headingIn = Math.atan2(target.x - robot.position.x, target.z - robot.position.z);
      const headingOut = Math.atan2(next.x - target.x, next.z - target.z);
      corner = Math.abs(normalizeAngle(headingOut - headingIn)) > 0.35;
    }
    if (corner) {
      const cornerSpeed = isEnd ? 0 : maxSpeed * 0.55;
      const braked = Math.sqrt(cornerSpeed * cornerSpeed + 2 * decel * Math.max(0, distToTarget));
      limit = Math.min(limit, Math.max(cornerSpeed, braked));
    }
  }

  return Math.max(0, limit);
}

function normalizeAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function aisleKey(pos: Vec2): string {
  return `aisle_${Math.round(pos.z / 3)}`;
}

function adaptiveSpeedStep(
  robot: RobotRuntime,
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  baseStep: number
): number {
  if (baseStep <= 0 || robot.path.length === 0) return baseStep;
  const startupStep = startupCorridorSpeedStep(robot, robots, scenario, baseStep);
  if (!isParkingTrafficZone(robot.position, scenario)) return startupStep;
  if (robot.totalDistance > Math.max(3, robotRadius(scenario) * 4)) return startupStep;

  const radius = robotRadius(scenario);
  const clearance = scenario.simulation.robotClearanceMeters ?? 0.12;
  const safeDistance = Math.max(radius * 2 + clearance - 0.18, radius * 2);
  const horizonTicks = 2;
  const myPriority = robotPriority(robot);

  for (let t = 1; t <= horizonTicks; t++) {
    const selfFuture = projectRobotPosition(robot, baseStep * t);
    for (const other of robots) {
      if (other.id === robot.id) continue;
      if (other.path.length === 0 || other.state === "idle" || other.state === "charging") continue;
      if (!isParkingTrafficZone(other.position, scenario)) continue;
      if (!isCrossingOrHeadOnTrajectory(robot, other)) continue;

      const otherFuture = projectRobotPosition(other, baseStep * t);
      if (distance(selfFuture, otherFuture) >= safeDistance) continue;

      const otherPriority = robotPriority(other);
      const otherHasRightOfWay = otherPriority > myPriority ||
        (otherPriority === myPriority && other.id < robot.id);
      if (!otherHasRightOfWay) continue;

      if (t <= 1) return Math.min(startupStep, baseStep * 0.85);
      return Math.min(startupStep, baseStep * 0.95);
    }
  }

  return startupStep;
}

/**
 * Startup launch speed governor. While a robot is still inside its launch zone it
 * brakes (deterministically) for traffic in its launch corridor:
 * - another active robot directly ahead within the unsafe startup distance -> stop;
 * - one slightly farther ahead in the corridor -> creep at reduced speed;
 * - a predicted crossing/head-on conflict 2-4 ticks out -> the robot without launch
 *   right-of-way slows or holds.
 * Idle parked robots are ignored here; the parking-shuffle logic handles those.
 */
function startupCorridorSpeedStep(
  robot: RobotRuntime,
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  baseStep: number
): number {
  if (robot.state !== "to-pick" && robot.state !== "to-point") return baseStep;
  if (!robot.missionId) return baseStep;
  if (distance(robot.position, parkingTarget(robot)) > launchZoneRadius(scenario)) return baseStep;

  const dir = currentPathDirection(robot);
  if (!dir) return baseStep;

  const radius = robotRadius(scenario);
  const clearanceM = scenario.simulation.robotClearanceMeters ?? 0.12;
  const corridorHalfWidth = radius * 2 + clearanceM * 0.5;
  const unsafeDistance = radius * 2 + clearanceM + 0.9;
  let step = baseStep;

  for (const other of robots) {
    if (other.id === robot.id) continue;
    if (other.state === "idle" || other.state === "charging" || other.state === "picking" || other.state === "placing") continue;
    const relX = other.position.x - robot.position.x;
    const relZ = other.position.z - robot.position.z;
    const ahead = relX * dir.x + relZ * dir.z;
    if (ahead <= 0 || ahead > unsafeDistance * 2.2) continue;
    const lateral = Math.abs(relX * dir.z - relZ * dir.x);
    if (lateral > corridorHalfWidth) continue;
    if (ahead < unsafeDistance) return 0;
    step = Math.min(step, baseStep * 0.45);
  }

  for (let t = 2; t <= 4; t++) {
    const selfFuture = projectRobotPosition(robot, baseStep * t);
    for (const other of robots) {
      if (other.id === robot.id) continue;
      if (other.path.length === 0 || other.state === "idle" || other.state === "charging") continue;
      if (!isCrossingOrHeadOnTrajectory(robot, other)) continue;
      const otherFuture = projectRobotPosition(other, baseStep * t);
      if (distance(selfFuture, otherFuture) >= unsafeDistance) continue;
      if (!launchRightOfWay(other, robot)) continue;
      if (t <= 2) return 0;
      step = Math.min(step, baseStep * 0.5);
    }
  }

  return step;
}

/** True when `other` has launch right-of-way over `robot`. Deterministic tie-breaks. */
function launchRightOfWay(other: RobotRuntime, robot: RobotRuntime): boolean {
  const otherRank = other.launchPriority ?? Number.MAX_SAFE_INTEGER;
  const myRank = robot.launchPriority ?? Number.MAX_SAFE_INTEGER;
  if (otherRank !== myRank) return otherRank < myRank;
  const otherP = robotPriority(other);
  const myP = robotPriority(robot);
  if (otherP !== myP) return otherP > myP;
  return other.id < robot.id;
}

function isParkingTrafficZone(pos: Vec2, scenario: WarehouseScenario): boolean {
  const ext = computeWarehouseExtents(scenario);
  const frontParkingLimit = ext.rackBlockStartZ - scenario.racks.mainAisleWidth * 0.1;
  const sideParkingBand = scenario.warehouse.width / 2 - Math.max(10, robotRadius(scenario) * 8);
  return pos.z < frontParkingLimit || Math.abs(pos.x) > sideParkingBand;
}

function isCrossingOrHeadOnTrajectory(a: RobotRuntime, b: RobotRuntime): boolean {
  const da = currentPathDirection(a);
  const db = currentPathDirection(b);
  if (!da || !db) return false;
  const dot = da.x * db.x + da.z * db.z;
  return dot < 0.25;
}

function currentPathDirection(robot: RobotRuntime): Vec2 | undefined {
  const target = robot.path[robot.pathIndex];
  if (!target) return undefined;
  const dx = target.x - robot.position.x;
  const dz = target.z - robot.position.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.05) return undefined;
  return { x: dx / len, z: dz / len };
}

function projectRobotPosition(robot: RobotRuntime, distanceBudget: number): Vec2 {
  if (distanceBudget <= 0 || robot.path.length === 0) return { ...robot.position };

  let pos = { ...robot.position };
  let index = robot.pathIndex;
  let remaining = distanceBudget;

  while (remaining > 0 && index < robot.path.length) {
    const target = robot.path[index];
    const dx = target.x - pos.x;
    const dz = target.z - pos.z;
    const segmentDistance = Math.hypot(dx, dz);
    if (segmentDistance <= 0.0001) {
      pos = { ...target };
      index++;
      continue;
    }
    if (segmentDistance <= remaining) {
      pos = { ...target };
      remaining -= segmentDistance;
      index++;
    } else {
      pos = {
        x: pos.x + (dx / segmentDistance) * remaining,
        z: pos.z + (dz / segmentDistance) * remaining,
      };
      remaining = 0;
    }
  }

  return pos;
}

function registerPhysicsWait(
  robot: RobotRuntime,
  mission: Mission | undefined,
  congestionMap: Map<string, number>,
  note = "Waiting for reserved clearance"
) {
  robot.blockedTicks++;
  robot.totalWaitTicks++;
  if (mission) {
    mission.waitTicks++;
    if (robot.blockedTicks > 80) {
      clearRobotRouteReservations(robot.id);
      robot.path = [];
      robot.pathIndex = 0;
      robot.blockedTicks = 0;
      mission.statusNote = "Replanning after blocked clearance";
      mission.replanCount = (mission.replanCount ?? 0) + 1;
    } else {
      mission.statusNote = note;
    }
  }
  const ck = aisleKey(robot.position);
  congestionMap.set(ck, (congestionMap.get(ck) ?? 0) + 1);
}

function isMoveBlocked(
  robot: RobotRuntime,
  nextPos: Vec2,
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  solids: SolidRect[],
  reservations?: ReservationContext
): boolean {
  const radius = robotRadius(scenario);
  const halfW = scenario.warehouse.width / 2;
  const halfD = scenario.warehouse.depth / 2;

  if (
    nextPos.x - radius < -halfW ||
    nextPos.x + radius > halfW ||
    nextPos.z - radius < -halfD ||
    nextPos.z + radius > halfD
  ) {
    return true;
  }

  for (const solid of solids) {
    if (circleIntersectsRect(nextPos, radius, solid)) return true;
  }

  if (isLaneDirectionViolation(robot, nextPos, scenario)) {
    return true;
  }

  if (reservations && isReservedByHigherPriority(robot, nextPos, reservations)) {
    return true;
  }

  if (reservations) {
    for (const tw of reservations.timeWindows) {
      if (tw.robotId === robot.id) continue;
      const twCellKey = reservationCellKey(nextPos);
      if (tw.cellKey === twCellKey && tw.tickOffset <= 1) {
        const twPriority = reservations.priorities.get(tw.robotId) ?? 0;
        const myPriority = reservations.priorities.get(robot.id) ?? 0;
        if (twPriority > myPriority) {
          robot.waitingForRobotId = tw.robotId;
          return true;
        }
      }
    }
  }

  const minRobotDistance = radius * 2 + (scenario.simulation.robotClearanceMeters ?? 0.12);
  for (const other of robots) {
    if (other.id === robot.id) continue;
    if (Math.hypot(other.position.x - nextPos.x, other.position.z - nextPos.z) < minRobotDistance) {
      robot.waitingForRobotId = other.id;
      return true;
    }
  }

  return false;
}

function buildReservationContext(robots: RobotRuntime[], scenario: WarehouseScenario): ReservationContext {
  const priorities = new Map<number, number>();
  const claims = new Map<string, number[]>();
  const edgeClaims = new Map<string, number[]>();
  const timeWindows: TimeWindowReservation[] = [];

  const speed = scenario.robots.speedMetersPerSecond * (scenario.simulation.tickMs / 1000);
  const TIME_WINDOW_DEPTH = 3;

  for (const robot of robots) {
    const priority = robotPriority(robot);
    priorities.set(robot.id, priority);

    const nextPos = peekNextPosition(robot, scenario);
    if (!nextPos) continue;

    const nextCell = reservationCellKey(nextPos);
    const edgeKey = reservationEdgeKey(robot.position, nextPos);
    claims.set(nextCell, [...(claims.get(nextCell) ?? []), robot.id]);
    edgeClaims.set(edgeKey, [...(edgeClaims.get(edgeKey) ?? []), robot.id]);

    timeWindows.push({ cellKey: nextCell, robotId: robot.id, tickOffset: 0 });

    let simPos = { ...nextPos };
    let simIdx = robot.pathIndex + 1;
    for (let t = 1; t < TIME_WINDOW_DEPTH; t++) {
      if (simIdx >= robot.path.length) break;
      const futureTarget = robot.path[simIdx];
      const dx = futureTarget.x - simPos.x;
      const dz = futureTarget.z - simPos.z;
      const d = Math.hypot(dx, dz);
      if (d < speed) {
        simPos = { ...futureTarget };
        simIdx++;
      } else {
        simPos = { x: simPos.x + (dx / d) * speed, z: simPos.z + (dz / d) * speed };
      }
      timeWindows.push({ cellKey: reservationCellKey(simPos), robotId: robot.id, tickOffset: t });
    }
  }

  timeWindowReservationCount = timeWindows.length;

  const nextCells = new Map<string, number>();
  for (const [cell, robotIds] of claims) {
    nextCells.set(cell, chooseHighestPriority(robotIds, priorities));
  }

  const edgeWinners = new Map<string, number>();
  for (const [edge, robotIds] of edgeClaims) {
    edgeWinners.set(edge, chooseHighestPriority(robotIds, priorities));
  }

  return { nextCells, edgeWinners, priorities, timeWindows };
}

function peekNextPosition(robot: RobotRuntime, scenario: WarehouseScenario): Vec2 | undefined {
  const target = robot.path[robot.pathIndex];
  if (!target) return undefined;
  const dx = target.x - robot.position.x;
  const dz = target.z - robot.position.z;
  const dist = Math.hypot(dx, dz);
  if (dist <= 0.0001) return target;
  const speed = scenario.robots.speedMetersPerSecond * (scenario.simulation.tickMs / 1000);
  if (dist < speed) return target;
  return {
    x: robot.position.x + (dx / dist) * speed,
    z: robot.position.z + (dz / dist) * speed,
  };
}

function isReservedByHigherPriority(
  robot: RobotRuntime,
  nextPos: Vec2,
  reservations: ReservationContext
): boolean {
  const nextCell = reservationCellKey(nextPos);
  const cellWinner = reservations.nextCells.get(nextCell);
  if (cellWinner !== undefined && cellWinner !== robot.id) {
    robot.waitingForRobotId = cellWinner;
    return true;
  }

  const oppositeEdge = reservationEdgeKey(nextPos, robot.position);
  const oppositeWinner = reservations.edgeWinners.get(oppositeEdge);
  if (oppositeWinner !== undefined && oppositeWinner !== robot.id) {
    const robotPriorityValue = reservations.priorities.get(robot.id) ?? 0;
    const otherPriorityValue = reservations.priorities.get(oppositeWinner) ?? 0;
    if (otherPriorityValue >= robotPriorityValue) {
      robot.waitingForRobotId = oppositeWinner;
      return true;
    }
  }

  return false;
}

function robotPriority(robot: RobotRuntime): number {
  const statePriority = robot.state === "to-drop" ? 4000 :
    robot.state === "picking" || robot.state === "placing" ? 3000 :
    robot.state === "to-pick" ? 2000 :
    robot.state === "to-point" ? 1500 :
    robot.state === "to-charge" ? 1000 :
    robot.state === "returning" ? 500 : 0;
  const loadedBonus = robot.carryingSlotId ? 1500 : 0;
  const lowBatteryBonus = robot.batteryMinutes < 15 ? 800 : 0;
  const yieldPenalty = robot.consecutiveYields >= MAX_CONSECUTIVE_YIELDS ? 5000 : 0;
  return statePriority + loadedBonus + lowBatteryBonus + yieldPenalty +
    robot.blockedTicks * 10 + robot.totalWaitTicks - robot.id / 1000;
}

function chooseHighestPriority(robotIds: number[], priorities: Map<number, number>): number {
  return robotIds.reduce((best, id) => {
    const score = priorities.get(id) ?? 0;
    const bestScore = priorities.get(best) ?? 0;
    if (score > bestScore) return id;
    if (score === bestScore && id < best) return id;
    return best;
  }, robotIds[0]);
}

function reservationCellKey(pos: Vec2): string {
  const cellSize = 0.5;
  return `${Math.round(pos.x / cellSize)}:${Math.round(pos.z / cellSize)}`;
}

function reservationEdgeKey(from: Vec2, to: Vec2): string {
  return `${reservationCellKey(from)}>${reservationCellKey(to)}`;
}

function circleIntersectsRect(center: Vec2, radius: number, rect: SolidRect): boolean {
  const closestX = Math.max(rect.minX, Math.min(center.x, rect.maxX));
  const closestZ = Math.max(rect.minZ, Math.min(center.z, rect.maxZ));
  return Math.hypot(center.x - closestX, center.z - closestZ) < radius;
}

function buildYieldBays(scenario: WarehouseScenario): YieldBay[] {
  const bays: YieldBay[] = [];
  const ext = computeWarehouseExtents(scenario);
  const { racks } = scenario;
  const pairCount = Math.ceil(racks.rowCount / 2);
  const solids = buildSolidObstacles(scenario, robotRadius(scenario) * 0.5);

  for (let pair = 0; pair < pairCount; pair++) {
    const aisleZ = ext.rackBlockStartZ + pair * racks.rowPitch + racks.rowPitch / 2;
    const every = Math.max(0, Math.floor(racks.crossAisleEveryBays));
    if (every <= 0) continue;
    for (let bay = every; bay < racks.baysPerRow; bay += every) {
      const crossX = ext.rackBlockStartX + bay * racks.bayWidth +
        Math.floor(bay / every) * racks.crossAisleWidth - racks.crossAisleWidth / 2;
      const radius = robotRadius(scenario);
      const step = radius * 2.5;
      for (const side of [-1, 1]) {
        const pos: Vec2 = { x: crossX, z: aisleZ + side * step };
        const insideSolid = solids.some(s =>
          pos.x > s.minX && pos.x < s.maxX && pos.z > s.minZ && pos.z < s.maxZ
        );
        if (!insideSolid) {
          bays.push({
            id: `yb-${pair}-${bay}-${side > 0 ? "r" : "l"}`,
            position: pos,
            aisleIndex: pair,
            occupied: false,
          });
        }
      }
    }
  }
  return bays;
}

function getAisleDirection(scenario: WarehouseScenario, aisleIndex: number): AisleLaneConfig | undefined {
  const lanes = scenario.simulation.aisleLanes;
  if (!lanes || lanes.length === 0) return undefined;
  return lanes.find(l => l.aisleIndex === aisleIndex);
}

function getAisleIndexForZ(scenario: WarehouseScenario, z: number): number {
  const ext = computeWarehouseExtents(scenario);
  const { racks } = scenario;
  const pairCount = Math.ceil(racks.rowCount / 2);
  for (let pair = 0; pair < pairCount; pair++) {
    const aisleZ = ext.rackBlockStartZ + pair * racks.rowPitch + racks.rowPitch / 2;
    if (Math.abs(z - aisleZ) < racks.aisleWidth / 2) return pair;
  }
  return -1;
}

function isLaneDirectionViolation(
  robot: RobotRuntime,
  nextPos: Vec2,
  scenario: WarehouseScenario
): boolean {
  const lanes = scenario.simulation.aisleLanes;
  if (!lanes || lanes.length === 0) return false;

  const aisleIdx = getAisleIndexForZ(scenario, robot.position.z);
  if (aisleIdx < 0) return false;

  const laneConfig = getAisleDirection(scenario, aisleIdx);
  if (!laneConfig || laneConfig.direction === "two-way") return false;

  const dx = nextPos.x - robot.position.x;
  if (Math.abs(dx) < 0.01) return false;

  if (laneConfig.direction === "one-way-forward" && dx < 0) return true;
  if (laneConfig.direction === "one-way-reverse" && dx > 0) return true;

  return false;
}

function recordTrafficEvent(
  tick: number,
  type: TrafficEvent["type"],
  robot: RobotRuntime,
  otherRobotId: number | undefined,
  reason: string
) {
  trafficEvents.push({
    tick,
    type,
    robotId: robot.id,
    otherRobotId,
    position: { ...robot.position },
    reason,
  });
  if (trafficEvents.length > 500) {
    trafficEvents = trafficEvents.slice(-300);
  }
}

function findNearestYieldBay(
  robot: RobotRuntime,
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  solids: SolidRect[]
): Vec2 | undefined {
  const radius = robotRadius(scenario);
  const minRobotDist = radius * 2 + (scenario.simulation.robotClearanceMeters ?? 0.12) + 0.3;

  const available = yieldBays
    .filter(bay => {
      if (bay.occupied) return false;
      for (const solid of solids) {
        if (circleIntersectsRect(bay.position, radius, solid)) return false;
      }
      for (const other of robots) {
        if (other.id === robot.id) continue;
        if (Math.hypot(other.position.x - bay.position.x, other.position.z - bay.position.z) < minRobotDist) return false;
      }
      if (!isClearSegment(robot.position, bay.position, solids)) return false;
      return true;
    })
    .sort((a, b) =>
      Math.hypot(a.position.x - robot.position.x, a.position.z - robot.position.z) -
      Math.hypot(b.position.x - robot.position.x, b.position.z - robot.position.z)
    );

  return available[0]?.position;
}

function registerRouteReservations(robot: RobotRuntime, path: Vec2[], tick: number, scenario: WarehouseScenario) {
  for (const waypoint of path) {
    const cellKey = reservationCellKey(waypoint);
    if (!routeReservationTable.has(cellKey)) {
      routeReservationTable.set(cellKey, new Set());
    }
    routeReservationTable.get(cellKey)!.add(robot.id);
  }
  robot.routeAssignedAtTick = tick;
  robot.waitTicksAtRouteStart = robot.totalWaitTicks;
}

function clearRobotRouteReservations(robotId: number) {
  for (const [key, robotIds] of routeReservationTable) {
    robotIds.delete(robotId);
    if (robotIds.size === 0) routeReservationTable.delete(key);
  }
}

function buildCongestionContextForTick(
  congestionMap: Map<string, number>,
  scenario: WarehouseScenario
): CongestionContext {
  const stationQueueLengths: Record<string, number> = {};
  for (const queue of stationQueues) {
    stationQueueLengths[queue.stationId] = queue.occupiedBy.length;
  }

  const totalBays = yieldBays.length || 1;
  const occupiedBays = yieldBays.filter(b => b.occupied).length;

  const routeReservations = new Map<string, number>();
  for (const [key, robotIds] of routeReservationTable) {
    routeReservations.set(key, robotIds.size);
  }

  return {
    congestionMap,
    stationQueueLengths,
    yieldBayOccupancy: occupiedBays / totalBays,
    routeReservations,
    aisleDirections: computeAisleDirectionRanges(scenario),
  };
}

function computeAisleDirectionRanges(scenario: WarehouseScenario) {
  const lanes = scenario.simulation.aisleLanes;
  if (!lanes || lanes.length === 0) return [];

  const ext = computeWarehouseExtents(scenario);
  const { racks } = scenario;
  const pairCount = Math.ceil(racks.rowCount / 2);
  const result: { minZ: number; maxZ: number; direction: "one-way-forward" | "one-way-reverse" | "two-way" }[] = [];

  for (const lane of lanes) {
    if (lane.aisleIndex < 0 || lane.aisleIndex >= pairCount) continue;
    const aisleZ = ext.rackBlockStartZ + lane.aisleIndex * racks.rowPitch + racks.rowPitch / 2;
    const halfWidth = racks.aisleWidth / 2;
    result.push({ minZ: aisleZ - halfWidth, maxZ: aisleZ + halfWidth, direction: lane.direction });
  }
  return result;
}

function checkDynamicReroute(
  robot: RobotRuntime,
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  graph: NavGraph,
  missions: Mission[],
  slots: Slot[],
  ctx: CongestionContext,
  tick: number
): boolean {
  if (!robot.routeAssignedAtTick || robot.path.length === 0) return false;
  if (robot.state === "yielding" || robot.state === "picking" || robot.state === "placing" ||
      robot.state === "charging" || robot.state === "idle") return false;

  const delayTicks = robot.totalWaitTicks - (robot.waitTicksAtRouteStart ?? 0);
  if (delayTicks < REROUTE_DELAY_THRESHOLD) return false;

  const mission = missions.find(m => m.id === robot.missionId);
  let newPath: Vec2[] = [];

  if (robot.state === "to-pick") {
    const slot = slots.find(s => s.id === mission?.sourceSlotId);
    if (slot) newPath = pathToSlotPredictive(graph, robot.position, { x: slot.position.x, z: slot.position.z }, ctx);
  } else if (robot.state === "to-drop") {
    const station = scenario.stations.find(s => s.id === mission?.targetStationId);
    if (station) newPath = pathToStationPredictive(graph, robot.position, station, ctx);
  } else if (robot.state === "returning") {
    const solids = buildSolidObstacles(scenario);
    newPath = buildReturnPathToStandby(robot, robots, scenario, graph, solids, ctx);
  } else if (robot.state === "to-charge") {
    const chargingStation = scenario.stations.find(s => s.type === "charging");
    if (chargingStation) newPath = pathToStationPredictive(graph, robot.position, chargingStation, ctx);
  } else if (robot.state === "to-point") {
    const target = mission?.targetPosition;
    if (target) newPath = pathToPointPredictive(graph, robot.position, target, ctx);
  }

  if (newPath.length > 1) {
    clearRobotRouteReservations(robot.id);
    robot.path = newPath;
    robot.pathIndex = 0;
    robot.blockedTicks = 0;
    registerRouteReservations(robot, newPath, tick, scenario);
    dynamicRerouteCount++;
    if (mission) {
      mission.statusNote = "Dynamic reroute: congestion-aware replanning";
      mission.replanCount = (mission.replanCount ?? 0) + 1;
    }
    return true;
  }

  return false;
}

function buildPhysicalQueueSlots(scenario: WarehouseScenario): PhysicalQueueSlot[] {
  const result: PhysicalQueueSlot[] = [];
  const radius = robotRadius(scenario);
  const spacing = radius * 2 + (scenario.simulation.robotClearanceMeters ?? 0.12) + 0.5;

  for (const station of scenario.stations) {
    if (station.type === "charging") continue;
    const approach = stationApproachPosition(station, scenario);
    const dx = approach.x - station.position.x;
    const dz = approach.z - station.position.z;
    const len = Math.hypot(dx, dz) || 1;
    const dirX = dx / len;
    const dirZ = dz / len;

    for (let i = 0; i < station.queueCapacity; i++) {
      const offset = (i + 1) * spacing;
      result.push({
        id: `qslot-${station.id}-${i}`,
        stationId: station.id,
        position: { x: approach.x + dirX * offset, z: approach.z + dirZ * offset },
      });
    }
  }
  return result;
}

function findAvailableQueueSlot(stationId: string, robotId: number): PhysicalQueueSlot | undefined {
  return physicalQueueSlots.find(qs =>
    qs.stationId === stationId &&
    (qs.assignedRobotId === undefined || qs.assignedRobotId === robotId)
  );
}

function releaseQueueSlot(robotId: number) {
  for (const slot of physicalQueueSlots) {
    if (slot.assignedRobotId === robotId) {
      slot.assignedRobotId = undefined;
    }
  }
}

export function getRouteReservationCount(): number {
  let count = 0;
  for (const robotIds of routeReservationTable.values()) {
    count += robotIds.size;
  }
  return count;
}

export function getDynamicRerouteCount(): number {
  return dynamicRerouteCount;
}

export function getPhysicalQueueSlots(): PhysicalQueueSlot[] {
  return physicalQueueSlots;
}

function updateParkingBayStates(robots: RobotRuntime[], scenario: WarehouseScenario) {
  const radius = robotRadius(scenario);
  const tolerance = standbyArrivalTolerance(scenario);
  const solids = buildSolidObstacles(scenario);

  for (const bay of parkingBayRegistry) {
    const occupyingRobot = robots.find(r =>
      r.assignedParkingBayId === bay.id &&
      (r.state === "idle" || r.state === "charging") &&
      distance(r.position, bay.position) <= tolerance
    );
    if (occupyingRobot) {
      bay.state = "occupied";
      bay.assignedRobotId = occupyingRobot.id;
      continue;
    }

    const reservingRobot = robots.find(r =>
      r.assignedParkingBayId === bay.id &&
      (r.state === "returning" || r.state === "yielding")
    );
    if (reservingRobot) {
      bay.state = "reserved";
      bay.assignedRobotId = reservingRobot.id;
      continue;
    }

    const physicallyBlocked = solids.some(s => circleIntersectsRect(bay.position, radius + 0.15, s));
    const robotBlocking = robots.some(r =>
      r.assignedParkingBayId !== bay.id &&
      distance(r.position, bay.position) < radius * 2 + 0.3 &&
      r.state !== "idle"
    );
    if (physicallyBlocked || robotBlocking) {
      bay.state = "blocked";
      bay.assignedRobotId = undefined;
      continue;
    }

    if (bay.assignedRobotId) {
      const claimingRobot = robots.find(r => r.id === bay.assignedRobotId && r.assignedParkingBayId === bay.id);
      if (!claimingRobot) {
        bay.state = "free";
        bay.assignedRobotId = undefined;
      }
    } else {
      bay.state = "free";
    }
  }
}

function assignCompletedWaveParking(
  robots: RobotRuntime[],
  missions: Mission[],
  scenario: WarehouseScenario,
  graph: NavGraph,
  solids: SolidRect[],
  ctx: CongestionContext | undefined,
  tick: number
) {
  if (missions.length === 0) return;
  if (missions.length < 3) return;
  if (!missions.every(m => m.status === "done" || m.status === "failed")) return;
  if (robots.some(r => r.missionId || r.carryingSlotId || r.state === "picking" || r.state === "placing" || r.state === "to-pick" || r.state === "to-drop")) return;

  if (isHomeParkingStrategy(scenario)) {
    assignCompletedWaveHomeParking(robots, scenario, graph, solids, ctx, tick);
    return;
  }

  const primaryBays = parkingBayRegistry.filter(bay => bay.state !== "blocked");
  if (primaryBays.length < robots.length) return;

  const tolerance = standbyArrivalTolerance(scenario);
  const desired = new Map<number, ParkingBayInfo>();
  const primaryById = new Map(primaryBays.map(bay => [bay.id, bay]));
  const claimedBayIds = new Set<string>();

  const sortedRobots = [...robots].sort((a, b) => a.id - b.id);
  for (const robot of sortedRobots) {
    if (robot.state !== "idle" && robot.state !== "returning" && robot.state !== "yielding") continue;
    const currentBay = robot.assignedParkingBayId ? primaryById.get(robot.assignedParkingBayId) : undefined;
    const alreadyAtCurrentBay = currentBay ? distance(robot.position, currentBay.position) <= tolerance : false;
    const currentAccessBlocked = currentBay ? isParkingBayAccessBlockedByParkedRobot(currentBay, robots) : false;
    if (currentBay && !claimedBayIds.has(currentBay.id) && alreadyAtCurrentBay && !currentAccessBlocked) {
      desired.set(robot.id, currentBay);
      claimedBayIds.add(currentBay.id);
    }
  }

  const unassignedBays = primaryBays.filter(bay => !claimedBayIds.has(bay.id));
  for (const robot of sortedRobots) {
    if (robot.state !== "idle" && robot.state !== "returning" && robot.state !== "yielding") continue;
    if (desired.has(robot.id)) continue;
    const side = parkingSidePreference(robot);
    unassignedBays.sort((a, b) => {
      const aSidePenalty = side !== 0 && Math.sign(a.position.x) !== side ? 1000 : 0;
      const bSidePenalty = side !== 0 && Math.sign(b.position.x) !== side ? 1000 : 0;
      return (distance(a.position, robot.position) + aSidePenalty) -
        (distance(b.position, robot.position) + bSidePenalty);
    });
    const bayIndex = unassignedBays.findIndex(candidate => !isParkingBayAccessBlockedByParkedRobot(candidate, robots));
    const bay = bayIndex >= 0 ? unassignedBays.splice(bayIndex, 1)[0] : unassignedBays.shift();
    if (bay) {
      desired.set(robot.id, bay);
      claimedBayIds.add(bay.id);
    }
  }

  for (const robot of sortedRobots) {
    const bay = desired.get(robot.id);
    if (!bay) continue;
    const alreadyThere = robot.assignedParkingBayId === bay.id &&
      distance(robot.position, bay.position) <= tolerance &&
      (robot.state === "idle" || robot.state === "charging");
    if (alreadyThere) continue;

    const currentTarget = robot.assignedParkingPosition ?? robot.homePosition;
    const alreadyTargeting = robot.assignedParkingBayId === bay.id &&
      distance(currentTarget, bay.position) <= tolerance &&
      robot.state === "returning";
    if (alreadyTargeting) continue;

    const path = ctx
      ? pathToPointPredictive(graph, robot.position, bay.position, ctx)
      : pathToPoint(graph, robot.position, bay.position);
    if (!isReturnPathUsable(path, bay.position, solids, scenario)) continue;

    const oldBayId = robot.assignedParkingBayId;
    if (oldBayId && oldBayId !== bay.id) releaseParkingBay(robot);
    robot.assignedParkingBayId = bay.id;
    robot.assignedParkingPosition = { ...bay.position };
    robot.parkingReassignReason = "completed-wave-compact-parking";
    robot.state = "returning";
    robot.path = path;
    robot.pathIndex = 0;
    robot.blockedTicks = 0;
    bay.state = "reserved";
    bay.assignedRobotId = robot.id;
    clearRobotRouteReservations(robot.id);
    registerRouteReservations(robot, path, tick, scenario);
  }
}

function assignCompletedWaveHomeParking(
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  graph: NavGraph,
  solids: SolidRect[],
  ctx: CongestionContext | undefined,
  tick: number
) {
  const tolerance = standbyArrivalTolerance(scenario);
  for (const robot of robots) {
    if (robot.state !== "idle" && robot.state !== "returning" && robot.state !== "yielding") continue;
    if (robot.state === "yielding") continue;
    // Post-charge robots rest at their temporary nearby bay; do not drag them home.
    if (robot.usingTemporaryBay) continue;
    // Column ordering: deeper bays dock first.
    if (distance(robot.position, robot.homePosition) > tolerance &&
        holdForInboundDeeperColumnRobot(robot, robots, scenario)) continue;

    const homeBayId = findBayIdForPosition(robot.homePosition, tolerance * 3);
    if (robot.assignedParkingBayId && robot.assignedParkingBayId !== homeBayId) {
      releaseParkingBay(robot);
    }
    robot.assignedParkingBayId = homeBayId;
    robot.assignedParkingPosition = { ...robot.homePosition };

    if (distance(robot.position, robot.homePosition) <= tolerance) {
      dockRobotAtParkingTarget(robot, scenario, "home-slot");
      updateBayStateForRobot(robot, "occupied");
      clearRobotRouteReservations(robot.id);
      continue;
    }

    if (
      robot.state === "returning" &&
      robot.path.length > 0 &&
      distance(parkingTarget(robot), robot.homePosition) <= tolerance
    ) {
      continue;
    }

    const path = ctx
      ? pathToPointPredictive(graph, robot.position, robot.homePosition, ctx)
      : pathToPoint(graph, robot.position, robot.homePosition);
    if (!isReturnPathUsable(path, robot.homePosition, solids, scenario)) continue;

    robot.state = "returning";
    robot.path = path;
    robot.pathIndex = 0;
    robot.blockedTicks = 0;
    robot.waitTicks = 0;
    robot.parkingReassignReason = "return-home-slot";
    updateBayStateForRobot(robot, "reserved");
    clearRobotRouteReservations(robot.id);
    registerRouteReservations(robot, path, tick, scenario);
  }
}

function enforceExactHomeDockingWhenComplete(
  robots: RobotRuntime[],
  missions: Mission[],
  scenario: WarehouseScenario,
  graph: NavGraph,
  solids: SolidRect[],
  ctx: CongestionContext | undefined,
  tick: number
) {
  if (!isHomeParkingStrategy(scenario)) return;
  if (!isCompletedMissionWaveParkingMode(robots, missions)) return;

  const tolerance = standbyArrivalTolerance(scenario);
  const captureTolerance = Math.max(tolerance * 1.25, robotRadius(scenario) * 0.65);

  for (const robot of robots) {
    if (
      robot.missionId ||
      robot.carryingSlotId ||
      robot.state === "picking" ||
      robot.state === "placing" ||
      robot.state === "to-pick" ||
      robot.state === "to-drop" ||
      robot.state === "to-point" ||
      robot.state === "charging" ||
      robot.state === "to-charge" ||
      robot.state === "yielding" || // mid-shuffle: do not yank it back onto its bay
      robot.usingTemporaryBay
    ) {
      continue;
    }

    const homeBayId = findBayIdForPosition(robot.homePosition, tolerance * 3);
    if (robot.assignedParkingBayId && robot.assignedParkingBayId !== homeBayId) {
      releaseParkingBay(robot);
    }
    robot.assignedParkingBayId = homeBayId;
    robot.assignedParkingPosition = { ...robot.homePosition };

    const homeDistance = distance(robot.position, robot.homePosition);
    if (homeDistance <= captureTolerance) {
      dockRobotAtParkingTarget(robot, scenario, "exact-home-dock");
      updateBayStateForRobot(robot, "occupied");
      clearRobotRouteReservations(robot.id);
      continue;
    }

    if (robot.state === "returning" && robot.path.length > 0 && distance(parkingTarget(robot), robot.homePosition) <= tolerance) {
      continue;
    }

    // Column ordering: wait while a deeper bay in this column still has a robot inbound.
    if (holdForInboundDeeperColumnRobot(robot, robots, scenario)) continue;

    const path = ctx
      ? pathToPointPredictive(graph, robot.position, robot.homePosition, ctx)
      : pathToPoint(graph, robot.position, robot.homePosition);
    if (!isReturnPathUsable(path, robot.homePosition, solids, scenario)) continue;

    robot.state = "returning";
    robot.path = path;
    robot.pathIndex = 0;
    robot.blockedTicks = 0;
    robot.waitTicks = 0;
    robot.waitingForRobotId = undefined;
    robot.parkingReassignReason = "final-home-homing";
    updateBayStateForRobot(robot, "reserved");
    clearRobotRouteReservations(robot.id);
    registerRouteReservations(robot, path, tick, scenario);
  }
}

function isCompletedMissionWaveParkingMode(robots: RobotRuntime[], missions: Mission[]): boolean {
  if (missions.length === 0) {
    return !robots.some(robot =>
      robot.missionId ||
      robot.carryingSlotId ||
      robot.state === "picking" ||
      robot.state === "placing" ||
      robot.state === "to-pick" ||
      robot.state === "to-drop" ||
      robot.state === "to-point"
    );
  }
  if (missions.length < 3) return false;
  if (!missions.every(m => m.status === "done" || m.status === "failed")) return false;
  return !robots.some(robot =>
    robot.missionId ||
    robot.carryingSlotId ||
    robot.state === "picking" ||
    robot.state === "placing" ||
    robot.state === "to-pick" ||
    robot.state === "to-drop" ||
    robot.state === "to-point"
  );
}

function hasQueuedMissions(missions: Mission[]): boolean {
  return missions.some(mission => mission.status === "queued");
}

function shouldReturnIdleRobotHome(missions: Mission[]): boolean {
  if (missions.length === 0) return true;
  return !hasQueuedMissions(missions);
}

function parkingSidePreference(robot: RobotRuntime): number {
  if (Math.abs(robot.position.x) > 0.1) return Math.sign(robot.position.x);
  const target = robot.assignedParkingPosition ?? robot.homePosition;
  return Math.abs(target.x) > 0.1 ? Math.sign(target.x) : 0;
}

function tryFinalAutoDock(
  robot: RobotRuntime,
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  missions: Mission[],
  tick: number
): boolean {
  const latestCompletion = Math.max(0, ...missions.map(m => m.completedAtTick ?? 0));
  if (tick - latestCompletion < 240) return false;

  const target = parkingTarget(robot);
  const distanceToTarget = distance(robot.position, target);
  // Only capture the final fraction of a metre. Snapping from farther away made robots
  // visibly teleport into their bay once the mission wave ended; they must drive the
  // whole return route and the auto-dock just finishes the docking alignment.
  const dockRadius = Math.max(1.2, robotRadius(scenario) * 2);
  if (distanceToTarget > dockRadius) return false;

  const minDistance = robotRadius(scenario) * 2 + (scenario.simulation.robotClearanceMeters ?? 0.12);
  const targetBlocked = robots.some(other =>
    other.id !== robot.id &&
    distance(other.position, target) < minDistance
  );
  if (targetBlocked) return false;

  dockRobotAtParkingTarget(robot, scenario, "final-auto-dock");
  return true;
}

function isParkingBayAccessBlockedByParkedRobot(bay: ParkingBayInfo, robots: RobotRuntime[]): boolean {
  const sameSideInnerBay = parkingBayRegistry
    .filter(other =>
      other.id !== bay.id &&
      Math.sign(other.position.x) === Math.sign(bay.position.x) &&
      Math.abs(other.position.z - bay.position.z) < 0.2 &&
      Math.abs(other.position.x) < Math.abs(bay.position.x)
    )
    .sort((a, b) => Math.abs(b.position.x) - Math.abs(a.position.x))[0];

  if (!sameSideInnerBay) return false;
  const blockingRobot = robots.find(robot =>
    robot.assignedParkingBayId === sameSideInnerBay.id &&
    (robot.state === "idle" || robot.state === "charging") &&
    distance(robot.position, sameSideInnerBay.position) <= 0.45
  );
  return Boolean(blockingRobot);
}

function updateBayStateForRobot(robot: RobotRuntime, state: "occupied" | "reserved") {
  if (!robot.assignedParkingBayId) return;
  const bay = parkingBayRegistry.find(b => b.id === robot.assignedParkingBayId);
  if (bay) {
    bay.state = state;
    bay.assignedRobotId = robot.id;
  }
}

function releaseParkingBay(robot: RobotRuntime) {
  if (!robot.assignedParkingBayId) return;
  const bay = parkingBayRegistry.find(b => b.id === robot.assignedParkingBayId);
  if (bay && bay.assignedRobotId === robot.id) {
    bay.state = "free";
    bay.assignedRobotId = undefined;
  }
}

function findBayIdForPosition(position: Vec2, tolerance: number): string | undefined {
  const bay = parkingBayRegistry.find(b => distance(b.position, position) < tolerance);
  if (bay) return bay.id;

  const newId = `PB-D${String(parkingBayRegistry.length + 1).padStart(2, "0")}`;
  parkingBayRegistry.push({
    id: newId,
    position: { ...position },
    state: "free",
  });
  return newId;
}

function isReturningRobotBlockingStationExit(
  robot: RobotRuntime,
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  missions: Mission[]
): boolean {
  const radius = robotRadius(scenario);
  const exitCheckRadius = radius * 4;

  for (const station of scenario.stations) {
    if (station.type === "charging") continue;
    const approach = stationApproachPosition(station, scenario);
    const distToApproach = distance(robot.position, approach);
    if (distToApproach > exitCheckRadius) continue;

    const missionRobotNearby = robots.some(r =>
      r.id !== robot.id &&
      r.missionId !== undefined &&
      (r.state === "to-drop" || r.state === "to-pick") &&
      distance(r.position, approach) < exitCheckRadius * 1.5
    );
    if (missionRobotNearby) return true;
  }
  return false;
}

function yieldReturningRobotFromStation(
  robot: RobotRuntime,
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  missions: Mission[],
  congestionMap: Map<string, number>,
  solids: SolidRect[],
  tick: number
): boolean {
  return startYieldManeuver(
    robot, robots, scenario, missions, congestionMap, solids,
    "Returning robot yielding from station exit area", tick
  );
}

function resolveReturningRobotParkingClusters(
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  missions: Mission[],
  congestionMap: Map<string, number>,
  solids: SolidRect[],
  tick: number
) {
  const radius = robotRadius(scenario);
  const clusterRadius = radius * 6;
  const returningOrIdle = robots.filter(r =>
    (r.state === "returning" || r.state === "idle") &&
    !r.missionId
  );
  if (returningOrIdle.length < 3) return;

  const clusters: RobotRuntime[][] = [];
  const assigned = new Set<number>();
  for (const robot of returningOrIdle) {
    if (assigned.has(robot.id)) continue;
    const cluster = returningOrIdle.filter(r =>
      !assigned.has(r.id) && distance(r.position, robot.position) < clusterRadius
    );
    if (cluster.length >= 3) {
      clusters.push(cluster);
      for (const r of cluster) assigned.add(r.id);
    }
  }

  for (const cluster of clusters) {
    const missionRobotNearby = robots.find(r =>
      r.missionId !== undefined &&
      (r.state === "to-pick" || r.state === "to-drop") &&
      cluster.some(c =>
        distance(c.position, r.position) < clusterRadius ||
        robotPathPassesNear(r, c.position, clusterRadius * 0.9)
      )
    );
    if (!missionRobotNearby) continue;

    const sorted = cluster.sort((a, b) =>
      supervisorProtectionScore(a, missions, scenario) - supervisorProtectionScore(b, missions, scenario)
    );

    let moved = 0;
    for (const blocker of sorted) {
      if (moved >= 2) break;
      if (blocker.state !== "idle" && blocker.state !== "returning") continue;

      if (!canDynamicallyReassignParking(scenario)) {
        if (startYieldManeuver(
          blocker,
          robots,
          scenario,
          missions,
          congestionMap,
          solids,
          `Parking cluster: yielding temporarily for mission R${String(missionRobotNearby.id).padStart(2, "0")}`,
          tick
        )) {
          blocker.parkingReassignReason = "temporary-yield-return-home";
          moved++;
        }
        continue;
      }

      const oldBayId = blocker.assignedParkingBayId;
      releaseParkingBay(blocker);
      blocker.assignedParkingPosition = undefined;
      blocker.assignedParkingBayId = undefined;
      blocker.parkingReassignReason = "cluster-near-mission-robot";

      const target = findAvailableStandbyTarget(blocker, robots, scenario, solids);
      if (target) {
        blocker.assignedParkingPosition = { ...target };
        const bayId = findBayIdForPosition(target, standbyArrivalTolerance(scenario) * 3);
        blocker.assignedParkingBayId = bayId;
        if (bayId) updateBayStateForRobot(blocker, "reserved");
        blocker.state = "returning";
        blocker.path = buildYieldPath(blocker.position, target, solids, robotRadius(scenario), robots, blocker.id);
        blocker.pathIndex = 0;
        blocker.blockedTicks = 0;
        moved++;

        parkingReassignments.push({
          tick,
          robotId: blocker.id,
          fromBayId: oldBayId,
          toBayId: bayId ?? "fallback",
          reason: `Cluster resolve: clear path for mission R${String(missionRobotNearby.id).padStart(2, "0")}`,
        });

        recordTrafficEvent(tick, "cluster-resolve", blocker, missionRobotNearby.id,
          `Parking cluster: R${String(blocker.id).padStart(2, "0")} relocated for R${String(missionRobotNearby.id).padStart(2, "0")}`);
      }
    }
  }
}

function robotPathPassesNear(robot: RobotRuntime, point: Vec2, radius: number): boolean {
  const lookahead = robot.path.slice(robot.pathIndex, robot.pathIndex + 8);
  return lookahead.some(pathPoint => distance(pathPoint, point) < radius);
}
