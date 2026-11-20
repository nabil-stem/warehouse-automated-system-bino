import {
  Group, Scene, Mesh, BoxGeometry, PlaneGeometry, InstancedMesh,
  Matrix4, Vector3, Quaternion, Line, BufferGeometry,
  Float32BufferAttribute, MeshStandardMaterial, MeshLambertMaterial,
  CylinderGeometry,
} from "three";
import type { WarehouseScenario, Slot, StationConfig } from "../domain/schema";
import {
  computeWarehouseExtents,
  rackBayBoundaryX,
} from "../domain/warehouseGenerator";
import {
  rackMaterial, shelfMaterial, boxMaterial, demandMaterial,
  floorMaterial, gridLineMaterial, wallMaterial, roofMaterial, stationColors,
} from "./materials";
import { makeLabelTexture } from "./labels";

const palletUprightMaterial = new MeshStandardMaterial({ color: "#1f5fd1", metalness: 0.55, roughness: 0.34 });
const palletBeamMaterial = new MeshStandardMaterial({ color: "#f2a51a", metalness: 0.35, roughness: 0.36 });
const toteMaterial = new MeshStandardMaterial({ color: "#303840", roughness: 0.58, metalness: 0.03 });
const toteLidMaterial = new MeshStandardMaterial({ color: "#4a5661", roughness: 0.5, metalness: 0.06 });
const toteFaceMaterial = new MeshStandardMaterial({ color: "#202833", roughness: 0.48 });
const toteHandleMaterial = new MeshStandardMaterial({ color: "#9aa5ad", roughness: 0.36, metalness: 0.18 });
const polishedFloorMaterial = new MeshStandardMaterial({ color: "#d8dde1", metalness: 0.05, roughness: 0.32 });
const hazardYellowMaterial = new MeshStandardMaterial({ color: "#f6c835", roughness: 0.38 });
const hazardBlackMaterial = new MeshStandardMaterial({ color: "#1b1c1f", roughness: 0.5 });
const overheadBeamMaterial = new MeshStandardMaterial({ color: "#d2d8de", metalness: 0.38, roughness: 0.4 });
const lightMaterial = new MeshStandardMaterial({ color: "#fffbe8", emissive: "#fff2a8", emissiveIntensity: 1.15, roughness: 0.2 });
const columnMaterial = new MeshStandardMaterial({ color: "#a0a8b0", metalness: 0.4, roughness: 0.4 });
const dockDoorMaterial = new MeshStandardMaterial({ color: "#4a5568", metalness: 0.3, roughness: 0.5 });
const dockFrameMaterial = new MeshStandardMaterial({ color: "#f6c835", roughness: 0.4 });
const bollardMaterial = new MeshStandardMaterial({ color: "#f6c835", roughness: 0.45 });
const bollardBaseMaterial = new MeshStandardMaterial({ color: "#1b1c1f", roughness: 0.6 });
const palletWoodMaterial = new MeshStandardMaterial({ color: "#a08050", roughness: 0.7 });
const trafficMarkMaterial = new MeshStandardMaterial({ color: "#555", roughness: 0.6, transparent: true, opacity: 0.15 });
const rackJointMaterial = new MeshStandardMaterial({ color: "#7b8794", metalness: 0.55, roughness: 0.32 });

export type WarehouseSceneGroup = {
  root: Group;
  boxInstances?: InstancedMesh;
  /** Per-slot instanced meshes (box body, tote details, bin faces) for live show/hide. */
  slotBoxTracking?: SlotBoxTracking;
};

export type SlotBoxTracking = {
  slotIds: string[];
  meshes: { mesh: InstancedMesh; perSlot: number; originals: Float32Array }[];
  hiddenSlotIds: Set<string>;
};

const ZERO_MATRIX = new Float32Array(16);

/**
 * Live shelf-box visibility: hide the instanced box (and its tote details / bin face)
 * while a slot's tote is being carried by a robot, restore it when the slot is
 * re-occupied (operator round-trip mode puts boxes back).
 */
export function updateSlotBoxVisibility(group: WarehouseSceneGroup, slots: Slot[]) {
  const tracking = group.slotBoxTracking;
  if (!tracking) return;
  const occupiedById = new Map(slots.map(s => [s.id, s.occupied]));

  for (let i = 0; i < tracking.slotIds.length; i++) {
    const slotId = tracking.slotIds[i];
    const occupied = occupiedById.get(slotId) ?? true;
    const hidden = tracking.hiddenSlotIds.has(slotId);
    if (occupied === !hidden) continue;

    for (const entry of tracking.meshes) {
      for (let k = 0; k < entry.perSlot; k++) {
        const instanceIndex = i * entry.perSlot + k;
        const offset = instanceIndex * 16;
        const source = occupied ? entry.originals.subarray(offset, offset + 16) : ZERO_MATRIX;
        (entry.mesh.instanceMatrix.array as Float32Array).set(source, offset);
      }
      entry.mesh.instanceMatrix.needsUpdate = true;
    }
    if (occupied) tracking.hiddenSlotIds.delete(slotId);
    else tracking.hiddenSlotIds.add(slotId);
  }
}

export function buildWarehouseScene(scenario: WarehouseScenario, slots: Slot[]): WarehouseSceneGroup {
  const root = new Group();
  root.name = "warehouse";
  const { warehouse, racks } = scenario;
  const ext = computeWarehouseExtents(scenario);

  const floor = new Mesh(
    new PlaneGeometry(warehouse.width, warehouse.depth),
    scenario.visual.polishedFloor ? polishedFloorMaterial : floorMaterial
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  root.add(floor);

  const gs = warehouse.gridSpacing;
  const halfW = warehouse.width / 2;
  const halfD = warehouse.depth / 2;
  for (let x = -halfW; x <= halfW; x += gs) {
    root.add(new Line(
      new BufferGeometry().setAttribute("position", new Float32BufferAttribute([x, 0.04, -halfD, x, 0.04, halfD], 3)),
      gridLineMaterial
    ));
  }
  for (let z = -halfD; z <= halfD; z += gs) {
    root.add(new Line(
      new BufferGeometry().setAttribute("position", new Float32BufferAttribute([-halfW, 0.04, z, halfW, 0.04, z], 3)),
      gridLineMaterial
    ));
  }

  if (warehouse.showWalls) {
    const wt = 0.15;
    const wh = warehouse.wallHeight;
    const addWall = (w: number, h: number, d: number, x: number, y: number, z: number) => {
      const wall = new Mesh(new BoxGeometry(w, h, d), wallMaterial);
      wall.position.set(x, y, z);
      root.add(wall);
    };
    addWall(warehouse.width, wh, wt, 0, wh / 2, -halfD);
    addWall(warehouse.width, wh, wt, 0, wh / 2, halfD);
    addWall(wt, wh, warehouse.depth, -halfW, wh / 2, 0);
    addWall(wt, wh, warehouse.depth, halfW, wh / 2, 0);
  }

  if (warehouse.showRoof) {
    addWarehouseRoof(root, scenario);
  }

  if (scenario.visual.showHazardLanes) {
    addHazardLanes(root, scenario, ext);
  }

  if (scenario.visual.showOverheadStructure) {
    addOverheadStructure(root, scenario);
  }

  if (scenario.visual.showSupportColumns) {
    addSupportColumns(root, scenario);
  }

  if (scenario.visual.showDockDoors) {
    addDockDoors(root, scenario);
  }

  if (scenario.visual.showFloorTrafficMarks) {
    addFloorTrafficMarks(root, scenario, ext);
  }

  for (let row = 0; row < racks.rowCount; row++) {
    const rowGroup = buildRackRow(row, scenario, ext);
    root.add(rowGroup);
  }

  if (scenario.visual.showRackBracing || scenario.visual.rackStyle === "pallet") {
    addBackToBackRackJoints(root, scenario, ext);
  }

  const occupied = slots.filter(s => s.occupied);
  let boxInstances: InstancedMesh | undefined;
  const trackedSlotMeshes: { mesh: InstancedMesh; perSlot: number }[] = [];
  if (occupied.length > 0) {
    if (scenario.visual.showPallets) {
      addPalletBlocks(root, occupied, scenario);
    }

    const toteMode = scenario.visual.boxStyle === "totes";
    const boxGeo = new BoxGeometry(
      scenario.boxes.width * (toteMode ? 0.88 : 1),
      scenario.boxes.height * (toteMode ? 0.78 : 1),
      scenario.boxes.depth * (toteMode ? 0.72 : 1)
    );
    boxInstances = new InstancedMesh(boxGeo, scenario.visual.boxStyle === "totes" ? toteMaterial : boxMaterial, occupied.length);
    const matrix = new Matrix4();
    const palletOffset = scenario.visual.showPallets ? 0.12 : 0;
    const boxHeight = scenario.boxes.height * (toteMode ? 0.78 : 1);
    const boxDepth = scenario.boxes.depth * (toteMode ? 0.72 : 1);
    occupied.forEach((slot, index) => {
      matrix.compose(
        new Vector3(
          slot.position.x,
          slot.position.y + boxHeight / 2 + racks.rackBeamThickness / 2 + palletOffset,
          slot.position.z - slot.side * 0.04
        ),
        new Quaternion(),
        new Vector3(1, 1, 1)
      );
      boxInstances!.setMatrixAt(index, matrix);
    });
    boxInstances.castShadow = true;
    boxInstances.instanceMatrix.needsUpdate = true;
    root.add(boxInstances);
    trackedSlotMeshes.push({ mesh: boxInstances, perSlot: 1 });

    if (toteMode) {
      trackedSlotMeshes.push(...addToteDetails(root, occupied, scenario, palletOffset, boxHeight, boxDepth));
    }

    if (scenario.visual.showBinFaces || scenario.visual.rackStyle === "bin-wall") {
      const faceGeo = new BoxGeometry(scenario.boxes.width * 0.72, boxHeight * 0.46, 0.04);
      const faceInstances = new InstancedMesh(faceGeo, toteFaceMaterial, occupied.length);
      occupied.forEach((slot, index) => {
        matrix.compose(
          new Vector3(
            slot.position.x,
            slot.position.y + boxHeight * 0.52 + racks.rackBeamThickness / 2 + palletOffset,
            slot.position.z + slot.side * (boxDepth / 2 + 0.02)
          ),
          new Quaternion(),
          new Vector3(1, 1, 1)
        );
        faceInstances.setMatrixAt(index, matrix);
      });
      faceInstances.instanceMatrix.needsUpdate = true;
      root.add(faceInstances);
      trackedSlotMeshes.push({ mesh: faceInstances, perSlot: 1 });
    }
  }

  const hotSlots = slots.filter(s => s.occupied && s.demandScore > 7).slice(0, 100);
  if (hotSlots.length > 0) {
    const markerGeo = new BoxGeometry(0.35, 0.06, 0.35);
    const markerMesh = new InstancedMesh(markerGeo, demandMaterial, hotSlots.length);
    const matrix = new Matrix4();
    hotSlots.forEach((slot, index) => {
      matrix.compose(
        new Vector3(slot.position.x, slot.position.y + scenario.boxes.height + racks.rackBeamThickness, slot.position.z + slot.side * 0.4),
        new Quaternion(),
        new Vector3(1, 1, 1)
      );
      markerMesh.setMatrixAt(index, matrix);
    });
    markerMesh.instanceMatrix.needsUpdate = true;
    root.add(markerMesh);
  }

  for (const station of scenario.stations) {
    root.add(buildStation(station));
  }

  if (scenario.visual.showSafetyBollards) {
    addSafetyBollards(root, scenario, ext);
  }

  const slotBoxTracking: SlotBoxTracking | undefined = trackedSlotMeshes.length > 0
    ? {
        slotIds: occupied.map(s => s.id),
        meshes: trackedSlotMeshes.map(entry => ({
          ...entry,
          originals: (entry.mesh.instanceMatrix.array as Float32Array).slice(),
        })),
        hiddenSlotIds: new Set(),
      }
    : undefined;

  return { root, boxInstances, slotBoxTracking };
}

function addToteDetails(
  root: Group,
  occupied: Slot[],
  scenario: WarehouseScenario,
  palletOffset: number,
  boxHeight: number,
  boxDepth: number
): { mesh: InstancedMesh; perSlot: number }[] {
  const { boxes, racks } = scenario;
  const matrix = new Matrix4();
  const width = boxes.width * 0.94;
  const lidGeo = new BoxGeometry(width, 0.055, boxDepth * 0.82);
  const lidInstances = new InstancedMesh(lidGeo, toteLidMaterial, occupied.length);

  const handleGeo = new BoxGeometry(width * 0.28, 0.055, 0.035);
  const handleInstances = new InstancedMesh(handleGeo, toteHandleMaterial, occupied.length * 2);

  const sideRibGeo = new BoxGeometry(0.035, boxHeight * 0.68, boxDepth * 0.62);
  const sideRibInstances = new InstancedMesh(sideRibGeo, toteLidMaterial, occupied.length * 2);

  occupied.forEach((slot, index) => {
    const baseY = slot.position.y + racks.rackBeamThickness / 2 + palletOffset;
    const bodyCenterZ = slot.position.z - slot.side * 0.04;
    matrix.compose(
      new Vector3(slot.position.x, baseY + boxHeight + 0.03, bodyCenterZ),
      new Quaternion(),
      new Vector3(1, 1, 1)
    );
    lidInstances.setMatrixAt(index, matrix);

    for (let i = 0; i < 2; i++) {
      const xOffset = i === 0 ? -width * 0.23 : width * 0.23;
      matrix.compose(
        new Vector3(
          slot.position.x + xOffset,
          baseY + boxHeight * 0.52,
          slot.position.z + slot.side * (boxDepth / 2 + 0.055)
        ),
        new Quaternion(),
        new Vector3(1, 1, 1)
      );
      handleInstances.setMatrixAt(index * 2 + i, matrix);

      matrix.compose(
        new Vector3(
          slot.position.x + (i === 0 ? -width * 0.47 : width * 0.47),
          baseY + boxHeight * 0.5,
          bodyCenterZ
        ),
        new Quaternion(),
        new Vector3(1, 1, 1)
      );
      sideRibInstances.setMatrixAt(index * 2 + i, matrix);
    }
  });

  lidInstances.instanceMatrix.needsUpdate = true;
  handleInstances.instanceMatrix.needsUpdate = true;
  sideRibInstances.instanceMatrix.needsUpdate = true;
  root.add(lidInstances, handleInstances, sideRibInstances);

  return [
    { mesh: lidInstances, perSlot: 1 },
    { mesh: handleInstances, perSlot: 2 },
    { mesh: sideRibInstances, perSlot: 2 },
  ];
}

function buildRackRow(
  rowIndex: number,
  scenario: WarehouseScenario,
  ext: ReturnType<typeof computeWarehouseExtents>
): Group {
  const { racks } = scenario;
  const uprightMaterial = scenario.visual.rackStyle === "pallet" ? palletUprightMaterial : rackMaterial;
  const beamMaterial = scenario.visual.rackStyle === "pallet" ? palletBeamMaterial : shelfMaterial;
  const row = new Group();
  const pairIndex = Math.floor(rowIndex / 2);
  const side = rowIndex % 2 === 0 ? -1 : 1;
  const z = ext.rackBlockStartZ + pairIndex * racks.rowPitch + side * (racks.shelfDepth / 2 + 0.1);
  row.position.z = z;

  const length = ext.rackBlockWidth;
  const startX = ext.rackBlockStartX;
  const baySegments = getRackBaySegments(scenario);

  for (let level = 0; level < racks.levels; level++) {
    const y = racks.bottomShelfHeight + level * racks.levelHeight;
    for (const segment of baySegments) {
      const segmentStartX = rackBayBoundaryX(scenario, segment.start, startX);
      const segmentEndX = rackBayBoundaryX(scenario, segment.end, startX);
      const segmentLength = segmentEndX - segmentStartX;
      const shelf = new Mesh(
        new BoxGeometry(segmentLength, racks.rackBeamThickness, racks.shelfDepth),
        beamMaterial
      );
      shelf.position.set(segmentStartX + segmentLength / 2, y, 0);
      shelf.castShadow = true;
      shelf.receiveShadow = true;
      row.add(shelf);
    }
  }

  for (const segment of baySegments) {
    for (let bay = segment.start; bay <= segment.end; bay++) {
      const x = rackBayBoundaryX(scenario, bay, startX);
      const totalHeight = racks.bottomShelfHeight + (racks.levels - 1) * racks.levelHeight + 0.5;
      const upright1 = new Mesh(
        new BoxGeometry(racks.uprightThickness, totalHeight, racks.uprightThickness),
        uprightMaterial
      );
      upright1.position.set(x, totalHeight / 2, -racks.shelfDepth / 2 + racks.uprightThickness / 2);
      upright1.castShadow = true;
      row.add(upright1);

      const upright2 = new Mesh(
        new BoxGeometry(racks.uprightThickness, totalHeight, racks.uprightThickness),
        uprightMaterial
      );
      upright2.position.set(x, totalHeight / 2, racks.shelfDepth / 2 - racks.uprightThickness / 2);
      upright2.castShadow = true;
      row.add(upright2);
    }
  }

  if (scenario.visual.showRackBracing || scenario.visual.rackStyle === "pallet") {
    const totalHeight = racks.bottomShelfHeight + (racks.levels - 1) * racks.levelHeight + 0.5;
    const backBraceZ = side === -1
      ? racks.shelfDepth / 2 + 0.025
      : -racks.shelfDepth / 2 - 0.025;
    const braceStep = Math.max(3, Math.floor(racks.crossAisleEveryBays || 4));
    for (const segment of baySegments) {
      for (let bay = segment.start; bay < segment.end; bay += braceStep) {
        const x1 = rackBayBoundaryX(scenario, bay, startX);
        const x2 = rackBayBoundaryX(scenario, Math.min(bay + 1, segment.end), startX);
        addDiagonalBrace(row, x1, 0.3, x2, totalHeight - 0.15, backBraceZ, rackJointMaterial);
      }
    }
  }

  if (rowIndex % 2 === 0) {
    const labelMesh = new Mesh(
      new BoxGeometry(1.8, 0.04, 0.8),
      new MeshLambertMaterial({ map: makeLabelTexture(`Row ${rowIndex + 1}`, "#3b8be2") })
    );
    labelMesh.position.set(startX - 1, racks.bottomShelfHeight + 0.5, 0);
    labelMesh.rotation.x = -Math.PI / 2;
    row.add(labelMesh);
  }

  return row;
}

function addDiagonalBrace(
  row: Group,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  z: number,
  material: MeshStandardMaterial
) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  const brace = new Mesh(new BoxGeometry(length, 0.045, 0.045), material);
  brace.position.set((x1 + x2) / 2, (y1 + y2) / 2, z);
  brace.rotation.z = Math.atan2(dy, dx);
  brace.castShadow = true;
  row.add(brace);
}

function addBackToBackRackJoints(
  root: Group,
  scenario: WarehouseScenario,
  ext: ReturnType<typeof computeWarehouseExtents>
) {
  const { racks } = scenario;
  const pairCount = Math.floor(racks.rowCount / 2);
  const startX = ext.rackBlockStartX;
  const totalHeight = racks.bottomShelfHeight + (racks.levels - 1) * racks.levelHeight + 0.5;
  const innerGap = 0.2 + racks.uprightThickness;
  const tieThickness = Math.max(0.05, racks.uprightThickness * 0.34);
  const baySegments = getRackBaySegments(scenario);
  const tieStep = Math.max(3, Math.floor(racks.crossAisleEveryBays || 4));

  for (let pair = 0; pair < pairCount; pair++) {
    const z = ext.rackBlockStartZ + pair * racks.rowPitch;

    for (const segment of baySegments) {
      for (let bay = segment.start; bay <= segment.end; bay++) {
        const isStructuralBay = bay === segment.start || bay === segment.end || bay % tieStep === 0;
        if (!isStructuralBay) continue;
        const x = rackBayBoundaryX(scenario, bay, startX);
        addCrossTie(root, x, 0.35, z, innerGap, tieThickness);
        addCrossTie(root, x, totalHeight - 0.12, z, innerGap, tieThickness);
      }
    }

    for (const segment of baySegments) {
      for (let bay = segment.start; bay < segment.end; bay += tieStep) {
        const x1 = rackBayBoundaryX(scenario, bay, startX) + racks.uprightThickness * 0.5;
        const x2 = rackBayBoundaryX(scenario, Math.min(bay + 1, segment.end), startX) - racks.uprightThickness * 0.5;
        addBackPlaneBrace(root, x1, x2, z + innerGap / 2, z - innerGap / 2, totalHeight - 0.2, rackJointMaterial);
      }
    }
  }
}

function getRackBaySegments(scenario: WarehouseScenario): Array<{ start: number; end: number }> {
  const { racks } = scenario;
  const every = Math.max(0, Math.floor(racks.crossAisleEveryBays));
  if (every <= 0 || every >= racks.baysPerRow) {
    return [{ start: 0, end: racks.baysPerRow }];
  }

  const segments: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < racks.baysPerRow; start += every) {
    segments.push({ start, end: Math.min(start + every, racks.baysPerRow) });
  }
  return segments;
}

function addCrossTie(root: Group, x: number, y: number, z: number, depth: number, thickness: number) {
  const tie = new Mesh(new BoxGeometry(thickness, thickness, depth), rackJointMaterial);
  tie.position.set(x, y, z);
  tie.castShadow = true;
  root.add(tie);
}

function addBackPlaneBrace(
  root: Group,
  x1: number,
  x2: number,
  z1: number,
  z2: number,
  y: number,
  material: MeshStandardMaterial
) {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const length = Math.hypot(dx, dz);
  const brace = new Mesh(new BoxGeometry(length, 0.04, 0.04), material);
  brace.position.set((x1 + x2) / 2, y, (z1 + z2) / 2);
  brace.rotation.y = -Math.atan2(dz, dx);
  brace.castShadow = true;
  root.add(brace);
}

function addRackExpansionJointFrames(
  root: Group,
  scenario: WarehouseScenario,
  ext: ReturnType<typeof computeWarehouseExtents>,
  pairCount: number,
  startX: number,
  totalHeight: number
) {
  const { racks } = scenario;
  if (pairCount < 2 || racks.baysPerRow < 4) return;

  const interval = Math.max(3, Math.round(racks.baysPerRow / 4));
  const zStart = ext.rackBlockStartZ - (racks.shelfDepth + 0.18);
  const zEnd = ext.rackBlockStartZ + (pairCount - 1) * racks.rowPitch + racks.shelfDepth + 0.18;
  const zSpan = zEnd - zStart;
  const centerZ = (zStart + zEnd) / 2;
  const frameThickness = Math.max(0.08, racks.uprightThickness * 0.62);

  for (let bay = interval; bay < racks.baysPerRow; bay += interval) {
    const x = startX + bay * racks.bayWidth;

    addExpansionJointRail(root, x, 0.42, centerZ, zSpan, frameThickness);
    addExpansionJointRail(root, x, totalHeight - 0.12, centerZ, zSpan, frameThickness);

    for (let level = 0; level < racks.levels; level++) {
      const y = racks.bottomShelfHeight + level * racks.levelHeight;
      addExpansionJointRail(root, x, y, centerZ, zSpan, frameThickness);
    }

    for (let pair = 0; pair < pairCount; pair++) {
      const z = ext.rackBlockStartZ + pair * racks.rowPitch;
      const post = new Mesh(
        new BoxGeometry(frameThickness * 1.15, totalHeight, frameThickness * 1.15),
        rackJointMaterial
      );
      post.position.set(x, totalHeight / 2, z);
      post.castShadow = true;
      root.add(post);
    }
  }
}

function addExpansionJointRail(
  root: Group,
  x: number,
  y: number,
  z: number,
  depth: number,
  thickness: number
) {
  const rail = new Mesh(new BoxGeometry(thickness, thickness, depth), rackJointMaterial);
  rail.position.set(x, y, z);
  rail.castShadow = true;
  root.add(rail);
}

function addHazardLanes(root: Group, scenario: WarehouseScenario, ext: ReturnType<typeof computeWarehouseExtents>) {
  const halfW = scenario.warehouse.width / 2;
  const laneZ = ext.mainAisleZ;
  const lineLength = scenario.warehouse.width * 0.88;
  addHazardLine(root, 0, laneZ - scenario.racks.mainAisleWidth / 2, lineLength, "x");
  addHazardLine(root, 0, laneZ + scenario.racks.mainAisleWidth / 2, lineLength, "x");

  for (let pair = 0; pair < Math.ceil(scenario.racks.rowCount / 2); pair++) {
    const z = ext.rackBlockStartZ + pair * scenario.racks.rowPitch;
    addHazardLine(root, -halfW + 1.4, z, scenario.racks.rowPitch * 0.75, "z");
    addHazardLine(root, halfW - 1.4, z, scenario.racks.rowPitch * 0.75, "z");
  }
}

function addHazardLine(root: Group, x: number, z: number, length: number, axis: "x" | "z") {
  const yellow = new Mesh(
    axis === "x" ? new BoxGeometry(length, 0.025, 0.12) : new BoxGeometry(0.12, 0.025, length),
    hazardYellowMaterial
  );
  yellow.position.set(x, 0.035, z);
  root.add(yellow);

  const stripeCount = Math.max(6, Math.floor(length / 2.5));
  for (let i = 0; i < stripeCount; i++) {
    const offset = -length / 2 + i * (length / stripeCount);
    const stripe = new Mesh(new BoxGeometry(0.65, 0.03, 0.12), hazardBlackMaterial);
    stripe.position.set(axis === "x" ? x + offset : x, 0.055, axis === "x" ? z : z + offset);
    stripe.rotation.y = axis === "x" ? Math.PI / 5 : -Math.PI / 5;
    root.add(stripe);
  }
}

function addWarehouseRoof(root: Group, scenario: WarehouseScenario) {
  const { warehouse } = scenario;
  const y = warehouse.wallHeight + 0.08;
  const roof = new Mesh(
    new BoxGeometry(warehouse.width, 0.12, warehouse.depth),
    roofMaterial
  );
  roof.position.set(0, y, 0);
  roof.castShadow = false;
  roof.receiveShadow = false;
  root.add(roof);

  const skylightMat = new MeshStandardMaterial({
    color: "#dff8ff",
    transparent: true,
    opacity: 0.34,
    roughness: 0.12,
    metalness: 0.02,
  });
  const stripCount = Math.max(3, Math.floor(warehouse.width / 22));
  const spacing = warehouse.width / (stripCount + 1);
  for (let i = 0; i < stripCount; i++) {
    const x = -warehouse.width / 2 + spacing * (i + 1);
    const skylight = new Mesh(new BoxGeometry(2.2, 0.035, warehouse.depth * 0.78), skylightMat);
    skylight.position.set(x, y + 0.08, 0);
    skylight.castShadow = false;
    skylight.receiveShadow = false;
    root.add(skylight);
  }
}

function addOverheadStructure(root: Group, scenario: WarehouseScenario) {
  const halfW = scenario.warehouse.width / 2;
  const halfD = scenario.warehouse.depth / 2;
  const y = Math.max(scenario.warehouse.wallHeight, scenario.racks.bottomShelfHeight + scenario.racks.levels * scenario.racks.levelHeight + 2.2);

  for (let z = -halfD + 4; z <= halfD - 4; z += 8) {
    const beam = new Mesh(new BoxGeometry(scenario.warehouse.width, 0.09, 0.09), overheadBeamMaterial);
    beam.position.set(0, y, z);
    root.add(beam);

    const truss1 = new Mesh(new BoxGeometry(scenario.warehouse.width, 0.04, 0.04), overheadBeamMaterial);
    truss1.position.set(0, y - 0.3, z - 0.2);
    root.add(truss1);
    const truss2 = new Mesh(new BoxGeometry(scenario.warehouse.width, 0.04, 0.04), overheadBeamMaterial);
    truss2.position.set(0, y - 0.3, z + 0.2);
    root.add(truss2);
  }

  for (let x = -halfW + 5; x <= halfW - 5; x += 10) {
    const beam = new Mesh(new BoxGeometry(0.09, 0.09, scenario.warehouse.depth), overheadBeamMaterial);
    beam.position.set(x, y + 0.06, 0);
    root.add(beam);
    for (let z = -halfD + 7; z <= halfD - 7; z += 14) {
      const lightFixture = new Mesh(new BoxGeometry(2.2, 0.045, 0.24), lightMaterial);
      lightFixture.position.set(x, y - 0.25, z);
      root.add(lightFixture);

      const housing = new Mesh(
        new BoxGeometry(2.4, 0.06, 0.32),
        overheadBeamMaterial
      );
      housing.position.set(x, y - 0.22, z);
      root.add(housing);
    }
  }
}

function addSupportColumns(root: Group, scenario: WarehouseScenario) {
  const halfW = scenario.warehouse.width / 2;
  const halfD = scenario.warehouse.depth / 2;
  const colHeight = Math.max(scenario.warehouse.wallHeight, scenario.racks.bottomShelfHeight + scenario.racks.levels * scenario.racks.levelHeight + 2.5);
  const spacing = 16;

  for (let x = -halfW + spacing; x < halfW; x += spacing) {
    for (let z = -halfD + spacing; z < halfD; z += spacing) {
      const col = new Mesh(
        new CylinderGeometry(0.2, 0.22, colHeight, 8),
        columnMaterial
      );
      col.position.set(x, colHeight / 2, z);
      col.castShadow = true;
      root.add(col);

      const capPlate = new Mesh(new BoxGeometry(0.6, 0.06, 0.6), columnMaterial);
      capPlate.position.set(x, colHeight, z);
      root.add(capPlate);
    }
  }
}

function addDockDoors(root: Group, scenario: WarehouseScenario) {
  const halfW = scenario.warehouse.width / 2;
  const halfD = scenario.warehouse.depth / 2;
  const doorWidth = 4;
  const doorHeight = 4.5;
  const doorCount = Math.max(2, Math.floor(scenario.warehouse.width / 20));
  const spacing = scenario.warehouse.width / (doorCount + 1);

  for (let i = 0; i < doorCount; i++) {
    const x = -halfW + spacing * (i + 1);
    const z = halfD;

    const door = new Mesh(new BoxGeometry(doorWidth, doorHeight, 0.2), dockDoorMaterial);
    door.position.set(x, doorHeight / 2, z - 0.1);
    root.add(door);

    const frameTop = new Mesh(new BoxGeometry(doorWidth + 0.4, 0.2, 0.25), dockFrameMaterial);
    frameTop.position.set(x, doorHeight + 0.1, z - 0.1);
    root.add(frameTop);

    for (const side of [-1, 1]) {
      const frameSide = new Mesh(new BoxGeometry(0.2, doorHeight, 0.25), dockFrameMaterial);
      frameSide.position.set(x + side * (doorWidth / 2 + 0.1), doorHeight / 2, z - 0.1);
      root.add(frameSide);
    }

    const bump = new Mesh(
      new BoxGeometry(doorWidth - 0.5, 0.8, 1.5),
      new MeshStandardMaterial({ color: "#333", roughness: 0.7 })
    );
    bump.position.set(x, 0.4, z + 0.6);
    root.add(bump);

    const labelMesh = new Mesh(
      new BoxGeometry(1.5, 0.04, 0.5),
      new MeshLambertMaterial({ map: makeLabelTexture(`Dock ${i + 1}`, "#f6c835") })
    );
    labelMesh.position.set(x, doorHeight + 0.5, z - 0.2);
    labelMesh.rotation.x = -Math.PI / 2;
    root.add(labelMesh);
  }
}

function addSafetyBollards(root: Group, scenario: WarehouseScenario, ext: ReturnType<typeof computeWarehouseExtents>) {
  const { racks } = scenario;
  const rackLength = racks.baysPerRow * racks.bayWidth;
  const startX = -rackLength / 2;
  const endX = rackLength / 2;

  for (let pair = 0; pair < Math.ceil(racks.rowCount / 2); pair++) {
    const z = ext.rackBlockStartZ + pair * racks.rowPitch;
    for (const x of [startX - 0.5, endX + 0.5]) {
      addBollard(root, x, z);
    }
  }

  for (const station of scenario.stations) {
    const corners = [
      { x: station.position.x - station.width / 2 - 0.5, z: station.position.z - station.depth / 2 - 0.5 },
      { x: station.position.x + station.width / 2 + 0.5, z: station.position.z - station.depth / 2 - 0.5 },
    ];
    for (const pos of corners) {
      addBollard(root, pos.x, pos.z);
    }
  }
}

function addBollard(root: Group, x: number, z: number) {
  const post = new Mesh(new CylinderGeometry(0.08, 0.1, 0.7, 8), bollardMaterial);
  post.position.set(x, 0.35, z);
  post.castShadow = true;
  root.add(post);

  const base = new Mesh(new CylinderGeometry(0.15, 0.15, 0.06, 8), bollardBaseMaterial);
  base.position.set(x, 0.03, z);
  root.add(base);
}

function addPalletBlocks(root: Group, occupiedSlots: Slot[], scenario: WarehouseScenario) {
  const palletCount = Math.min(occupiedSlots.length, 3000);
  const palletGeo = new BoxGeometry(scenario.boxes.width * 0.95, 0.12, scenario.boxes.depth * 0.95);
  const palletMesh = new InstancedMesh(palletGeo, palletWoodMaterial, palletCount);
  const matrix = new Matrix4();

  for (let i = 0; i < palletCount; i++) {
    const slot = occupiedSlots[i];
    matrix.compose(
      new Vector3(
        slot.position.x,
        slot.position.y + scenario.racks.rackBeamThickness / 2 + 0.06,
        slot.position.z
      ),
      new Quaternion(),
      new Vector3(1, 1, 1)
    );
    palletMesh.setMatrixAt(i, matrix);
  }
  palletMesh.instanceMatrix.needsUpdate = true;
  root.add(palletMesh);
}

function addFloorTrafficMarks(root: Group, scenario: WarehouseScenario, ext: ReturnType<typeof computeWarehouseExtents>) {
  const halfW = scenario.warehouse.width / 2;
  const { racks } = scenario;

  for (let pair = 0; pair < Math.ceil(racks.rowCount / 2); pair++) {
    const z = ext.rackBlockStartZ + pair * racks.rowPitch;
    const mark = new Mesh(
      new BoxGeometry(halfW * 1.5, 0.015, 1.2),
      trafficMarkMaterial
    );
    mark.position.set(0, 0.02, z);
    root.add(mark);
  }

  const mainAisleMark = new Mesh(
    new BoxGeometry(halfW * 1.6, 0.015, racks.mainAisleWidth * 0.6),
    trafficMarkMaterial
  );
  mainAisleMark.position.set(0, 0.02, ext.mainAisleZ);
  root.add(mainAisleMark);
}

function buildStation(station: StationConfig): Group {
  const group = new Group();
  const color = stationColors[station.type] ?? "#555";
  const baseMat = new MeshStandardMaterial({ color, roughness: 0.5 });

  const base = new Mesh(new BoxGeometry(station.width, 0.25, station.depth), baseMat);
  base.position.set(station.position.x, 0.125, station.position.z);
  base.receiveShadow = true;
  group.add(base);

  const desk = new Mesh(
    new BoxGeometry(station.width * 0.5, 1.2, station.depth * 0.4),
    new MeshStandardMaterial({ color: "#dfe6eb", roughness: 0.48 })
  );
  desk.position.set(station.position.x, 0.6, station.position.z);
  desk.castShadow = true;
  group.add(desk);

  const labelMesh = new Mesh(
    new BoxGeometry(2.2, 0.04, 0.7),
    new MeshLambertMaterial({ map: makeLabelTexture(station.label, color) })
  );
  labelMesh.position.set(station.position.x, 1.35, station.position.z);
  labelMesh.rotation.x = -Math.PI / 2;
  group.add(labelMesh);

  return group;
}

export function disposeGroup(group: Group | Scene) {
  group.traverse((obj) => {
    if (obj instanceof Mesh || obj instanceof InstancedMesh) {
      obj.geometry.dispose();
      if (Array.isArray(obj.material)) {
        obj.material.forEach(m => m.dispose());
      } else {
        obj.material.dispose();
      }
    }
    if (obj instanceof Line) {
      obj.geometry.dispose();
      if (Array.isArray(obj.material)) {
        obj.material.forEach(m => m.dispose());
      } else {
        obj.material.dispose();
      }
    }
  });
}
