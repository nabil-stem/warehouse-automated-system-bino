import type { SimMetrics, RobotRuntime, Mission, Slot, StationConfig } from "./schema";
import { getDeadlockStats, getTrafficEvents, getRouteReservationCount, getDynamicRerouteCount, getPhysicalCollisionCount } from "./robotSimulation";

export function computeMetrics(
  robots: RobotRuntime[],
  missions: Mission[],
  slots: Slot[],
  congestionMap: Map<string, number>,
  tick: number,
  tickMs: number,
  throughputHistory: number[],
  stations?: StationConfig[]
): SimMetrics {
  const activeRobots = robots.filter(r => r.state !== "idle" && r.state !== "charging").length;
  const idleRobots = robots.filter(r => r.state === "idle").length;
  const chargingRobots = robots.filter(r => r.state === "charging" || r.state === "to-charge").length;
  const occupiedSlots = slots.filter(s => s.occupied).length;
  const doneMissions = missions.filter(m => m.status === "done");
  const failedMissions = missions.filter(m => m.status === "failed");
  const queuedMissions = missions.filter(m => m.status === "queued" || m.status === "assigned");

  let avgMissionTime = 0;
  if (doneMissions.length > 0) {
    const totalTime = doneMissions.reduce((sum, m) => {
      const dur = (m.completedAtTick ?? m.createdAtTick) - m.createdAtTick;
      return sum + dur;
    }, 0);
    avgMissionTime = totalTime / doneMissions.length;
  }

  const simHours = (tick * tickMs) / 3600000;
  const throughputPerHour = simHours > 0 ? doneMissions.length / simHours : 0;

  const avgRobotUtilization = robots.length > 0
    ? activeRobots / robots.length
    : 0;

  const totalDistanceTraveled = robots.reduce((sum, r) => sum + r.totalDistance, 0);
  const totalWait = robots.reduce((sum, r) => sum + r.totalWaitTicks, 0);
  const avgWaitTime = robots.length > 0 ? totalWait / robots.length : 0;

  let topCongestedAisle = "none";
  let maxCongestion = 0;
  for (const [key, val] of congestionMap) {
    if (val > maxCongestion) { maxCongestion = val; topCongestedAisle = key; }
  }

  const batteryLowCount = robots.filter(r => r.batteryMinutes < 10).length;

  const newHistory = [...throughputHistory, throughputPerHour].slice(-60);

  const stationQueueLengths: Record<string, number> = {};
  if (stations) {
    for (const station of stations) {
      const assignedToStation = missions.filter(
        m => m.targetStationId === station.id &&
        (m.status === "moving" || m.status === "assigned" || m.status === "placing")
      ).length;
      stationQueueLengths[station.id] = assignedToStation;
    }
  }

  const dlStats = getDeadlockStats();

  const avgDelayPerAisle: Record<string, number> = {};
  const robotDivisor = Math.max(robots.length, 1);
  for (const [key, val] of congestionMap) {
    avgDelayPerAisle[key] = val / robotDivisor;
  }

  let estTotal = 0;
  let actTotal = 0;
  for (const m of doneMissions) {
    estTotal += m.estimatedDistance ?? m.distanceMeters;
    actTotal += m.distanceMeters;
  }
  const routeEfficiency = actTotal > 0 ? Math.min(1, estTotal / actTotal) : 1;

  const trafficEvts = getTrafficEvents();
  const totalConflicts = dlStats.deadlocksDetected + trafficEvts.filter(e => e.type === "head-on").length;
  const totalQueueWaitTicks = missions.reduce((s, m) => s + m.waitTicks, 0);

  const totalRobotTicks = robots.length * tick;
  const throughputLoss = totalRobotTicks > 0 ? totalWait / totalRobotTicks : 0;

  return {
    totalRobots: robots.length,
    activeRobots,
    idleRobots,
    totalSlots: slots.length,
    occupiedSlots,
    fillRate: slots.length > 0 ? occupiedSlots / slots.length : 0,
    queuedMissions: queuedMissions.length,
    doneMissions: doneMissions.length,
    failedMissions: failedMissions.length,
    avgMissionTime,
    throughputPerHour,
    avgRobotUtilization,
    totalDistanceTraveled,
    avgWaitTime,
    topCongestedAisle,
    batteryLowCount,
    throughputHistory: newHistory,
    chargingRobots,
    stationQueueLengths,
    deadlocksDetected: dlStats.deadlocksDetected,
    deadlocksResolved: dlStats.deadlocksResolved,
    timeWindowReservations: dlStats.timeWindowReservations,
    yieldEvents: trafficEvts.filter(e => e.type === "yield").length,
    headOnConflicts: trafficEvts.filter(e => e.type === "head-on").length,
    priorityPasses: trafficEvts.filter(e => e.type === "priority-pass").length,
    avgDelayPerAisle,
    routeEfficiency,
    totalConflicts,
    physicalCollisions: getPhysicalCollisionCount(),
    totalQueueWaitTicks,
    throughputLoss,
    routeReservationCount: getRouteReservationCount(),
    dynamicReroutes: getDynamicRerouteCount(),
  };
}
