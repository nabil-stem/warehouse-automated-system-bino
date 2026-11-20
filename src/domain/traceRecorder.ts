import type { RobotRuntime, Mission, MissionTrace, TraceEntry } from "./schema";

const activeTraces = new Map<string, MissionTrace>();
const completedTraces: MissionTrace[] = [];

export function recordTick(robots: RobotRuntime[], missions: Mission[], tick: number) {
  for (const robot of robots) {
    if (!robot.missionId) continue;
    const mission = missions.find(m => m.id === robot.missionId);
    if (!mission) continue;

    let trace = activeTraces.get(mission.id);
    if (!trace) {
      trace = {
        missionId: mission.id,
        robotId: robot.id,
        type: mission.type ?? "pick-and-drop",
        entries: [],
        startTick: tick,
      };
      activeTraces.set(mission.id, trace);
    }

    trace.entries.push({
      tick,
      robotId: robot.id,
      x: Math.round(robot.position.x * 100) / 100,
      z: Math.round(robot.position.z * 100) / 100,
      heading: Math.round(robot.heading * 100) / 100,
      state: robot.state,
      missionId: mission.id,
      liftPct: robot.liftTelemetry.currentExtensionPct,
    });
  }

  for (const mission of missions) {
    if ((mission.status === "done" || mission.status === "failed") && activeTraces.has(mission.id)) {
      const trace = activeTraces.get(mission.id)!;
      trace.endTick = tick;
      completedTraces.push(trace);
      activeTraces.delete(mission.id);
    }
  }
}

export function getCompletedTraces(): MissionTrace[] {
  return completedTraces;
}

export function getActiveTraces(): MissionTrace[] {
  return [...activeTraces.values()];
}

export function getAllTraces(): MissionTrace[] {
  return [...completedTraces, ...activeTraces.values()];
}

export function getTraceForMission(missionId: string): MissionTrace | undefined {
  return completedTraces.find(t => t.missionId === missionId) ?? activeTraces.get(missionId);
}

export function clearTraces() {
  activeTraces.clear();
  completedTraces.length = 0;
}

export function exportTracesAsJSON(): string {
  return JSON.stringify(getAllTraces(), null, 2);
}

export function exportTracesAsCSV(): string {
  const lines = ["tick,robotId,missionId,x,z,heading,state,liftPct"];
  for (const trace of getAllTraces()) {
    for (const e of trace.entries) {
      lines.push(`${e.tick},${e.robotId},${e.missionId ?? ""},${e.x},${e.z},${e.heading},${e.state},${e.liftPct}`);
    }
  }
  return lines.join("\n");
}
