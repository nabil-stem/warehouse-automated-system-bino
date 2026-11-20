import type { StationConfig, WarehouseScenario, Slot, Vec2, Vec3 } from "./schema";

function seededRandom(seed: number) {
  let s = Math.max(1, Math.floor(seed) || 1);
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export function generateSlots(scenario: WarehouseScenario): Slot[] {
  const { racks, boxes, inventory } = scenario;
  const rand = seededRandom(scenario.seed);
  const slots: Slot[] = [];

  const ext = computeWarehouseExtents(scenario);
  const rackBlockStartX = ext.rackBlockStartX;
  const rackBlockStartZ = ext.rackBlockStartZ;

  for (let row = 0; row < racks.rowCount; row++) {
    const pairIndex = Math.floor(row / 2);
    const side: -1 | 1 = row % 2 === 0 ? -1 : 1;
    const z = rackBlockStartZ + pairIndex * racks.rowPitch + side * (racks.shelfDepth / 2 + 0.1);

    const rowRule = inventory.rowRules.find(r => r.rowIndex === row);
    const fillRate = clamp01(rowRule?.fillRate ?? boxes.defaultFillRate);
    const emptyLimit = clamp01(1 - inventory.emptySlotPercentage / 100);
    const effectiveFillRate = Math.min(fillRate, emptyLimit);
    const boxesPerBay = rowRule?.boxesPerBay !== undefined
      ? Math.max(0, Math.min(racks.levels, Math.round(rowRule.boxesPerBay)))
      : undefined;
    const skuFamilies = normalizeFamilies(rowRule?.skuFamilies ?? inventory.skuFamilies);

    for (let bay = 0; bay < racks.baysPerRow; bay++) {
      const x = rackBayCenterX(scenario, bay, rackBlockStartX);

      for (let level = 0; level < racks.levels; level++) {
        const y = racks.bottomShelfHeight + level * racks.levelHeight;
        const slotId = `R${String(row + 1).padStart(2, "0")}-B${String(bay + 1).padStart(2, "0")}-L${level + 1}`;

        const levelAllowed = boxesPerBay === undefined || level < boxesPerBay;
        const occupied = levelAllowed && rand() < effectiveFillRate;

        let sku: string | undefined;
        if (occupied) {
          sku = skuFamilies[Math.floor(rand() * skuFamilies.length)];
        }

        const isHot = occupied && rand() < inventory.hotSkuPercentage / 100;
        const demandScore = isHot ? 7 + Math.floor(rand() * 4) : 1 + Math.floor(rand() * 5);

        const position: Vec3 = { x, y, z };
        slots.push({
          id: slotId,
          rowIndex: row,
          bayIndex: bay,
          levelIndex: level,
          side,
          position,
          sku,
          occupied,
          demandScore,
        });
      }
    }
  }

  return slots;
}

export function computeWarehouseExtents(scenario: WarehouseScenario) {
  const { racks } = scenario;
  const rackBlockWidth = racks.baysPerRow * racks.bayWidth + crossAisleCount(scenario) * racks.crossAisleWidth;
  const rackBlockDepth = (Math.ceil(racks.rowCount / 2)) * racks.rowPitch;
  return {
    rackBlockWidth,
    rackBlockDepth,
    rackBlockStartX: -rackBlockWidth / 2,
    rackBlockStartZ: -rackBlockDepth / 2,
    mainAisleZ: -rackBlockDepth / 2 - racks.mainAisleWidth / 2 - 1,
  };
}

export type RequiredWarehouseDimensions = {
  width: number;
  depth: number;
  sideMargin: number;
  endMargin: number;
};

export type ScenarioGeometryAdjustment = {
  warehouseResized: boolean;
  stationsMoved: string[];
  requiredWidth: number;
  requiredDepth: number;
  width: number;
  depth: number;
};

export function requiredWarehouseDimensions(scenario: WarehouseScenario): RequiredWarehouseDimensions {
  const ext = computeWarehouseExtents(scenario);
  const grid = validGridSize(scenario.warehouse.gridSpacing);
  const sideMargin = Math.max(
    14,
    scenario.racks.aisleWidth + scenario.racks.mainAisleWidth + 4,
    scenario.robots.footprintWidth * 9
  );
  const endMargin = Math.max(
    14,
    scenario.racks.mainAisleWidth + scenario.robots.footprintDepth * 6,
    scenario.racks.aisleWidth + scenario.robots.footprintDepth * 7
  );

  return {
    width: roundUpToGrid(ext.rackBlockWidth + sideMargin * 2, grid),
    depth: roundUpToGrid(ext.rackBlockDepth + endMargin * 2, grid),
    sideMargin,
    endMargin,
  };
}

export function normalizeScenarioGeometry(scenario: WarehouseScenario): ScenarioGeometryAdjustment {
  const required = requiredWarehouseDimensions(scenario);
  const originalWidth = scenario.warehouse.width;
  const originalDepth = scenario.warehouse.depth;

  if (scenario.warehouse.width < required.width) {
    scenario.warehouse.width = required.width;
  }
  if (scenario.warehouse.depth < required.depth) {
    scenario.warehouse.depth = required.depth;
  }

  const ext = computeWarehouseExtents(scenario);
  const stationsMoved = relocateConflictingStations(scenario, ext);

  return {
    warehouseResized: scenario.warehouse.width !== originalWidth || scenario.warehouse.depth !== originalDepth,
    stationsMoved,
    requiredWidth: required.width,
    requiredDepth: required.depth,
    width: scenario.warehouse.width,
    depth: scenario.warehouse.depth,
  };
}

export function crossAisleCount(scenario: WarehouseScenario): number {
  const { racks } = scenario;
  const every = Math.max(0, Math.floor(racks.crossAisleEveryBays));
  if (every <= 0) return 0;
  return Math.max(0, Math.floor((racks.baysPerRow - 1) / every));
}

export function crossAisleBeforeBay(scenario: WarehouseScenario, bayIndex: number): number {
  const every = Math.max(0, Math.floor(scenario.racks.crossAisleEveryBays));
  if (every <= 0 || bayIndex <= 0) return 0;
  return Math.floor(bayIndex / every);
}

export function rackBayCenterX(scenario: WarehouseScenario, bayIndex: number, startX = computeWarehouseExtents(scenario).rackBlockStartX): number {
  const { racks } = scenario;
  return startX + bayIndex * racks.bayWidth + crossAisleBeforeBay(scenario, bayIndex) * racks.crossAisleWidth + racks.bayWidth / 2;
}

export function rackBayBoundaryX(scenario: WarehouseScenario, bayBoundaryIndex: number, startX = computeWarehouseExtents(scenario).rackBlockStartX): number {
  const { racks } = scenario;
  return startX + bayBoundaryIndex * racks.bayWidth + crossAisleBeforeBay(scenario, bayBoundaryIndex) * racks.crossAisleWidth;
}

export function findSlot(slots: Slot[], id: string): Slot | undefined {
  return slots.find(s => s.id === id);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeFamilies(families: string[]): string[] {
  const normalized = families.map(s => s.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : ["SKU"];
}

function relocateConflictingStations(
  scenario: WarehouseScenario,
  ext: ReturnType<typeof computeWarehouseExtents>
): string[] {
  const moved: string[] = [];
  const totals = countStationsByType(scenario.stations);
  const seen = new Map<StationConfig["type"], number>();

  for (const station of scenario.stations) {
    const index = seen.get(station.type) ?? 0;
    seen.set(station.type, index + 1);
    if (!stationNeedsReposition(station, scenario, ext)) continue;

    station.position = stationTargetPosition(station, scenario, ext, index, totals.get(station.type) ?? 1);
    moved.push(station.label);
  }

  return moved;
}

function countStationsByType(stations: StationConfig[]): Map<StationConfig["type"], number> {
  const totals = new Map<StationConfig["type"], number>();
  for (const station of stations) {
    totals.set(station.type, (totals.get(station.type) ?? 0) + 1);
  }
  return totals;
}

function stationNeedsReposition(
  station: StationConfig,
  scenario: WarehouseScenario,
  ext: ReturnType<typeof computeWarehouseExtents>
): boolean {
  const halfW = scenario.warehouse.width / 2;
  const halfD = scenario.warehouse.depth / 2;
  const wallClearance = Math.max(1.5, scenario.robots.footprintWidth);
  const stationRect = stationBounds(station);
  const outsideWarehouse =
    stationRect.minX < -halfW + wallClearance ||
    stationRect.maxX > halfW - wallClearance ||
    stationRect.minZ < -halfD + wallClearance ||
    stationRect.maxZ > halfD - wallClearance;

  const rackClearance = Math.max(1.2, scenario.robots.footprintWidth);
  const rackRect = {
    minX: ext.rackBlockStartX - rackClearance,
    maxX: ext.rackBlockStartX + ext.rackBlockWidth + rackClearance,
    minZ: ext.rackBlockStartZ - rackClearance,
    maxZ: ext.rackBlockStartZ + ext.rackBlockDepth + rackClearance,
  };

  return outsideWarehouse || rectsOverlap(stationRect, rackRect);
}

function stationTargetPosition(
  station: StationConfig,
  scenario: WarehouseScenario,
  ext: ReturnType<typeof computeWarehouseExtents>,
  index: number,
  total: number
): Vec2 {
  const halfW = scenario.warehouse.width / 2;
  const halfD = scenario.warehouse.depth / 2;
  const safeSide = Math.max(2, scenario.robots.footprintWidth * 2);
  const safeMinX = -halfW + station.width / 2 + safeSide;
  const safeMaxX = halfW - station.width / 2 - safeSide;
  const safeMinZ = -halfD + station.depth / 2 + safeSide;
  const safeMaxZ = halfD - station.depth / 2 - safeSide;
  const frontZ = clamp(
    ext.rackBlockStartZ - scenario.racks.mainAisleWidth - station.depth / 2 - 4,
    safeMinZ,
    ext.rackBlockStartZ - station.depth / 2 - 2
  );
  const rearZ = clamp(
    ext.rackBlockStartZ + ext.rackBlockDepth + station.depth / 2 + 5,
    ext.rackBlockStartZ + ext.rackBlockDepth + station.depth / 2 + 2,
    safeMaxZ
  );

  if (station.type === "packing") {
    const span = Math.min(ext.rackBlockWidth * 0.8, Math.max(0, scenario.warehouse.width - station.width - safeSide * 4));
    return {
      x: clamp(distributedX(index, total, span), safeMinX, safeMaxX),
      z: frontZ,
    };
  }

  if (station.type === "inbound") {
    const span = Math.min(ext.rackBlockWidth * 0.45, Math.max(0, scenario.warehouse.width - station.width - safeSide * 4));
    return {
      x: clamp(distributedX(index, total, span), safeMinX, safeMaxX),
      z: rearZ,
    };
  }

  if (station.type === "charging") {
    const step = station.width + safeSide + 2;
    return {
      x: clamp(safeMinX + index * step + station.width * 0.5, safeMinX, safeMaxX),
      z: frontZ,
    };
  }

  const step = station.width + safeSide + 2;
  return {
    x: clamp(safeMaxX - index * step - station.width * 0.5, safeMinX, safeMaxX),
    z: frontZ,
  };
}

function stationBounds(station: StationConfig) {
  return {
    minX: station.position.x - station.width / 2,
    maxX: station.position.x + station.width / 2,
    minZ: station.position.z - station.depth / 2,
    maxZ: station.position.z + station.depth / 2,
  };
}

function rectsOverlap(
  a: { minX: number; maxX: number; minZ: number; maxZ: number },
  b: { minX: number; maxX: number; minZ: number; maxZ: number }
): boolean {
  return Math.max(a.minX, b.minX) < Math.min(a.maxX, b.maxX) &&
    Math.max(a.minZ, b.minZ) < Math.min(a.maxZ, b.maxZ);
}

function distributedX(index: number, total: number, span: number): number {
  if (total <= 1 || span <= 0) return 0;
  return -span / 2 + (span * index) / (total - 1);
}

function roundUpToGrid(value: number, grid: number): number {
  return Math.ceil(value / grid) * grid;
}

function validGridSize(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function clamp(value: number, min: number, max: number): number {
  if (min > max) return (min + max) / 2;
  return Math.max(min, Math.min(max, value));
}
