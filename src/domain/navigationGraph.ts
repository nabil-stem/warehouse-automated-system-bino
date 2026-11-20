import type { NavGraph, NavNode, Vec2, WarehouseScenario, StationConfig, AisleLaneDirection } from "./schema";
import { computeWarehouseExtents, rackBayBoundaryX } from "./warehouseGenerator";
import { buildSolidObstacles, isClearSegment, pointInsideSolid, stationApproachPosition } from "./obstacles";

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
};

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

  return baseDist + congestionPenalty + reservationPenalty + stationQueuePenalty + yieldPenalty + lanePenalty;
}

export function aStarCongestionAware(graph: NavGraph, startId: string, goalId: string, context: CongestionContext): Vec2[] {
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

export function pathToSlot(graph: NavGraph, from: Vec2, slotPos: Vec2): Vec2[] {
  const routeStart = dispatchRouteStart(graph, from);
  const startId = findNearestNodeId(graph.nodes, routeStart.start);
  const goalId = findNearestNodeId(graph.nodes, slotPos);
  if (!startId || !goalId) return [from, slotPos];
  const path = aStar(graph, startId, goalId);
  if (path.length === 0) return [from];
  return appendUniquePoints(routeStart.prefix, withManhattanEndpoint(graph, routeStart.start, path));
}

export function pathToStation(graph: NavGraph, from: Vec2, station: StationConfig): Vec2[] {
  const routeStart = dispatchRouteStart(graph, from);
  const startId = findNearestNodeId(graph.nodes, routeStart.start);
  const approach = graph.scenario ? stationApproachPosition(station, graph.scenario) : station.position;
  const goalId = findNearestNodeId(graph.nodes, approach);
  if (!startId || !goalId) return [from, approach];
  const path = aStar(graph, startId, goalId);
  if (path.length === 0) return [from, approach];
  return appendManhattanEndpoint(graph, appendUniquePoints(routeStart.prefix, withManhattanEndpoint(graph, routeStart.start, path)), approach);
}

export function pathToPoint(graph: NavGraph, from: Vec2, target: Vec2): Vec2[] {
  const routeStart = dispatchRouteStart(graph, from);
  const startId = findNearestNodeId(graph.nodes, routeStart.start);
  const goalId = findNearestNodeId(graph.nodes, target);
  if (!startId || !goalId) return [from, target];
  const path = aStar(graph, startId, goalId);
  if (path.length === 0) return [from, target];
  return appendManhattanEndpoint(graph, appendUniquePoints(routeStart.prefix, withManhattanEndpoint(graph, routeStart.start, path)), target);
}

export function pathToSlotPredictive(graph: NavGraph, from: Vec2, slotPos: Vec2, context: CongestionContext): Vec2[] {
  const routeStart = dispatchRouteStart(graph, from);
  const startId = findNearestNodeId(graph.nodes, routeStart.start);
  const goalId = findNearestNodeId(graph.nodes, slotPos);
  if (!startId || !goalId) return [from, slotPos];
  const path = aStarCongestionAware(graph, startId, goalId, context);
  if (path.length === 0) return [from];
  return appendUniquePoints(routeStart.prefix, withManhattanEndpoint(graph, routeStart.start, path));
}

export function pathToStationPredictive(graph: NavGraph, from: Vec2, station: StationConfig, context: CongestionContext): Vec2[] {
  const routeStart = dispatchRouteStart(graph, from);
  const startId = findNearestNodeId(graph.nodes, routeStart.start);
  const approach = graph.scenario ? stationApproachPosition(station, graph.scenario) : station.position;
  const goalId = findNearestNodeId(graph.nodes, approach);
  if (!startId || !goalId) return [from, approach];
  const path = aStarCongestionAware(graph, startId, goalId, context);
  if (path.length === 0) return [from, approach];
  return appendManhattanEndpoint(graph, appendUniquePoints(routeStart.prefix, withManhattanEndpoint(graph, routeStart.start, path)), approach);
}

export function pathToPointPredictive(graph: NavGraph, from: Vec2, target: Vec2, context: CongestionContext): Vec2[] {
  const routeStart = dispatchRouteStart(graph, from);
  const startId = findNearestNodeId(graph.nodes, routeStart.start);
  const goalId = findNearestNodeId(graph.nodes, target);
  if (!startId || !goalId) return [from, target];
  const path = aStarCongestionAware(graph, startId, goalId, context);
  if (path.length === 0) return [from, target];
  return appendManhattanEndpoint(graph, appendUniquePoints(routeStart.prefix, withManhattanEndpoint(graph, routeStart.start, path)), target);
}

function dispatchRouteStart(graph: NavGraph, from: Vec2): { start: Vec2; prefix: Vec2[] } {
  const scenario = graph.scenario;
  if (!scenario) return { start: from, prefix: [from] };

  const halfD = scenario.warehouse.depth / 2;
  const parkingBandMaxZ = -halfD + 8.5;
  if (from.z > parkingBandMaxZ) return { start: from, prefix: [from] };

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

function withManhattanEndpoint(graph: NavGraph, from: Vec2, path: Vec2[]): Vec2[] {
  if (path.length === 0) return [from];
  const first = path[0];
  const result: Vec2[] = [{ ...from }];
  if (Math.abs(from.x - first.x) > 0.05 && Math.abs(from.z - first.z) > 0.05) {
    result.push(chooseClearBend(graph, from, first));
  }
  return appendUniquePoints(result, path);
}

function appendManhattanEndpoint(graph: NavGraph, path: Vec2[], target: Vec2): Vec2[] {
  if (path.length === 0) return [{ ...target }];
  const last = path[path.length - 1];
  const extension: Vec2[] = [];
  if (Math.abs(last.x - target.x) > 0.05 && Math.abs(last.z - target.z) > 0.05) {
    extension.push(chooseClearBend(graph, last, target));
  }
  extension.push({ ...target });
  return appendUniquePoints(path, extension);
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
