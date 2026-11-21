import type { NavGraph, NavNode, Vec2, WarehouseScenario, StationConfig, AisleLaneDirection } from "./schema";
import { computeWarehouseExtents, rackBayBoundaryX } from "./warehouseGenerator";
import { buildSolidObstacles, isClearSegment, pointInsideSolid, stationApproachPosition, type SolidRect } from "./obstacles";

export function buildNavigationGraph(scenario: WarehouseScenario): NavGraph {
  const nodes = new Map<string, NavNode>();
  const { racks } = scenario;
  const ext = computeWarehouseExtents(scenario);
  const solids = buildSolidObstacles(
    scenario,
    Math.max(scenario.robots.footprintWidth, scenario.robots.footprintDepth) / 2 + (scenario.simulation.robotClearanceMeters ?? 0.12)
  );

  const rackStartX = ext.rackBlockStartX;
  const mainAisleZ = ext.mainAisleZ;

  const aisleXPositions: number[] = [];
  aisleXPositions.push(rackStartX - 2);
  for (let bay = 0; bay <= racks.baysPerRow; bay++) {
    aisleXPositions.push(rackBayBoundaryX(scenario, bay, rackStartX));
  }
  for (let bay = 0; bay < racks.baysPerRow; bay++) {
    const left = rackBayBoundaryX(scenario, bay, rackStartX);
    const right = rackBayBoundaryX(scenario, bay + 1, rackStartX);
    aisleXPositions.push((left + right) / 2);
  }
  const every = Math.max(0, Math.floor(racks.crossAisleEveryBays));
  if (every > 0) {
    for (let bay = every; bay < racks.baysPerRow; bay += every) {
      const leftEdge = rackBayBoundaryX(scenario, bay, rackStartX) - racks.crossAisleWidth;
      aisleXPositions.push(leftEdge + racks.crossAisleWidth / 2);
    }
  }
  aisleXPositions.push(rackStartX + ext.rackBlockWidth + 2);

  const pairCount = Math.ceil(racks.rowCount / 2);
  const aisleZPositions: number[] = [mainAisleZ];

  // Each aisle gets two *directional* travel lanes (right-hand traffic: the north lane
  // carries +x, the south lane -x) so two robots crossing the same aisle in opposite
  // directions never share a lane. The centerline is kept only as a crossing connector.
  const laneDirections = new Map<string, 1 | -1>();
  const centerLaneSiblings = new Map<string, { low: number; high: number }>();
  const zKey = (z: number) => z.toFixed(3);

  const addDirectionalAisle = (center: number, width: number) => {
    const lanes = parallelLanePositions(center, width);
    if (lanes.length === 3) {
      laneDirections.set(zKey(lanes[0]), 1);
      laneDirections.set(zKey(lanes[2]), -1);
      centerLaneSiblings.set(zKey(lanes[1]), { low: lanes[0], high: lanes[2] });
    }
    aisleZPositions.push(...lanes);
  };

  for (let pair = 0; pair < pairCount - 1; pair++) {
    const center = ext.rackBlockStartZ + pair * racks.rowPitch + racks.rowPitch / 2;
    addDirectionalAisle(center, racks.aisleWidth);
  }
  addDirectionalAisle(ext.rackBlockStartZ + (pairCount - 1) * racks.rowPitch + racks.rowPitch / 2, racks.aisleWidth);
  addDirectionalAisle(mainAisleZ, racks.mainAisleWidth);
  for (const station of scenario.stations) {
    const approach = stationApproachPosition(station, scenario);
    aisleXPositions.push(approach.x);
    aisleZPositions.push(approach.z);
    // Station approach rows are bidirectional service lanes; never constrain them.
    laneDirections.delete(zKey(approach.z));
    centerLaneSiblings.delete(zKey(approach.z));
  }

  const sortedZ = [...new Set(aisleZPositions)].sort((a, b) => a - b);
  const sortedX = [...new Set(aisleXPositions)].sort((a, b) => a - b);

  for (const x of sortedX) {
    for (const z of sortedZ) {
      if (pointInsideSolid({ x, z }, solids)) continue;
      const id = nodeId(x, z);
      nodes.set(id, { id, position: { x, z }, neighbors: [] });
    }
  }

  for (const x of sortedX) {
    for (let i = 0; i < sortedZ.length - 1; i++) {
      const a = nodes.get(nodeId(x, sortedZ[i]));
      const b = nodes.get(nodeId(x, sortedZ[i + 1]));
      if (a && b && isClearSegment(a.position, b.position, solids)) {
        connectNodes(nodes, a.id, b.id);
      }
    }
  }

  const laneSegmentClear = (x1: number, x2: number, laneZ: number): boolean => {
    const a = nodes.get(nodeId(x1, laneZ));
    const b = nodes.get(nodeId(x2, laneZ));
    return !!a && !!b && isClearSegment(a.position, b.position, solids);
  };

  for (const z of sortedZ) {
    const direction = laneDirections.get(zKey(z));
    const siblings = centerLaneSiblings.get(zKey(z));
    for (let i = 0; i < sortedX.length - 1; i++) {
      const a = nodes.get(nodeId(sortedX[i], z));
      const b = nodes.get(nodeId(sortedX[i + 1], z));
      if (!a || !b || !isClearSegment(a.position, b.position, solids)) continue;
      if (direction === 1) {
        connectNodesDirected(nodes, a.id, b.id);
        continue;
      }
      if (direction === -1) {
        connectNodesDirected(nodes, b.id, a.id);
        continue;
      }
      if (
        siblings &&
        laneSegmentClear(sortedX[i], sortedX[i + 1], siblings.low) &&
        laneSegmentClear(sortedX[i], sortedX[i + 1], siblings.high)
      ) {
        // Both directional side lanes cover this stretch: the centerline only links
        // them vertically and does not act as a third (head-on prone) travel lane.
        continue;
      }
      connectNodes(nodes, a.id, b.id);
    }
  }

  return { nodes, scenario };
}

function nodeId(x: number, z: number): string {
  return `n_${x.toFixed(1)}_${z.toFixed(1)}`;
}

function connectNodes(nodes: Map<string, NavNode>, a: string, b: string) {
  const na = nodes.get(a);
  const nb = nodes.get(b);
  if (na && nb) {
    if (!na.neighbors.includes(b)) na.neighbors.push(b);
    if (!nb.neighbors.includes(a)) nb.neighbors.push(a);
  }
}

/** One-way edge used for directional travel lanes (A* expands neighbors directionally). */
function connectNodesDirected(nodes: Map<string, NavNode>, from: string, to: string) {
  const na = nodes.get(from);
  const nb = nodes.get(to);
  if (na && nb && !na.neighbors.includes(to)) {
    na.neighbors.push(to);
  }
}

export function findNearestNodeId(nodes: Map<string, NavNode>, pos: Vec2, exclude?: string): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const [id, node] of nodes) {
    if (id === exclude) continue;
    const d = Math.hypot(node.position.x - pos.x, node.position.z - pos.z);
    if (d < bestDist) { bestDist = d; best = id; }
  }
  return best;
}

export function aStar(graph: NavGraph, startId: string, goalId: string): Vec2[] {
  const start = graph.nodes.get(startId);
  const goal = graph.nodes.get(goalId);
  if (!start || !goal) return [];

  const openSet = new Set<string>([startId]);
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>();
  const fScore = new Map<string, number>();

  gScore.set(startId, 0);
  fScore.set(startId, heuristic(start.position, goal.position));

  while (openSet.size > 0) {
    let current = "";
    let bestF = Infinity;
    for (const id of openSet) {
      const f = fScore.get(id) ?? Infinity;
      if (f < bestF) { bestF = f; current = id; }
    }
    if (current === goalId) {
      const path: Vec2[] = [];
      let c: string | undefined = current;
      while (c) {
        const node = graph.nodes.get(c)!;
        path.unshift({ ...node.position });
        c = cameFrom.get(c);
      }
      return path;
    }

    openSet.delete(current);
    const currentNode = graph.nodes.get(current)!;
    const currentG = gScore.get(current) ?? Infinity;

    for (const neighborId of currentNode.neighbors) {
      const neighbor = graph.nodes.get(neighborId);
      if (!neighbor) continue;
      const tentativeG = currentG + heuristic(currentNode.position, neighbor.position);
      if (tentativeG < (gScore.get(neighborId) ?? Infinity)) {
        cameFrom.set(neighborId, current);
        gScore.set(neighborId, tentativeG);
        fScore.set(neighborId, tentativeG + heuristic(neighbor.position, goal.position));
        openSet.add(neighborId);
      }
    }
  }

  return [{ ...start.position }, { ...goal.position }];
}

function heuristic(a: Vec2, b: Vec2): number {
  return Math.abs(a.x - b.x) + Math.abs(a.z - b.z);
}

export type AisleDirectionRange = {
  minZ: number;
  maxZ: number;
  direction: AisleLaneDirection;
};

export type CongestionContext = {
  congestionMap: Map<string, number>;
  stationQueueLengths: Record<string, number>;
  yieldBayOccupancy: number;
  routeReservations: Map<string, number>;
  aisleDirections: AisleDirectionRange[];
  /** Positions of robots that will stay put for a while (lifting, queued, charging...). */
  avoidPoints?: Vec2[];
  /** Body envelope around an avoid point that an edge must not cross without penalty. */
  avoidRadius?: number;
};

/**
 * Cost of driving an edge through a robot that is not going to move soon. Large enough
 * that any reasonable detour wins, finite so a route still exists when the stationary
 * robot is unavoidable (the mover then waits behind it as before).
 */
const STATIONARY_ROBOT_PENALTY_METERS = 30;

function edgeCostCongestionAware(from: NavNode, to: NavNode, context: CongestionContext): number {
  const baseDist = heuristic(from.position, to.position);

  const aisleKey = `aisle_${Math.round(to.position.z / 3)}`;
  const congestion = context.congestionMap.get(aisleKey) ?? 0;
  const congestionPenalty = Math.min(congestion * 0.03, 1.2);

  const cellKey = `${Math.round(to.position.x / 0.5)}:${Math.round(to.position.z / 0.5)}`;
  const reservedCount = context.routeReservations.get(cellKey) ?? 0;
  const reservationPenalty = reservedCount * 0.03;

  let stationQueuePenalty = 0;
  for (const queueLen of Object.values(context.stationQueueLengths)) {
    if (queueLen > 2) {
      stationQueuePenalty = Math.max(stationQueuePenalty, (queueLen - 2) * 0.08);
    }
  }

  const yieldPenalty = context.yieldBayOccupancy > 0.6 ? 0.25 : 0;

  let lanePenalty = 0;
  const dx = to.position.x - from.position.x;
  if (Math.abs(dx) > 0.01) {
    for (const aisle of context.aisleDirections) {
      if (to.position.z >= aisle.minZ && to.position.z <= aisle.maxZ) {
        if (aisle.direction === "one-way-forward" && dx < 0) lanePenalty = 8.0;
        if (aisle.direction === "one-way-reverse" && dx > 0) lanePenalty = 8.0;
        break;
      }
    }
  }

  let stationaryPenalty = 0;
  const avoid = context.avoidPoints;
  if (avoid && avoid.length > 0) {
    const r = context.avoidRadius ?? 1.4;
    for (const p of avoid) {
      if (segmentPointDistance(p, from.position, to.position) < r) stationaryPenalty += STATIONARY_ROBOT_PENALTY_METERS;
    }
  }

  return baseDist + congestionPenalty + reservationPenalty + stationQueuePenalty + yieldPenalty + lanePenalty + stationaryPenalty;
}

function segmentPointDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const lenSq = abx * abx + abz * abz;
  if (lenSq <= 1e-9) return Math.hypot(p.x - a.x, p.z - a.z);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / lenSq));
  return Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t));
}

export function aStarCongestionAware(graph: NavGraph, startId: string, goalId: string, contextIn: CongestionContext): Vec2[] {
  const start = graph.nodes.get(startId);
  const goal = graph.nodes.get(goalId);
  if (!start || !goal) return [];
  // A stationary robot at the start (the planner itself, or one it is leaving) or at
  // the goal penalises every candidate route equally, so it is dropped from the cost.
  const context = contextIn.avoidPoints && contextIn.avoidPoints.length > 0
    ? {
      ...contextIn,
      avoidPoints: contextIn.avoidPoints.filter(p =>
        Math.hypot(p.x - start.position.x, p.z - start.position.z) > 1.0 &&
        Math.hypot(p.x - goal.position.x, p.z - goal.position.z) > 1.0),
    }
    : contextIn;

  const openSet = new Set<string>([startId]);
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>();
  const fScore = new Map<string, number>();

  gScore.set(startId, 0);
  fScore.set(startId, heuristic(start.position, goal.position));

  while (openSet.size > 0) {
    let current = "";
    let bestF = Infinity;
    for (const id of openSet) {
      const f = fScore.get(id) ?? Infinity;
      if (f < bestF) { bestF = f; current = id; }
    }
    if (current === goalId) {
      const path: Vec2[] = [];
      let c: string | undefined = current;
      while (c) {
        const node = graph.nodes.get(c)!;
        path.unshift({ ...node.position });
        c = cameFrom.get(c);
      }
      return path;
    }

    openSet.delete(current);
    const currentNode = graph.nodes.get(current)!;
    const currentG = gScore.get(current) ?? Infinity;

    for (const neighborId of currentNode.neighbors) {
      const neighbor = graph.nodes.get(neighborId);
      if (!neighbor) continue;
      const tentativeG = currentG + edgeCostCongestionAware(currentNode, neighbor, context);
      if (tentativeG < (gScore.get(neighborId) ?? Infinity)) {
        cameFrom.set(neighborId, current);
        gScore.set(neighborId, tentativeG);
        fScore.set(neighborId, tentativeG + heuristic(neighbor.position, goal.position));
        openSet.add(neighborId);
      }
    }
  }

  return [{ ...start.position }, { ...goal.position }];
}

type Planner = ((graph: NavGraph, startId: string, goalId: string) => Vec2[]) & { context?: CongestionContext };
const plainPlanner: Planner = (graph, startId, goalId) => aStar(graph, startId, goalId);
const congestionPlanner = (context: CongestionContext): Planner => {
  const planner: Planner = (graph, startId, goalId) => aStarCongestionAware(graph, startId, goalId, context);
  planner.context = context;
  return planner;
};

/** Stationary robots a direct connector must keep clear of (predictive routing only). */
function avoidOf(planner: Planner): AvoidSet | undefined {
  const ctx = planner.context;
  if (!ctx?.avoidPoints || ctx.avoidPoints.length === 0) return undefined;
  return { points: ctx.avoidPoints, radius: ctx.avoidRadius ?? 1.4 };
}

/**
 * Shared route builder: off-graph start -> graph entry node -> A* -> graph exit node ->
 * off-graph target. Entry and exit nodes are the nearest ones a robot BODY can actually
 * reach along an axis-aligned or L-shaped connector (checked with the motion model's
 * obstacle clearance). Joining simply the nearest node used to produce connectors that
 * cut through station bollards or rack corners: the robot then waited at the obstacle
 * forever, and every replan rebuilt the same impassable connector.
 * `exactTarget` = false keeps the old pick behaviour of ending on the aisle node in front
 * of a rack slot (the slot itself lies inside the rack).
 */
export type AvoidSet = { points: Vec2[]; radius: number };

function routeVia(graph: NavGraph, from: Vec2, target: Vec2, planner: Planner, exactTarget: boolean, avoid?: AvoidSet): Vec2[] {
  // Short hop with a body-clear straight/L connector (e.g. depot pocket -> own bay):
  // drive it directly. Via the graph, entry and exit connectors can overlap and turn a
  // 2 m move into a trip up to the nearest aisle node and back down the same column.
  if (exactTarget) {
    const direct = directConnector(graph, from, target, 10, avoidOf(planner) ?? avoid);
    if (direct) return direct;
  }
  const routeStart = dispatchRouteStart(graph, from, target);
  const entry = findReachableNode(graph, routeStart.start);
  const exit = exactTarget ? findReachableNode(graph, target) : undefined;
  const goalId = exit?.id ?? findNearestNodeId(graph.nodes, target);
  if (!entry || !goalId) return exactTarget ? [from, target] : [from];
  const nodePath = planner(graph, entry.id, goalId);
  if (nodePath.length === 0) return exactTarget ? [from, target] : [from];
  const head = appendUniquePoints(routeStart.prefix, [...entry.connector, ...nodePath]);
  if (!exactTarget) return head;
  // exit.connector runs target -> node; drive it in reverse, ending exactly on target.
  const tail = exit ? [...exit.connector].reverse().slice(1).concat([{ ...target }]) : [{ ...target }];
  return appendUniquePoints(head, tail);
}

export function pathToSlot(graph: NavGraph, from: Vec2, slotPos: Vec2): Vec2[] {
  return routeVia(graph, from, slotPos, plainPlanner, false);
}

export function pathToStation(graph: NavGraph, from: Vec2, station: StationConfig, avoid?: AvoidSet): Vec2[] {
  const approach = graph.scenario ? stationApproachPosition(station, graph.scenario) : station.position;
  return routeVia(graph, from, approach, plainPlanner, true, avoid);
}

/** `avoid`: stationary robots a short direct hop must not cut through (all routing modes). */
export function pathToPoint(graph: NavGraph, from: Vec2, target: Vec2, avoid?: AvoidSet): Vec2[] {
  return routeVia(graph, from, target, plainPlanner, true, avoid);
}

export function pathToSlotPredictive(graph: NavGraph, from: Vec2, slotPos: Vec2, context: CongestionContext): Vec2[] {
  return routeVia(graph, from, slotPos, congestionPlanner(context), false);
}

export function pathToStationPredictive(graph: NavGraph, from: Vec2, station: StationConfig, context: CongestionContext): Vec2[] {
  const approach = graph.scenario ? stationApproachPosition(station, graph.scenario) : station.position;
  return routeVia(graph, from, approach, congestionPlanner(context), true);
}

export function pathToPointPredictive(graph: NavGraph, from: Vec2, target: Vec2, context: CongestionContext): Vec2[] {
  return routeVia(graph, from, target, congestionPlanner(context), true);
}

type BodyModel = { solids: SolidRect[]; radius: number };
const bodyModelCache = new WeakMap<NavGraph, BodyModel>();

/** Obstacles exactly as the motion controller checks them (robot disc vs solids). */
function bodyModel(graph: NavGraph): BodyModel | undefined {
  if (!graph.scenario) return undefined;
  let model = bodyModelCache.get(graph);
  if (!model) {
    model = {
      solids: buildSolidObstacles(graph.scenario),
      radius: Math.max(graph.scenario.robots.footprintWidth, graph.scenario.robots.footprintDepth) / 2,
    };
    bodyModelCache.set(graph, model);
  }
  return model;
}

function bodyClearSegment(a: Vec2, b: Vec2, model: BodyModel): boolean {
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(length / 0.25));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    for (const solid of model.solids) {
      const cx = Math.max(solid.minX, Math.min(x, solid.maxX));
      const cz = Math.max(solid.minZ, Math.min(z, solid.maxZ));
      if (Math.hypot(x - cx, z - cz) < model.radius) return false;
    }
  }
  return true;
}

function directConnector(
  graph: NavGraph,
  from: Vec2,
  target: Vec2,
  maxManhattan: number,
  avoid?: { points: Vec2[]; radius: number }
): Vec2[] | undefined {
  const model = bodyModel(graph);
  if (!model) return undefined;
  // A short hop must not drive through a parked or working robot (e.g. cut through a
  // neighbour's depot bay to enter its own bay from the closed side). Robots standing
  // at the start (the mover itself) or on the target are ignored.
  const blockers = (avoid?.points ?? []).filter(p =>
    Math.hypot(p.x - from.x, p.z - from.z) > 0.5 && Math.hypot(p.x - target.x, p.z - target.z) > 0.5);
  const legClear = (a: Vec2, b: Vec2) =>
    bodyClearSegment(a, b, model) && blockers.every(p => segmentPointDistance(p, a, b) >= (avoid?.radius ?? 0));
  if (Math.abs(from.x - target.x) + Math.abs(from.z - target.z) > maxManhattan) return undefined;
  if (Math.hypot(from.x - target.x, from.z - target.z) <= 0.05) return [{ ...from }, { ...target }];
  if (Math.abs(from.x - target.x) < 0.05 || Math.abs(from.z - target.z) < 0.05) {
    return legClear(from, target) ? [{ ...from }, { ...target }] : undefined;
  }
  for (const bend of [{ x: target.x, z: from.z }, { x: from.x, z: target.z }]) {
    if (legClear(from, bend) && legClear(bend, target)) {
      return [{ ...from }, bend, { ...target }];
    }
  }
  return undefined;
}

/**
 * Nearest graph node reachable from `pos` by a body-clear axis-aligned segment or a
 * body-clear L-bend. Returns the connector points (excluding `pos`, ending on the node).
 * Falls back to the plain nearest node when nothing nearby qualifies.
 */
export function findReachableNode(graph: NavGraph, pos: Vec2): { id: string; connector: Vec2[] } | undefined {
  const model = bodyModel(graph);
  const nearest = findNearestNodeId(graph.nodes, pos);
  if (!nearest) return undefined;
  const nearestNode = graph.nodes.get(nearest)!;
  if (!model) return { id: nearest, connector: [{ ...nearestNode.position }] };

  const candidates: { id: string; d: number; node: NavNode }[] = [];
  for (const [id, node] of graph.nodes) {
    const d = Math.abs(node.position.x - pos.x) + Math.abs(node.position.z - pos.z);
    if (d <= 14) candidates.push({ id, d, node });
  }
  candidates.sort((a, b) => a.d - b.d);
  for (const { id, node } of candidates.slice(0, 48)) {
    const p = node.position;
    if (Math.hypot(p.x - pos.x, p.z - pos.z) <= 0.05) return { id, connector: [{ ...p }] };
    const axis = Math.abs(p.x - pos.x) < 0.05 || Math.abs(p.z - pos.z) < 0.05;
    if (axis) {
      if (bodyClearSegment(pos, p, model)) return { id, connector: [{ ...p }] };
      continue;
    }
    for (const bend of [{ x: p.x, z: pos.z }, { x: pos.x, z: p.z }]) {
      if (bodyClearSegment(pos, bend, model) && bodyClearSegment(bend, p, model)) {
        return { id, connector: [bend, { ...p }] };
      }
    }
  }
  // Boxed-in start (e.g. between a station and its bollards): no straight or L-shaped
  // connector exists, but a three-leg one does: step back, side-step, then drive to the
  // node. Tried only when the cheap shapes failed for every candidate.
  for (const { id, node } of candidates.slice(0, 24)) {
    const p = node.position;
    for (const offset of [0.8, -0.8, 1.6, -1.6, 2.4, -2.4]) {
      const viaZ = [{ x: pos.x, z: pos.z + offset }, { x: p.x, z: pos.z + offset }];
      const viaX = [{ x: pos.x + offset, z: pos.z }, { x: pos.x + offset, z: p.z }];
      for (const [m1, m2] of [viaZ, viaX]) {
        if (bodyClearSegment(pos, m1, model) && bodyClearSegment(m1, m2, model) && bodyClearSegment(m2, p, model)) {
          return { id, connector: [m1, m2, { ...p }].filter((q, i, arr) => i === 0 || Math.hypot(q.x - arr[i - 1].x, q.z - arr[i - 1].z) > 0.05) };
        }
      }
    }
  }
  // Nothing provably reachable nearby (e.g. a robot pinned in a corner): keep the old
  // Manhattan connector so it still has a route and the traffic resolvers can act.
  const first = nearestNode.position;
  const connector: Vec2[] = [];
  if (Math.abs(pos.x - first.x) > 0.05 && Math.abs(pos.z - first.z) > 0.05) connector.push(chooseClearBend(graph, pos, first));
  connector.push({ ...first });
  return { id: nearest, connector };
}

/**
 * Launch prefix for routes that leave the front parking band: drive straight out of the
 * depot (+z) before joining the graph, so departing robots do not weave between bays.
 * Routes whose destination is itself inside the band (a robot driving back to its bay)
 * get no prefix: forcing them out of the band first made home-bound robots drive several
 * metres away from their bay and back down the same column, head-on into the robots
 * returning behind them.
 */
function dispatchRouteStart(graph: NavGraph, from: Vec2, target?: Vec2): { start: Vec2; prefix: Vec2[] } {
  const scenario = graph.scenario;
  if (!scenario) return { start: from, prefix: [from] };

  const halfD = scenario.warehouse.depth / 2;
  const parkingBandMaxZ = -halfD + 8.5;
  if (from.z > parkingBandMaxZ) return { start: from, prefix: [from] };
  if (target && target.z <= parkingBandMaxZ) return { start: from, prefix: [from] };

  const solids = buildSolidObstacles(
    scenario,
    Math.max(scenario.robots.footprintWidth, scenario.robots.footprintDepth) / 2 +
      (scenario.simulation.robotClearanceMeters ?? 0.12)
  );
  const ext = computeWarehouseExtents(scenario);
  const candidateZs = [
    Math.min(ext.rackBlockStartZ - scenario.racks.mainAisleWidth * 0.55, -halfD + 13),
    -halfD + 10,
    from.z + Math.max(4, scenario.racks.mainAisleWidth),
  ];

  for (const z of candidateZs) {
    const candidate = { x: from.x, z };
    if (isClearSegment(from, candidate, solids) && !pointInsideSolid(candidate, solids)) {
      return { start: candidate, prefix: appendUniquePoints([from], [candidate]) };
    }
  }

  return { start: from, prefix: [from] };
}

function chooseClearBend(graph: NavGraph, from: Vec2, to: Vec2): Vec2 {
  const xFirst = { x: to.x, z: from.z };
  const zFirst = { x: from.x, z: to.z };
  const solids = graph.scenario
    ? buildSolidObstacles(
      graph.scenario,
      Math.max(graph.scenario.robots.footprintWidth, graph.scenario.robots.footprintDepth) / 2 +
        (graph.scenario.simulation.robotClearanceMeters ?? 0.12)
    )
    : [];
  const xFirstClear = isClearSegment(from, xFirst, solids) && isClearSegment(xFirst, to, solids);
  const zFirstClear = isClearSegment(from, zFirst, solids) && isClearSegment(zFirst, to, solids);
  if (xFirstClear) return xFirst;
  if (zFirstClear) return zFirst;
  return Math.abs(from.x - to.x) > Math.abs(from.z - to.z) ? zFirst : xFirst;
}

function appendUniquePoints(base: Vec2[], extra: Vec2[]): Vec2[] {
  const result = [...base];
  for (const point of extra) {
    const last = result[result.length - 1];
    if (!last || Math.hypot(last.x - point.x, last.z - point.z) > 0.05) {
      result.push({ ...point });
    }
  }
  return result;
}

function parallelLanePositions(center: number, width: number): number[] {
  // Push the two opposing travel lanes as far apart as the aisle safely allows.
  const safeEdgeMargin = Math.max(0.45, width * 0.16);
  const maxOffset = Math.max(0.55, width / 2 - safeEdgeMargin);
  const offset = Math.min(Math.max(width * 0.34, 0.8), maxOffset, 1.75);

  // Keep the centerline as an internal connector so dense layouts do not
  // deadlock, but render the public lane overlay as separated corridors.
  return [center - offset, center, center + offset];
}
