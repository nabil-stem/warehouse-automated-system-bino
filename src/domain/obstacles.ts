import type { StationConfig, Vec2, WarehouseScenario } from "./schema";
import { computeWarehouseExtents, rackBayBoundaryX } from "./warehouseGenerator";

export type SolidRect = {
  id: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

export function buildSolidObstacles(
  scenario: WarehouseScenario,
  clearance = 0.12
): SolidRect[] {
  return [
    ...buildRackSolids(scenario, clearance),
    ...buildStationSolids(scenario, clearance),
    ...buildColumnSolids(scenario, clearance),
    ...buildBollardSolids(scenario, clearance),
    ...buildDockSolids(scenario, clearance),
  ];
}

export function stationApproachPosition(station: StationConfig, scenario: WarehouseScenario): Vec2 {
  const margin = robotRadius(scenario) + (scenario.simulation.robotClearanceMeters ?? 0.12) + 0.5;
  const candidates: Vec2[] = [
    { x: station.position.x, z: station.position.z - station.depth / 2 - margin },
    { x: station.position.x, z: station.position.z + station.depth / 2 + margin },
    { x: station.position.x - station.width / 2 - margin, z: station.position.z },
    { x: station.position.x + station.width / 2 + margin, z: station.position.z },
  ];
  const halfW = scenario.warehouse.width / 2;
  const halfD = scenario.warehouse.depth / 2;
  const solids = buildSolidObstacles(scenario, robotRadius(scenario) * 0.25);

  return candidates
    .filter(pos => pos.x > -halfW && pos.x < halfW && pos.z > -halfD && pos.z < halfD)
    .filter(pos => !pointInsideSolid(pos, solids))
    .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0] ?? candidates[0];
}

export function pointInsideSolid(point: Vec2, solids: SolidRect[]): boolean {
  return solids.some(solid =>
    point.x > solid.minX && point.x < solid.maxX &&
    point.z > solid.minZ && point.z < solid.maxZ
  );
}

export function isClearSegment(a: Vec2, b: Vec2, solids: SolidRect[]): boolean {
  if (Math.abs(a.x - b.x) < 0.05) {
    const x = a.x;
    const minZ = Math.min(a.z, b.z);
    const maxZ = Math.max(a.z, b.z);
    return !solids.some(solid => x > solid.minX && x < solid.maxX && rangesOverlap(minZ, maxZ, solid.minZ, solid.maxZ));
  }
  if (Math.abs(a.z - b.z) < 0.05) {
    const z = a.z;
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    return !solids.some(solid => z > solid.minZ && z < solid.maxZ && rangesOverlap(minX, maxX, solid.minX, solid.maxX));
  }
  return false;
}

export function robotRadius(scenario: WarehouseScenario): number {
  return Math.max(scenario.robots.footprintWidth, scenario.robots.footprintDepth) / 2;
}

function buildRackSolids(scenario: WarehouseScenario, clearance: number): SolidRect[] {
  const solids: SolidRect[] = [];
  const ext = computeWarehouseExtents(scenario);
  const { racks } = scenario;
  const segments = getRackSegments(scenario);

  for (let row = 0; row < racks.rowCount; row++) {
    const pairIndex = Math.floor(row / 2);
    const side = row % 2 === 0 ? -1 : 1;
    const z = ext.rackBlockStartZ + pairIndex * racks.rowPitch + side * (racks.shelfDepth / 2 + 0.1);
    for (const segment of segments) {
      const x1 = rackBayBoundaryX(scenario, segment.start, ext.rackBlockStartX);
      const x2 = rackBayBoundaryX(scenario, segment.end, ext.rackBlockStartX);
      solids.push({
        id: `rack-${row}-${segment.start}`,
        minX: x1 - clearance,
        maxX: x2 + clearance,
        minZ: z - racks.shelfDepth / 2 - clearance,
        maxZ: z + racks.shelfDepth / 2 + clearance,
      });
    }
  }

  return solids;
}

function buildStationSolids(scenario: WarehouseScenario, clearance: number): SolidRect[] {
  return scenario.stations.map(station => ({
    id: `station-${station.id}`,
    minX: station.position.x - station.width / 2 - clearance,
    maxX: station.position.x + station.width / 2 + clearance,
    minZ: station.position.z - station.depth / 2 - clearance,
    maxZ: station.position.z + station.depth / 2 + clearance,
  }));
}

function buildColumnSolids(scenario: WarehouseScenario, clearance: number): SolidRect[] {
  if (!scenario.visual.showSupportColumns) return [];
  const solids: SolidRect[] = [];
  const halfW = scenario.warehouse.width / 2;
  const halfD = scenario.warehouse.depth / 2;
  const spacing = 16;
  const radius = 0.35 + clearance;

  for (let x = -halfW + spacing; x < halfW; x += spacing) {
    for (let z = -halfD + spacing; z < halfD; z += spacing) {
      solids.push({
        id: `column-${x.toFixed(1)}-${z.toFixed(1)}`,
        minX: x - radius,
        maxX: x + radius,
        minZ: z - radius,
        maxZ: z + radius,
      });
    }
  }

  return solids;
}

function buildBollardSolids(scenario: WarehouseScenario, clearance: number): SolidRect[] {
  if (!scenario.visual.showSafetyBollards) return [];
  const solids: SolidRect[] = [];
  const ext = computeWarehouseExtents(scenario);
  const { racks } = scenario;
  const rackLength = racks.baysPerRow * racks.bayWidth;
  const startX = -rackLength / 2;
  const endX = rackLength / 2;
  const radius = 0.18 + clearance;

  for (let pair = 0; pair < Math.ceil(racks.rowCount / 2); pair++) {
    const z = ext.rackBlockStartZ + pair * racks.rowPitch;
    for (const x of [startX - 0.5, endX + 0.5]) {
      solids.push(rectAround(`bollard-rack-${pair}-${x}`, x, z, radius));
    }
  }

  for (const station of scenario.stations) {
    for (const pos of [
      { x: station.position.x - station.width / 2 - 0.5, z: station.position.z - station.depth / 2 - 0.5 },
      { x: station.position.x + station.width / 2 + 0.5, z: station.position.z - station.depth / 2 - 0.5 },
    ]) {
      solids.push(rectAround(`bollard-station-${station.id}-${pos.x}`, pos.x, pos.z, radius));
    }
  }

  return solids;
}

function buildDockSolids(scenario: WarehouseScenario, clearance: number): SolidRect[] {
  if (!scenario.visual.showDockDoors) return [];
  const halfW = scenario.warehouse.width / 2;
  const halfD = scenario.warehouse.depth / 2;
  const doorCount = Math.max(2, Math.floor(scenario.warehouse.width / 20));
  const spacing = scenario.warehouse.width / (doorCount + 1);

  return Array.from({ length: doorCount }, (_, i) => {
    const x = -halfW + spacing * (i + 1);
    const z = halfD + 0.6;
    return {
      id: `dock-bumper-${i}`,
      minX: x - 1.75 - clearance,
      maxX: x + 1.75 + clearance,
      minZ: z - 0.75 - clearance,
      maxZ: z + 0.75 + clearance,
    };
  });
}

function rectAround(id: string, x: number, z: number, radius: number): SolidRect {
  return { id, minX: x - radius, maxX: x + radius, minZ: z - radius, maxZ: z + radius };
}

function getRackSegments(scenario: WarehouseScenario): Array<{ start: number; end: number }> {
  const { racks } = scenario;
  const every = Math.max(0, Math.floor(racks.crossAisleEveryBays));
  if (every <= 0 || every >= racks.baysPerRow) return [{ start: 0, end: racks.baysPerRow }];
  const segments: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < racks.baysPerRow; start += every) {
    segments.push({ start, end: Math.min(start + every, racks.baysPerRow) });
  }
  return segments;
}

function rangesOverlap(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  return Math.max(aMin, bMin) < Math.min(aMax, bMax);
}
