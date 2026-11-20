import type { WarehouseScenario, Slot, RobotRuntime, Mission, NavGraph, SimMetrics } from "../domain/schema";
import { createDefaultScenario } from "./defaultScenario";
import { generateSlots, normalizeScenarioGeometry, type ScenarioGeometryAdjustment } from "../domain/warehouseGenerator";
import { buildNavigationGraph } from "../domain/navigationGraph";
import { initRobots } from "../domain/robotSimulation";
import { clearTraces } from "../domain/traceRecorder";

export type AppState = {
  scenario: WarehouseScenario;
  slots: Slot[];
  robots: RobotRuntime[];
  missions: Mission[];
  navGraph: NavGraph;
  metrics: SimMetrics;
  tick: number;
  running: boolean;
  congestionMap: Map<string, number>;
  statusMessage: string;
  customModelBlob?: string;
};

let state: AppState;
let listeners: Array<() => void> = [];

export function getState(): AppState {
  return state;
}

export function subscribe(fn: () => void) {
  listeners.push(fn);
  return () => { listeners = listeners.filter(l => l !== fn); };
}

function notify() {
  for (const fn of listeners) fn();
}

export function initState() {
  const scenario = createDefaultScenario();
  normalizeScenarioGeometry(scenario);
  const slots = generateSlots(scenario);
  const navGraph = buildNavigationGraph(scenario);
  const robots = initRobots(scenario);
  state = {
    scenario,
    slots,
    robots,
    missions: [],
    navGraph,
    tick: 0,
    running: false,
    congestionMap: new Map(),
    statusMessage: "Ready",
    metrics: emptyMetrics(robots.length, slots),
    customModelBlob: undefined,
  };
  notify();
}

export function updateScenario(partial: Partial<WarehouseScenario>) {
  state.scenario = { ...state.scenario, ...partial };
  rebuildWorld();
}

export function updateScenarioField<K extends keyof WarehouseScenario>(key: K, value: WarehouseScenario[K]) {
  (state.scenario as Record<string, unknown>)[key] = value;
}

export function rebuildWorld() {
  const geometry = normalizeScenarioGeometry(state.scenario);
  state.slots = generateSlots(state.scenario);
  state.navGraph = buildNavigationGraph(state.scenario);
  state.robots = initRobots(state.scenario);
  state.missions = [];
  state.tick = 0;
  state.congestionMap = new Map();
  state.metrics = emptyMetrics(state.robots.length, state.slots);
  state.statusMessage = rebuildStatusMessage("Scenario rebuilt", geometry);
  clearTraces();
  notify();
}

export function setState(partial: Partial<AppState>) {
  Object.assign(state, partial);
  notify();
}

export function setStatus(msg: string) {
  state.statusMessage = msg;
  notify();
}

export function loadScenario(scenario: WarehouseScenario, slotsData?: Slot[], missionsData?: Mission[]) {
  state.scenario = withScenarioDefaults(scenario);
  const geometry = normalizeScenarioGeometry(state.scenario);
  state.slots = geometry.warehouseResized || geometry.stationsMoved.length > 0
    ? generateSlots(state.scenario)
    : slotsData ?? generateSlots(state.scenario);
  state.navGraph = buildNavigationGraph(state.scenario);
  state.robots = initRobots(state.scenario);
  state.missions = missionsData ?? [];
  state.tick = 0;
  state.congestionMap = new Map();
  state.metrics = emptyMetrics(state.robots.length, state.slots);
  state.statusMessage = rebuildStatusMessage("Scenario loaded", geometry);
  clearTraces();
  notify();
}

function withScenarioDefaults(scenario: WarehouseScenario): WarehouseScenario {
  const defaults = createDefaultScenario();
  const stations = (scenario.stations ?? defaults.stations).map(s => ({
    ...s,
    queueCapacity: s.queueCapacity ?? (s.type === "charging" ? 6 : 3),
  }));
  return {
    ...defaults,
    ...scenario,
    warehouse: { ...defaults.warehouse, ...scenario.warehouse },
    racks: { ...defaults.racks, ...scenario.racks },
    boxes: { ...defaults.boxes, ...scenario.boxes },
    inventory: { ...defaults.inventory, ...scenario.inventory },
    visual: { ...defaults.visual, ...scenario.visual },
    robots: { ...defaults.robots, ...scenario.robots },
    simulation: { ...defaults.simulation, ...scenario.simulation },
    stations,
  };
}

function emptyMetrics(robotCount: number, slots: Slot[]): SimMetrics {
  const occ = slots.filter(s => s.occupied).length;
  return {
    totalRobots: robotCount,
    activeRobots: 0,
    idleRobots: robotCount,
    totalSlots: slots.length,
    occupiedSlots: occ,
    fillRate: slots.length > 0 ? occ / slots.length : 0,
    queuedMissions: 0,
    doneMissions: 0,
    failedMissions: 0,
    avgMissionTime: 0,
    throughputPerHour: 0,
    avgRobotUtilization: 0,
    totalDistanceTraveled: 0,
    avgWaitTime: 0,
    topCongestedAisle: "none",
    batteryLowCount: 0,
    throughputHistory: [],
    chargingRobots: 0,
    stationQueueLengths: {},
    deadlocksDetected: 0,
    deadlocksResolved: 0,
    timeWindowReservations: 0,
    yieldEvents: 0,
    headOnConflicts: 0,
    priorityPasses: 0,
    avgDelayPerAisle: {},
    routeEfficiency: 1,
    totalConflicts: 0,
    physicalCollisions: 0,
    totalQueueWaitTicks: 0,
    throughputLoss: 0,
    routeReservationCount: 0,
    dynamicReroutes: 0,
  };
}

function rebuildStatusMessage(base: string, geometry: ScenarioGeometryAdjustment): string {
  const notes: string[] = [];
  if (geometry.warehouseResized) {
    notes.push(`auto-sized to ${geometry.width.toFixed(0)}m x ${geometry.depth.toFixed(0)}m`);
  }
  if (geometry.stationsMoved.length > 0) {
    notes.push(`moved stations: ${geometry.stationsMoved.join(", ")}`);
  }
  return notes.length > 0 ? `${base}; ${notes.join("; ")}` : base;
}
