export type Vec2 = { x: number; z: number };
export type Vec3 = { x: number; y: number; z: number };

export type WarehouseScenario = {
  version: 1;
  name: string;
  seed: number;
  units: "meters";
  warehouse: WarehouseDimensions;
  racks: RackConfig;
  boxes: BoxConfig;
  inventory: InventoryConfig;
  visual: VisualConfig;
  robots: RobotFleetConfig;
  stations: StationConfig[];
  simulation: SimulationConfig;
};

export type WarehouseDimensions = {
  width: number;
  depth: number;
  floorThickness: number;
  wallHeight: number;
  showWalls: boolean;
  showRoof: boolean;
  gridSpacing: number;
};

export type RackConfig = {
  rowCount: number;
  baysPerRow: number;
  levels: number;
  bayWidth: number;
  shelfDepth: number;
  levelHeight: number;
  bottomShelfHeight: number;
  rowPitch: number;
  aisleWidth: number;
  mainAisleWidth: number;
  crossAisleEveryBays: number;
  crossAisleWidth: number;
  rackBeamThickness: number;
  uprightThickness: number;
};

export type BoxConfig = {
  width: number;
  height: number;
  depth: number;
  defaultFillRate: number;
  maxStackPerSlot: number;
};

export type RowInventoryRule = {
  rowIndex: number;
  fillRate: number;
  boxesPerBay?: number;
  skuFamilies?: string[];
};

export type InventoryConfig = {
  skuFamilies: string[];
  rowRules: RowInventoryRule[];
  hotSkuPercentage: number;
  emptySlotPercentage: number;
};

export type VisualConfig = {
  rackStyle: "shelf" | "pallet" | "bin-wall";
  boxStyle: "cartons" | "totes";
  polishedFloor: boolean;
  showHazardLanes: boolean;
  showOverheadStructure: boolean;
  showRackBracing: boolean;
  showBinFaces: boolean;
  referenceModelScale: number;
  referenceModelUrl?: string;
  showSupportColumns: boolean;
  showDockDoors: boolean;
  showSafetyBollards: boolean;
  showFloorTrafficMarks: boolean;
  showPallets: boolean;
  referenceModelOpacity: number;
  showProceduralUnderReference: boolean;
};

export type RobotFleetConfig = {
  count: number;
  speedMetersPerSecond: number;
  turnSpeedRadPerSecond: number;
  /** Max acceleration in m/s^2 used by the smooth motion model. Optional for backwards compatibility. */
  maxAccelerationMps2?: number;
  /** Max deceleration in m/s^2 used for braking before turns, stations and conflicts. */
  maxDecelerationMps2?: number;
  footprintWidth: number;
  footprintDepth: number;
  bodyHeight: number;
  liftMaxHeight: number;
  batteryCapacityMinutes: number;
  customModelUrl?: string;
  customModelScale: number;
  useCustomModel: boolean;
  visualType: "compact-lift" | "stacker-amr" | "tote-carrier" | "scissor-lift";
  showMast: boolean;
};

export type StationConfig = {
  id: string;
  type: "packing" | "inbound" | "charging" | "buffer";
  label: string;
  position: Vec2;
  width: number;
  depth: number;
  capacity: number;
  queueCapacity: number;
};

export type AisleLaneDirection = "one-way-forward" | "one-way-reverse" | "two-way";

export type AisleLaneConfig = {
  aisleIndex: number;
  direction: AisleLaneDirection;
};

export type ParkingStrategy = "home-slots" | "farthest-free" | "nearest-free" | "least-congested" | "balanced-sides";

export type SimulationConfig = {
  tickMs: number;
  timeScale: number;
  missionCount: number;
  routing: "direct" | "a-star" | "reservation-table";
  allocator: "round-robin" | "nearest-robot" | "least-busy" | "eta-optimal";
  collisionAvoidance: boolean;
  showRoutes: boolean;
  showHeatmap: boolean;
  showOperationsMap: boolean;
  operationsMapMode: "layout" | "traffic" | "missions" | "congestion" | "qr-track";
  lowBatteryThreshold: number;
  pickPlaceTimePerLevel: number;
  maxActiveMissions: number;
  autoScaleActiveMissions: boolean;
  robotClearanceMeters: number;
  aisleLanes: AisleLaneConfig[];
  showYieldBays: boolean;
  showLaneGeometry: boolean;
  parkingStrategy: ParkingStrategy;
  /** Optional: picked boxes are processed by an operator at the station, then carried back to their shelf slot. */
  returnBoxesToShelf?: boolean;
  /** Ticks the operator spends processing a box at the station in round-trip mode. */
  operatorProcessTicks?: number;
  /** Optional: the jury demo also showcases one robot driving to the charger and charging. */
  juryChargingShowcase?: boolean;
};

export type Slot = {
  id: string;
  rowIndex: number;
  bayIndex: number;
  levelIndex: number;
  side: -1 | 1;
  position: Vec3;
  sku?: string;
  occupied: boolean;
  demandScore: number;
};

export type LiftTelemetry = {
  targetLevel: number;
  currentExtensionPct: number;
  activeStages: number;
  payloadState: "empty" | "extending" | "loaded" | "lowering";
};

export type TraceEntry = {
  tick: number;
  robotId: number;
  x: number;
  z: number;
  heading: number;
  state: string;
  missionId?: string;
  liftPct: number;
};

export type MissionTrace = {
  missionId: string;
  robotId: number;
  type: string;
  entries: TraceEntry[];
  startTick: number;
  endTick?: number;
};

export type TrafficEventType = "yield" | "deadlock" | "priority-pass" | "head-on" | "queue-wait" | "cluster-resolve";

export type SupervisorCommand = "reverse" | "yield-to-bay" | "move-to-pocket" | "wait";

export type SupervisorDecision = {
  tick: number;
  clusterSize: number;
  protectedRobotId: number;
  protectedReason: string;
  commands: { robotId: number; command: SupervisorCommand; reason: string }[];
};

export type TrafficEvent = {
  tick: number;
  type: TrafficEventType;
  robotId: number;
  otherRobotId?: number;
  position: Vec2;
  reason: string;
};

export type RobotState = "idle" | "to-pick" | "picking" | "to-drop" | "placing" | "charging" | "to-charge" | "to-point" | "returning" | "yielding";

export type CollisionState = "clear" | "watch" | "reserved" | "yielding" | "blocked" | "near-miss" | "physical-contact";

export type ParkingBayState = "free" | "reserved" | "occupied" | "blocked";

export type ParkingBayInfo = {
  id: string;
  position: Vec2;
  state: ParkingBayState;
  assignedRobotId?: number;
};

export type ParkingReassignment = {
  tick: number;
  robotId: number;
  fromBayId?: string;
  toBayId: string;
  reason: string;
};

export type RobotRuntime = {
  id: number;
  position: Vec2;
  homePosition: Vec2;
  assignedParkingPosition?: Vec2;
  assignedParkingBayId?: string;
  heading: number;
  homeHeading?: number;
  state: RobotState;
  preYieldState?: RobotState;
  yieldTarget?: Vec2;
  carryingSlotId?: string;
  missionId?: string;
  batteryMinutes: number;
  path: Vec2[];
  pathIndex: number;
  waitTicks: number;
  blockedTicks: number;
  totalDistance: number;
  totalWaitTicks: number;
  currentSpeedMps?: number;
  liftTelemetry: LiftTelemetry;
  deadlockRecoveries: number;
  waitingForRobotId?: number;
  consecutiveYields: number;
  routeAssignedAtTick?: number;
  waitTicksAtRouteStart?: number;
  parkingReassignReason?: string;
  collisionState?: CollisionState;
  collisionStateReason?: string;
  collisionClearanceMeters?: number;
  /** Ticks this robot has been held by the startup dispatch controller (counts up while held). */
  startupHoldTicks?: number;
  /** Launch queue rank within the current wave (1 = launches first). */
  launchPriority?: number;
  /** Startup wave this robot launched (or is queued to launch) in. */
  launchWaveId?: number;
  /** Human-readable startup dispatch decision for this robot. */
  launchReason?: string;
  /** Startup dispatch verdict: true = cleared to launch, false = held, undefined = not launching. */
  launchCleared?: boolean;
  /** Parked at a temporary nearby bay (e.g. after charging) instead of the fixed home slot. */
  usingTemporaryBay?: boolean;
  /** Metres driven on its own route since the last yield; forgives the yield streak. */
  yieldDecayMeters?: number;
  /** Consecutive ticks without progress while it should be travelling (watchdog input). */
  stallTicks?: number;
  /** Tick of the last route replan, used to rate-limit reroutes. */
  lastReplanTick?: number;
  /** Station dock this robot is queued for or holds (station access protocol). */
  stationAccessId?: string;
};

export type LaunchDecision = {
  tick: number;
  robotId: number;
  action: "cleared" | "held";
  waveId: number;
  priority: number;
  reason: string;
};

export type StartupDispatchStats = {
  activeWaveId: number;
  heldNow: number;
  clearedInZone: number;
  totalHolds: number;
  totalClearances: number;
  recentDecisions: LaunchDecision[];
};

export type Mission = {
  id: string;
  sku: string;
  sourceSlotId: string;
  targetStationId: string;
  targetPosition?: Vec2;
  type?: "pick-and-drop" | "move-to-point";
  assignedRobotId?: number;
  status: "queued" | "assigned" | "moving" | "picking" | "placing" | "done" | "failed";
  createdAtTick: number;
  completedAtTick?: number;
  distanceMeters: number;
  waitTicks: number;
  failReason?: string;
  statusNote?: string;
  estimatedDistance?: number;
  /** Estimated total mission time in seconds (travel + pick/place service). */
  estimatedTime?: number;
  /** Tick at which the mission was assigned to its robot (estimates baseline). */
  assignedAtTick?: number;
  /** Ticks spent held by the startup dispatch controller. */
  startupHoldTicks?: number;
  /** Yield/shuffle maneuvers performed while running this mission. */
  yieldCount?: number;
  /** Route replans (blocked-too-long or congestion reroutes) during this mission. */
  replanCount?: number;
  /** Round-trip mode: true once the robot is carrying the processed box back to its shelf. */
  returnLeg?: boolean;
};

/** Post-completion record comparing a mission's estimate against what actually happened. */
export type MissionAnalysisRecord = {
  missionId: string;
  robotId?: number;
  status: "done" | "failed";
  targetStationId: string;
  assignedAtTick: number;
  completedAtTick: number;
  estimatedTimeTicks?: number;
  actualTimeTicks: number;
  estimatedDistance?: number;
  actualDistance: number;
  waitTicks: number;
  startupHoldTicks: number;
  yieldCount: number;
  replanCount: number;
  /** actualTimeTicks - estimatedTimeTicks (positive = slower than estimate). */
  delayTicks?: number;
  /** Human-readable problems encountered (empty when the mission ran clean). */
  problems: string[];
};

export type NavNode = {
  id: string;
  position: Vec2;
  neighbors: string[];
};

export type NavGraph = {
  nodes: Map<string, NavNode>;
  scenario?: WarehouseScenario;
};

export type StationQueueState = {
  stationId: string;
  approachPositions: Vec2[];
  occupiedBy: number[];
};

export type PhysicalQueueSlot = {
  id: string;
  stationId: string;
  position: Vec2;
  assignedRobotId?: number;
};

export type SimMetrics = {
  totalRobots: number;
  activeRobots: number;
  idleRobots: number;
  totalSlots: number;
  occupiedSlots: number;
  fillRate: number;
  queuedMissions: number;
  doneMissions: number;
  failedMissions: number;
  avgMissionTime: number;
  throughputPerHour: number;
  avgRobotUtilization: number;
  totalDistanceTraveled: number;
  avgWaitTime: number;
  topCongestedAisle: string;
  batteryLowCount: number;
  throughputHistory: number[];
  chargingRobots: number;
  stationQueueLengths: Record<string, number>;
  deadlocksDetected: number;
  deadlocksResolved: number;
  timeWindowReservations: number;
  yieldEvents: number;
  headOnConflicts: number;
  priorityPasses: number;
  avgDelayPerAisle: Record<string, number>;
  routeEfficiency: number;
  /** Predicted/avoided conflict events (head-on predictions + deadlock detections). Expected to be non-zero. */
  totalConflicts: number;
  /** Real physical footprint-overlap episodes, counted once per contact. Must stay 0. */
  physicalCollisions: number;
  totalQueueWaitTicks: number;
  throughputLoss: number;
  routeReservationCount: number;
  dynamicReroutes: number;
};
