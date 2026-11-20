import type { WarehouseScenario, Slot, Mission, RobotRuntime } from "../domain/schema";
import { computeWarehouseExtents } from "../domain/warehouseGenerator";

const STORAGE_KEY = "warehouse-swarm-sim-scenarios";

export type SavedScenarioEntry = {
  name: string;
  savedAt: string;
  data: string;
};

export function saveScenarioToStorage(scenario: WarehouseScenario, slots: Slot[], missions: Mission[]) {
  const entries = loadScenarioList();
  const payload = JSON.stringify({ version: 1, scenario, slots, missions });
  const entry: SavedScenarioEntry = {
    name: scenario.name,
    savedAt: new Date().toISOString(),
    data: payload,
  };
  const existing = entries.findIndex(e => e.name === scenario.name);
  if (existing >= 0) entries[existing] = entry;
  else entries.push(entry);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

export function loadScenarioList(): SavedScenarioEntry[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

export function loadScenarioFromStorage(name: string): { scenario: WarehouseScenario; slots?: Slot[]; missions?: Mission[] } | null {
  const entries = loadScenarioList();
  const entry = entries.find(e => e.name === name);
  if (!entry) return null;
  try {
    const parsed = JSON.parse(entry.data);
    return { scenario: parsed.scenario, slots: parsed.slots, missions: parsed.missions };
  } catch { return null; }
}

export function deleteScenarioFromStorage(name: string) {
  const entries = loadScenarioList().filter(e => e.name !== name);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

export function downloadJSON(data: object, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  downloadBlob(blob, filename);
}

export function downloadCSV(csv: string, filename: string) {
  const blob = new Blob([csv], { type: "text/csv" });
  downloadBlob(blob, filename);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function slotsToCSV(slots: Slot[]): string {
  const header = "slotId,row,bay,level,side,x,y,z,sku,occupied,demandScore";
  const rows = slots.map(s =>
    `${s.id},${s.rowIndex},${s.bayIndex},${s.levelIndex},${s.side === -1 ? "left" : "right"},${s.position.x.toFixed(2)},${s.position.y.toFixed(2)},${s.position.z.toFixed(2)},${s.sku ?? ""},${s.occupied},${s.demandScore}`
  );
  return [header, ...rows].join("\n");
}

export function missionsToCSV(missions: Mission[]): string {
  const header = "missionId,sku,sourceSlotId,targetStationId,robotId,status,createdAtTick,completedAtTick,distanceMeters,waitTicks";
  const rows = missions.map(m =>
    `${m.id},${m.sku},${m.sourceSlotId},${m.targetStationId},${m.assignedRobotId ?? ""},${m.status},${m.createdAtTick},${m.completedAtTick ?? ""},${m.distanceMeters.toFixed(2)},${m.waitTicks}`
  );
  return [header, ...rows].join("\n");
}

export function generateTextToCADPrompt(scenario: WarehouseScenario): string {
  const { warehouse, racks, boxes, robots, stations, inventory, simulation, visual } = scenario;
  return `# Warehouse 3D CAD Generation Prompt

Create a CAD-grade and simulation-ready 3D warehouse digital twin from these exact app parameters.

## Floor
- Dimensions: ${warehouse.width}m x ${warehouse.depth}m
- Floor thickness: ${warehouse.floorThickness}m
- Wall height: ${warehouse.wallHeight}m (${warehouse.showWalls ? "visible" : "hidden"})
- Navigation grid spacing: ${warehouse.gridSpacing}m

## Rack Layout
- ${racks.rowCount} rack rows, ${racks.baysPerRow} bays per row, ${racks.levels} levels
- Bay width: ${racks.bayWidth}m, Shelf depth: ${racks.shelfDepth}m
- Level height: ${racks.levelHeight}m, Bottom shelf: ${racks.bottomShelfHeight}m
- Row pitch: ${racks.rowPitch}m, Aisle width: ${racks.aisleWidth}m
- Main aisle width: ${racks.mainAisleWidth}m
- Upright: ${racks.uprightThickness}m, Beam: ${racks.rackBeamThickness}m
- Build each rack row as a modular object with low-poly collision boxes and visible grey metal beams.
- Rack visual style: ${visual.rackStyle}
- Rack bracing: ${visual.showRackBracing ? "yes" : "no"}

## Boxes
- Size: ${boxes.width}m x ${boxes.height}m x ${boxes.depth}m
- Default fill rate: ${(boxes.defaultFillRate * 100).toFixed(0)}%
- Box visual style: ${visual.boxStyle}
- Bin/tote front faces: ${visual.showBinFaces ? "yes" : "no"}
- Empty slot target: ${inventory.emptySlotPercentage}%
- Hot SKU target: ${inventory.hotSkuPercentage}%
- SKU families: ${inventory.skuFamilies.join(", ")}
- Row rules: ${inventory.rowRules.length > 0 ? inventory.rowRules.map(r => `row ${r.rowIndex + 1}: fill ${(r.fillRate * 100).toFixed(0)}%, boxes/bay ${r.boxesPerBay ?? "auto"}, SKUs ${(r.skuFamilies ?? inventory.skuFamilies).join("|")}`).join("; ") : "none"}

## Robots
- Count: ${robots.count}
- Speed: ${robots.speedMetersPerSecond} m/s
- Footprint: ${robots.footprintWidth}m x ${robots.footprintDepth}m
- Body height: ${robots.bodyHeight}m, Lift max: ${robots.liftMaxHeight}m
- Custom model: ${robots.useCustomModel ? "yes" : "no (procedural)"}
- If no custom robot model is supplied, use a compact black mobile lift robot with colored lift module, fork/prongs, sensor cylinder, number label, and carried box.

## Stations
${stations.map(s => `- ${s.label} (${s.type}): position (${s.position.x}, ${s.position.z}), size ${s.width}x${s.depth}m`).join("\n")}

## Simulation Overlay
- Routing mode: ${simulation.routing}
- Mission allocator: ${simulation.allocator}
- Collision avoidance: ${simulation.collisionAvoidance ? "enabled" : "disabled"}
- Active mission limit: ${simulation.maxActiveMissions}${simulation.autoScaleActiveMissions ? " with queue-based auto-ramp" : ""}
- Show route lines: ${simulation.showRoutes ? "yes" : "no"}
- Show heatmap: ${simulation.showHeatmap ? "yes" : "no"}
- Polished floor: ${visual.polishedFloor ? "yes" : "no"}
- Hazard lane markings: ${visual.showHazardLanes ? "yes" : "no"}
- Overhead beams/lights: ${visual.showOverheadStructure ? "yes" : "no"}

## Export Targets
- GLB (Three.js compatible)
- STEP (CAD interchange)
- SDF/URDF (simulation)
- Keep collision meshes simple: boxes for floor/racks/stations/boxes, cylinders/boxes for robots.

Generated from scenario "${scenario.name}" on ${new Date().toISOString().split("T")[0]}.
`;
}

export function generateSDFWorld(scenario: WarehouseScenario, slots: Slot[], robots: RobotRuntime[]): string {
  const ext = computeWarehouseExtents(scenario);
  const rackHeight = scenario.racks.bottomShelfHeight + (scenario.racks.levels - 1) * scenario.racks.levelHeight + scenario.boxes.height;
  const occupiedSlots = slots.filter(s => s.occupied);
  const modelName = sanitizeName(scenario.name);
  const rackModels = Array.from({ length: scenario.racks.rowCount }).map((_, row) => {
    const pair = Math.floor(row / 2);
    const side = row % 2 === 0 ? -1 : 1;
    const z = ext.rackBlockStartZ + pair * scenario.racks.rowPitch + side * (scenario.racks.shelfDepth / 2 + 0.1);
    return sdfBox(
      `rack_row_${row + 1}`,
      { x: 0, y: rackHeight / 2, z },
      { x: ext.rackBlockWidth, y: rackHeight, z: scenario.racks.shelfDepth },
      "0.55 0.62 0.68 1"
    );
  }).join("\n");

  const boxModels = occupiedSlots.slice(0, 1000).map(slot => sdfBox(
    `box_${slot.id.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`,
    {
      x: slot.position.x,
      y: slot.position.y + scenario.boxes.height / 2,
      z: slot.position.z,
    },
    { x: scenario.boxes.width, y: scenario.boxes.height, z: scenario.boxes.depth },
    "0.72 0.49 0.24 1"
  )).join("\n");

  const stationModels = scenario.stations.map(station => sdfBox(
    `station_${sanitizeName(station.id)}`,
    { x: station.position.x, y: 0.15, z: station.position.z },
    { x: station.width, y: 0.3, z: station.depth },
    station.type === "packing" ? "0.12 0.55 0.47 1" : station.type === "charging" ? "0.90 0.76 0.18 1" : "0.16 0.34 0.64 1"
  )).join("\n");

  const robotModels = robots.map(robot => sdfBox(
    `robot_${robot.id}`,
    { x: robot.position.x, y: scenario.robots.bodyHeight / 2, z: robot.position.z },
    { x: scenario.robots.footprintWidth, y: scenario.robots.bodyHeight, z: scenario.robots.footprintDepth },
    "0.02 0.03 0.04 1"
  )).join("\n");

  return `<?xml version="1.0" ?>
<sdf version="1.9">
  <world name="${modelName}">
    <gravity>0 0 -9.81</gravity>
    <model name="floor">
      <static>true</static>
      <link name="floor_link">
        <collision name="floor_collision">
          <geometry><box><size>${scenario.warehouse.width} ${scenario.warehouse.depth} ${scenario.warehouse.floorThickness}</size></box></geometry>
        </collision>
        <visual name="floor_visual">
          <geometry><box><size>${scenario.warehouse.width} ${scenario.warehouse.depth} ${scenario.warehouse.floorThickness}</size></box></geometry>
          <material><ambient>0.78 0.80 0.82 1</ambient><diffuse>0.78 0.80 0.82 1</diffuse></material>
        </visual>
        <pose>0 0 ${-scenario.warehouse.floorThickness / 2} 0 0 0</pose>
      </link>
    </model>
${rackModels}
${stationModels}
${boxModels}
${robotModels}
  </world>
</sdf>
`;
}

function sdfBox(name: string, pose: { x: number; y: number; z: number }, size: { x: number; y: number; z: number }, rgba: string): string {
  return `    <model name="${name}">
      <static>true</static>
      <pose>${pose.x.toFixed(3)} ${pose.z.toFixed(3)} ${pose.y.toFixed(3)} 0 0 0</pose>
      <link name="link">
        <collision name="collision"><geometry><box><size>${size.x.toFixed(3)} ${size.z.toFixed(3)} ${size.y.toFixed(3)}</size></box></geometry></collision>
        <visual name="visual">
          <geometry><box><size>${size.x.toFixed(3)} ${size.z.toFixed(3)} ${size.y.toFixed(3)}</size></box></geometry>
          <material><ambient>${rgba}</ambient><diffuse>${rgba}</diffuse></material>
        </visual>
      </link>
    </model>`;
}

function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "warehouse_world";
}
