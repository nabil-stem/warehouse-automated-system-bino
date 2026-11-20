import {
  Scene, PerspectiveCamera, WebGLRenderer, AmbientLight,
  DirectionalLight, HemisphereLight, Color, Group, Line, BufferGeometry,
  Float32BufferAttribute, LineBasicMaterial, LineSegments, Points,
  PointsMaterial, Mesh, PlaneGeometry, MeshBasicMaterial,
  CanvasTexture, ACESFilmicToneMapping, SRGBColorSpace, DoubleSide,
  Raycaster, Vector2, Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { WarehouseScenario, RobotRuntime, Slot, NavGraph, Mission, Vec2 } from "../domain/schema";
import { buildWarehouseScene, disposeGroup, updateSlotBoxVisibility, type WarehouseSceneGroup } from "./warehouseRenderer";
import { createProceduralRobot, updateRobotVisual, disposeRobotVisual, type RobotVisual } from "./robotRenderer";
import {
  applyReferenceModelOpacity,
  cloneReferenceWarehouseModel,
  cloneRobotModel,
  hasCustomModel,
  hasReferenceWarehouseModel,
} from "./loaders";
import { getRobotColor } from "./materials";
import { getYieldBays, getPhysicalQueueSlots, getParkingBays, type YieldBay } from "../domain/robotSimulation";
import { computeWarehouseExtents, rackBayBoundaryX } from "../domain/warehouseGenerator";
import { buildSolidObstacles, isClearSegment, pointInsideSolid, robotRadius } from "../domain/obstacles";
import { makeParkingBayLabelTexture } from "./labels";

export type SceneState = {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  controls: OrbitControls;
  warehouseGroup: WarehouseSceneGroup | null;
  robotVisuals: RobotVisual[];
  routeLines: Group;
  heatmapGroup: Group;
  navGraphGroup: Group;
  laneGeometryGroup: Group;
  referenceModel: Group | null;
};

let sceneState: SceneState | null = null;
let qrMarkerMaterial: MeshBasicMaterial | null = null;
type RobotCameraMode = "robot-camera" | "follow" | "follow-close" | "lift-close" | "payload-side";

let activeRobotCamera: { robotId: number; mode: RobotCameraMode } | null = null;

let selectedRobotId: number | null = null;
const selectionListeners: Array<(id: number | null) => void> = [];

export function getSelectedRobotId(): number | null {
  return selectedRobotId;
}

export function setSelectedRobotId(id: number | null) {
  selectedRobotId = id;
  for (const fn of selectionListeners) fn(id);
}

export function onRobotSelected(fn: (id: number | null) => void): () => void {
  selectionListeners.push(fn);
  return () => {
    const idx = selectionListeners.indexOf(fn);
    if (idx >= 0) selectionListeners.splice(idx, 1);
  };
}

export type SceneOverlay = "navgraph" | "reference";

export function setOverlayVisible(overlay: SceneOverlay, visible: boolean) {
  if (!sceneState) return;
  if (overlay === "navgraph") sceneState.navGraphGroup.visible = visible;
  if (overlay === "reference" && sceneState.referenceModel) {
    sceneState.referenceModel.visible = visible;
  }
}

export function isOverlayVisible(overlay: SceneOverlay): boolean {
  if (!sceneState) return true;
  if (overlay === "navgraph") return sceneState.navGraphGroup.visible;
  if (overlay === "reference") return sceneState.referenceModel?.visible ?? false;
  return true;
}

export function getSceneState(): SceneState | null {
  return sceneState;
}

export function initScene(mount: HTMLElement): SceneState {
  const scene = new Scene();
  scene.background = new Color("#111820");

  const camera = new PerspectiveCamera(48, mount.clientWidth / mount.clientHeight, 0.1, 600);
  camera.position.set(44, 42, 54);
  camera.lookAt(0, 0, 0);

  const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(mount.clientWidth, mount.clientHeight);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.shadowMap.enabled = false;
  mount.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.2, 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.48;

  scene.add(new AmbientLight("#ffffff", 0.72));
  const hemisphere = new HemisphereLight("#f7fbff", "#46505a", 0.82);
  scene.add(hemisphere);

  const sun = new DirectionalLight("#fff9ec", 1.25);
  sun.position.set(30, 48, 26);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 150;
  sun.shadow.camera.left = -60;
  sun.shadow.camera.right = 60;
  sun.shadow.camera.top = 60;
  sun.shadow.camera.bottom = -60;
  scene.add(sun);

  const fill = new DirectionalLight("#d8ecff", 0.78);
  fill.position.set(-36, 22, -34);
  scene.add(fill);

  const cameraFill = new DirectionalLight("#ffffff", 0.34);
  cameraFill.position.set(0, 18, 48);
  scene.add(cameraFill);

  const aisleWash = new DirectionalLight("#e7f4ff", 0.44);
  aisleWash.position.set(-8, 34, 4);
  scene.add(aisleWash);

  const routeLines = new Group();
  routeLines.name = "routes";
  scene.add(routeLines);

  const heatmapGroup = new Group();
  heatmapGroup.name = "heatmap";
  scene.add(heatmapGroup);

  const navGraphGroup = new Group();
  navGraphGroup.name = "navgraph";
  // Show the filtered public QR/track layer by default so the green guide paths
  // remain visible in demos while the dense internal routing graph stays hidden.
  navGraphGroup.visible = true;
  scene.add(navGraphGroup);

  const laneGeometryGroup = new Group();
  laneGeometryGroup.name = "lane-geometry";
  scene.add(laneGeometryGroup);

  const resize = () => {
    camera.aspect = mount.clientWidth / mount.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(mount.clientWidth, mount.clientHeight);
  };
  window.addEventListener("resize", resize);

  // Click-to-select a robot in the 3D view.
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  let downX = 0;
  let downY = 0;
  renderer.domElement.addEventListener("pointerdown", (e) => {
    downX = e.clientX;
    downY = e.clientY;
  });
  renderer.domElement.addEventListener("pointerup", (e) => {
    // Ignore drags (orbit control), only treat as a click when pointer barely moved.
    if (Math.abs(e.clientX - downX) > 5 || Math.abs(e.clientY - downY) > 5) return;
    if (!sceneState) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const targets = sceneState.robotVisuals.map(rv => rv.group);
    const hits = raycaster.intersectObjects(targets, true);
    if (hits.length === 0) return;
    let obj: Object3D | null = hits[0].object;
    while (obj && obj.userData.robotId === undefined) obj = obj.parent;
    if (obj && typeof obj.userData.robotId === "number") {
      setSelectedRobotId(obj.userData.robotId as number);
    }
  });

  sceneState = {
    scene, camera, renderer, controls,
    warehouseGroup: null,
    robotVisuals: [],
    routeLines,
    heatmapGroup,
    navGraphGroup,
    laneGeometryGroup,
    referenceModel: null,
  };
  return sceneState;
}

export function rebuildScene(
  scenario: WarehouseScenario,
  slots: Slot[],
  robots: RobotRuntime[],
  navGraph?: NavGraph
) {
  if (!sceneState) return;
  const { scene } = sceneState;

  if (sceneState.warehouseGroup) {
    scene.remove(sceneState.warehouseGroup.root);
    disposeGroup(sceneState.warehouseGroup.root);
  }

  for (const rv of sceneState.robotVisuals) {
    scene.remove(rv.group);
    disposeRobotVisual(rv);
  }
  sceneState.robotVisuals = [];

  clearGroup(sceneState.routeLines);
  clearGroup(sceneState.heatmapGroup);
  clearGroup(sceneState.navGraphGroup);
  clearGroup(sceneState.laneGeometryGroup);
  qrMarkerMaterial = null;
  if (sceneState.referenceModel) {
    scene.remove(sceneState.referenceModel);
    sceneState.referenceModel = null;
  }

  const referenceModelAvailable = hasReferenceWarehouseModel();
  if (scenario.visual.showProceduralUnderReference || !referenceModelAvailable) {
    const warehouseGroup = buildWarehouseScene(scenario, slots);
    scene.add(warehouseGroup.root);
    sceneState.warehouseGroup = warehouseGroup;
  } else {
    sceneState.warehouseGroup = null;
  }

  if (navGraph) {
    buildNavigationGraphVisual(navGraph, sceneState.navGraphGroup);
  }
  if (referenceModelAvailable) {
    const reference = cloneReferenceWarehouseModel(scenario.visual.referenceModelScale);
    if (reference) {
      reference.name = "reference-warehouse-model";
      applyReferenceModelOpacity(reference, scenario.visual.referenceModelOpacity);
      reference.position.y += 0.03;
      scene.add(reference);
      sceneState.referenceModel = reference;
    }
  }

  const useCustom = scenario.robots.useCustomModel && hasCustomModel();
  for (const robot of robots) {
    let visual: RobotVisual;
    if (useCustom) {
      const clone = cloneRobotModel(scenario.robots.customModelScale);
      if (clone) {
        const group = new Group();
        group.add(clone);
        visual = {
          group,
          liftGroup: new Group(),
          forkGroup: new Group(),
          carriedBox: clone.children[0] as any ?? clone,
          id: robot.id,
        };
      } else {
        visual = createProceduralRobot(robot.id, scenario);
      }
    } else {
      visual = createProceduralRobot(robot.id, scenario);
    }
    visual.group.position.set(robot.position.x, 0, robot.position.z);
    visual.group.userData.robotId = robot.id;
    scene.add(visual.group);
    sceneState.robotVisuals.push(visual);
  }
}

export function updateRobots(
  robots: RobotRuntime[],
  scenario: WarehouseScenario,
  dt: number,
  missions: Mission[] = [],
  slots: Slot[] = []
) {
  if (!sceneState) return;
  for (let i = 0; i < sceneState.robotVisuals.length && i < robots.length; i++) {
    updateRobotVisual(sceneState.robotVisuals[i], robots[i], scenario, dt, missions, slots);
  }
  // Picked boxes disappear from their shelf slot (and reappear when returned).
  if (sceneState.warehouseGroup && slots.length > 0) {
    updateSlotBoxVisibility(sceneState.warehouseGroup, slots);
  }
  if (activeRobotCamera) {
    const robot = robots.find(r => r.id === activeRobotCamera?.robotId);
    if (robot) {
      applyRobotCamera(robot, activeRobotCamera.mode);
    }
  }
}

export function updateRouteLines(robots: RobotRuntime[], scenario: WarehouseScenario) {
  if (!sceneState) return;
  clearGroup(sceneState.routeLines);
  if (!scenario.simulation.showRoutes) return;

  const radius = Math.max(scenario.robots.footprintWidth, scenario.robots.footprintDepth) / 2;
  const clearance = scenario.simulation.robotClearanceMeters ?? 0.12;

  for (const robot of robots) {
    // Amber hold marker over robots waiting for startup launch clearance.
    if (robot.launchCleared === false) {
      addLaunchHoldMarker(sceneState.routeLines, robot.position, radius + clearance * 0.5);
    }

    // Charging "loading bar" over a docked robot: fills as the battery recharges.
    if (robot.state === "charging") {
      addChargingProgressMarker(
        sceneState.routeLines,
        robot.position,
        Math.max(0, Math.min(1, robot.batteryMinutes / Math.max(1, scenario.robots.batteryCapacityMinutes)))
      );
    }

    if (robot.path.length < 2) continue;
    const color = "#00ff88";
    const arrowColor = getRobotColor(robot.id);

    const points: number[] = [];
    points.push(robot.position.x, 0.18, robot.position.z);
    for (let i = robot.pathIndex; i < robot.path.length; i++) {
      points.push(robot.path[i].x, 0.18, robot.path[i].z);
    }
    if (points.length >= 6) {
      const geo = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(points, 3));
      sceneState.routeLines.add(new Line(geo, new LineBasicMaterial({ color, transparent: true, opacity: 0.92 })));
      addRouteArrows(sceneState.routeLines, robot, arrowColor);
    }

    // Safety envelope ring around the currently selected robot.
    if (robot.id === selectedRobotId) {
      addSafetyEnvelope(sceneState.routeLines, robot.position, radius + clearance, color);
    }
  }
}

function addRouteArrows(group: Group, robot: RobotRuntime, color: string) {
  const spacing = 3.2; // metres between direction chevrons
  let carry = 0;
  for (let i = robot.pathIndex; i < robot.path.length - 1; i++) {
    const a = robot.path[i];
    const b = robot.path[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    if (segLen < 0.01) continue;
    const dirX = (b.x - a.x) / segLen;
    const dirZ = (b.z - a.z) / segLen;
    let d = carry;
    while (d < segLen) {
      const px = a.x + dirX * d;
      const pz = a.z + dirZ * d;
      // Chevron: two short segments pointing along travel direction.
      const back = 0.45;
      const wing = 0.32;
      const leftX = px - dirX * back - dirZ * wing;
      const leftZ = pz - dirZ * back + dirX * wing;
      const rightX = px - dirX * back + dirZ * wing;
      const rightZ = pz - dirZ * back - dirX * wing;
      const pts = [leftX, 0.17, leftZ, px, 0.17, pz, rightX, 0.17, rightZ];
      const geo = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(pts, 3));
      group.add(new Line(geo, new LineBasicMaterial({ color, transparent: true, opacity: 0.85 })));
      d += spacing;
    }
    carry = d - segLen;
  }
}

/** Mirror of the navigation graph's parallelLanePositions offset so the drawn lanes sit where robots drive. */
function aisleLaneOffset(width: number): number {
  const safeEdgeMargin = Math.max(0.45, width * 0.16);
  const maxOffset = Math.max(0.55, width / 2 - safeEdgeMargin);
  return Math.min(Math.max(width * 0.34, 0.8), maxOffset, 1.75);
}

/** Draw one drivable lane as a translucent corridor band + centreline + direction chevrons. */
function addAisleLane(group: Group, xStart: number, xEnd: number, z: number, color: string, dir: 1 | -1, bandWidth: number) {
  const length = xEnd - xStart;
  const midX = (xStart + xEnd) / 2;

  // Corridor band showing the lane's drivable width.
  const band = new Mesh(
    new PlaneGeometry(length, bandWidth),
    new MeshBasicMaterial({ color, transparent: true, opacity: 0.16, side: DoubleSide, depthWrite: false })
  );
  band.position.set(midX, 0.045, z);
  band.rotation.x = -Math.PI / 2;
  group.add(band);

  // Bright centreline.
  const linePts = [xStart, 0.05, z, xEnd, 0.05, z];
  const lineGeo = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(linePts, 3));
  group.add(new Line(lineGeo, new LineBasicMaterial({ color, transparent: true, opacity: 0.85 })));

  // Direction chevrons.
  const spacing = 4.2;
  const wing = Math.min(0.5, bandWidth * 0.45);
  for (let x = xStart + spacing * 0.5; x < xEnd; x += spacing) {
    const tipX = x + dir * 0.6;
    const pts = [
      x - dir * 0.2, 0.06, z - wing,
      tipX, 0.06, z,
      x - dir * 0.2, 0.06, z + wing,
    ];
    const geo = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(pts, 3));
    group.add(new Line(geo, new LineBasicMaterial({ color, transparent: true, opacity: 0.7 })));
  }
}

/**
 * Floating charge "loading bar" above a charging robot: amber frame, fill width
 * proportional to the battery level, plus a pulsing dot so the progress reads as live.
 */
function addChargingProgressMarker(group: Group, center: Vec2, pct: number) {
  const color = "#f5c542";
  const barWidth = 1.7;
  const barDepth = 0.26;
  const y = 2.7;

  const back = new Mesh(
    new PlaneGeometry(barWidth, barDepth),
    new MeshBasicMaterial({ color: "#22303c", transparent: true, opacity: 0.8, side: DoubleSide, depthWrite: false })
  );
  back.position.set(center.x, y, center.z);
  back.rotation.x = -Math.PI / 2;
  group.add(back);

  const fillWidth = Math.max(0.04, barWidth * pct);
  const fill = new Mesh(
    new PlaneGeometry(fillWidth, barDepth * 0.62),
    new MeshBasicMaterial({ color, transparent: true, opacity: 0.95, side: DoubleSide, depthWrite: false })
  );
  fill.position.set(center.x - (barWidth - fillWidth) / 2, y + 0.01, center.z);
  fill.rotation.x = -Math.PI / 2;
  group.add(fill);

  const framePts = [
    center.x - barWidth / 2, y + 0.012, center.z - barDepth / 2,
    center.x + barWidth / 2, y + 0.012, center.z - barDepth / 2,
    center.x + barWidth / 2, y + 0.012, center.z + barDepth / 2,
    center.x - barWidth / 2, y + 0.012, center.z + barDepth / 2,
    center.x - barWidth / 2, y + 0.012, center.z - barDepth / 2,
  ];
  const frameGeo = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(framePts, 3));
  group.add(new Line(frameGeo, new LineBasicMaterial({ color, transparent: true, opacity: 0.9 })));

  // Lightning-bolt style pulse dot beside the bar.
  const pulse = 0.55 + 0.45 * Math.abs(Math.sin(performance.now() / 320));
  const dot = new Mesh(
    new PlaneGeometry(0.22, 0.22),
    new MeshBasicMaterial({ color, transparent: true, opacity: pulse, side: DoubleSide, depthWrite: false })
  );
  dot.position.set(center.x + barWidth / 2 + 0.28, y, center.z);
  dot.rotation.x = -Math.PI / 2;
  dot.rotation.z = Math.PI / 4;
  group.add(dot);
}

/** Small amber ring + dot above a robot held by the startup dispatch controller. */
function addLaunchHoldMarker(group: Group, center: Vec2, radius: number) {
  const color = "#f5a623";
  const segments = 22;
  const pts: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(center.x + Math.cos(a) * radius, 0.22, center.z + Math.sin(a) * radius);
  }
  const geo = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(pts, 3));
  group.add(new Line(geo, new LineBasicMaterial({ color, transparent: true, opacity: 0.75 })));

  const dot = new Mesh(
    new PlaneGeometry(0.34, 0.34),
    new MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: DoubleSide, depthWrite: false })
  );
  dot.position.set(center.x, 2.4, center.z);
  dot.rotation.x = -Math.PI / 2;
  group.add(dot);
}

function addSafetyEnvelope(group: Group, center: Vec2, radius: number, color: string) {
  const segments = 28;
  const pts: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(center.x + Math.cos(a) * radius, 0.18, center.z + Math.sin(a) * radius);
  }
  const geo = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(pts, 3));
  group.add(new Line(geo, new LineBasicMaterial({ color, transparent: true, opacity: 0.5 })));
}

export function updateHeatmap(congestionMap: Map<string, number>, show: boolean) {
  if (!sceneState) return;
  clearGroup(sceneState.heatmapGroup);
  if (!show) return;

  let maxVal = 1;
  for (const v of congestionMap.values()) {
    if (v > maxVal) maxVal = v;
  }

  for (const [key, val] of congestionMap) {
    const parts = key.split("_");
    if (parts.length < 2) continue;
    const z = parseFloat(parts[1]) * 3;
    const intensity = val / maxVal;
    const r = Math.floor(255 * intensity);
    const g = Math.floor(80 * (1 - intensity));
    const color = `rgb(${r},${g},30)`;
    const geo = new BufferGeometry().setAttribute("position",
      new Float32BufferAttribute([-30, 0.06, z - 1, 30, 0.06, z - 1, 30, 0.06, z + 1, -30, 0.06, z + 1], 3)
    );
    const line = new Line(geo, new LineBasicMaterial({ color, transparent: true, opacity: 0.4 * intensity }));
    sceneState.heatmapGroup.add(line);
  }
}

export function updateLaneGeometry(scenario: WarehouseScenario, robots: RobotRuntime[]) {
  if (!sceneState) return;
  clearGroup(sceneState.laneGeometryGroup);
  if (!scenario.simulation.showLaneGeometry) return;

  const group = sceneState.laneGeometryGroup;
  const ext = computeWarehouseExtents(scenario);
  const { racks } = scenario;
  const pairCount = Math.ceil(racks.rowCount / 2);

  const occupiedCells = new Set<string>();
  for (const robot of robots) {
    occupiedCells.add(`${Math.round(robot.position.x * 2)}:${Math.round(robot.position.z * 2)}`);
  }

  for (let pair = 0; pair < pairCount; pair++) {
    const aisleZ = ext.rackBlockStartZ + pair * racks.rowPitch + racks.rowPitch / 2;
    const halfWidth = racks.aisleWidth / 2;
    const xStart = ext.rackBlockStartX;
    const xEnd = ext.rackBlockStartX + ext.rackBlockWidth;

    const laneConfig = scenario.simulation.aisleLanes.find(l => l.aisleIndex === pair);
    const isOneWay = laneConfig && laneConfig.direction !== "two-way";
    const lanePositions = visualLanePair(aisleZ, racks.aisleWidth, scenario);
    const bandWidth = Math.max(0.8, scenario.robots.footprintWidth);

    if (isOneWay) {
      // Single drivable lane down the centre (no opposing traffic permitted).
      const dir = laneConfig!.direction === "one-way-reverse" ? -1 : 1;
      addAisleLane(group, xStart, xEnd, aisleZ, "#f5b942", dir, bandWidth);
    } else if (lanePositions.length < 2) {
      addAisleLane(group, xStart, xEnd, aisleZ, "#2ee6a6", 1, bandWidth);
    } else {
      // Two separated travel lanes, one per direction, spaced wider than a robot.
      addAisleLane(group, xStart, xEnd, lanePositions[0], "#2ee6a6", 1, bandWidth);
      addAisleLane(group, xStart, xEnd, lanePositions[1], "#2ee6a6", -1, bandWidth);
    }

    // Faint aisle boundary edges (kerb lines).
    const topPoints = [xStart, 0.03, aisleZ - halfWidth, xEnd, 0.03, aisleZ - halfWidth];
    const topGeo = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(topPoints, 3));
    group.add(new Line(topGeo, new LineBasicMaterial({ color: "#3a4a59", transparent: true, opacity: 0.3 })));

    const botPoints = [xStart, 0.03, aisleZ + halfWidth, xEnd, 0.03, aisleZ + halfWidth];
    const botGeo = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(botPoints, 3));
    group.add(new Line(botGeo, new LineBasicMaterial({ color: "#3a4a59", transparent: true, opacity: 0.3 })));
  }

  const yieldBays = getYieldBays();
  for (const bay of yieldBays) {
    const color = bay.occupied ? "#ff4444" : "#44ff88";
    const size = 0.4;
    const pts = [
      bay.position.x - size, 0.05, bay.position.z - size,
      bay.position.x + size, 0.05, bay.position.z - size,
      bay.position.x + size, 0.05, bay.position.z + size,
      bay.position.x - size, 0.05, bay.position.z + size,
      bay.position.x - size, 0.05, bay.position.z - size,
    ];
    const geo = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(pts, 3));
    group.add(new Line(geo, new LineBasicMaterial({ color, transparent: true, opacity: 0.7 })));
  }

  const queueSlots = getPhysicalQueueSlots();
  for (const slot of queueSlots) {
    const assigned = slot.assignedRobotId !== undefined;
    const color = assigned ? "#ffaa22" : "#22aaff";
    const size = 0.3;
    const pts = [
      slot.position.x - size, 0.05, slot.position.z - size,
      slot.position.x + size, 0.05, slot.position.z - size,
      slot.position.x + size, 0.05, slot.position.z + size,
      slot.position.x - size, 0.05, slot.position.z + size,
      slot.position.x - size, 0.05, slot.position.z - size,
    ];
    const geo = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(pts, 3));
    group.add(new Line(geo, new LineBasicMaterial({ color, transparent: true, opacity: 0.6 })));

    if (assigned) {
      const cross1 = [
        slot.position.x - size * 0.6, 0.06, slot.position.z - size * 0.6,
        slot.position.x + size * 0.6, 0.06, slot.position.z + size * 0.6,
      ];
      const cross2 = [
        slot.position.x + size * 0.6, 0.06, slot.position.z - size * 0.6,
        slot.position.x - size * 0.6, 0.06, slot.position.z + size * 0.6,
      ];
      const g1 = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(cross1, 3));
      const g2 = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(cross2, 3));
      group.add(new Line(g1, new LineBasicMaterial({ color: "#ffaa22", transparent: true, opacity: 0.5 })));
      group.add(new Line(g2, new LineBasicMaterial({ color: "#ffaa22", transparent: true, opacity: 0.5 })));
    }
  }

  for (const robot of robots) {
    if (robot.state !== "idle" && robot.state !== "charging") continue;
    const size = 0.35;
    const pts = [
      robot.homePosition.x - size, 0.04, robot.homePosition.z - size,
      robot.homePosition.x + size, 0.04, robot.homePosition.z - size,
      robot.homePosition.x + size, 0.04, robot.homePosition.z + size,
      robot.homePosition.x - size, 0.04, robot.homePosition.z + size,
      robot.homePosition.x - size, 0.04, robot.homePosition.z - size,
    ];
    const geo = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(pts, 3));
    group.add(new Line(geo, new LineBasicMaterial({ color: "#8866cc", transparent: true, opacity: 0.5 })));
  }

  const parkingBays = getParkingBays();
  for (const bay of parkingBays) {
    const stateColors: Record<string, string> = {
      free: "#22cc55",
      reserved: "#ccaa22",
      occupied: "#3388ff",
      blocked: "#cc3333",
    };
    const color = stateColors[bay.state] ?? "#555555";
    const opacity = bay.state === "free" ? 0.35 : 0.65;
    const size = 0.45;

    const outer = [
      bay.position.x - size, 0.03, bay.position.z - size,
      bay.position.x + size, 0.03, bay.position.z - size,
      bay.position.x + size, 0.03, bay.position.z + size,
      bay.position.x - size, 0.03, bay.position.z + size,
      bay.position.x - size, 0.03, bay.position.z - size,
    ];
    const outerGeo = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(outer, 3));
    group.add(new Line(outerGeo, new LineBasicMaterial({ color, transparent: true, opacity })));

    const inner = [
      bay.position.x - size * 0.55, 0.035, bay.position.z - size * 0.55,
      bay.position.x + size * 0.55, 0.035, bay.position.z - size * 0.55,
      bay.position.x + size * 0.55, 0.035, bay.position.z + size * 0.55,
      bay.position.x - size * 0.55, 0.035, bay.position.z + size * 0.55,
      bay.position.x - size * 0.55, 0.035, bay.position.z - size * 0.55,
    ];
    const innerGeo = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(inner, 3));
    group.add(new Line(innerGeo, new LineBasicMaterial({ color, transparent: true, opacity: opacity * 0.6 })));

    if (bay.state === "occupied") {
      const dot = [
        bay.position.x - 0.08, 0.04, bay.position.z,
        bay.position.x + 0.08, 0.04, bay.position.z,
      ];
      const dotGeo = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(dot, 3));
      group.add(new Line(dotGeo, new LineBasicMaterial({ color: "#3388ff", transparent: true, opacity: 0.8 })));
    }

    if (bay.state === "blocked") {
      const x1 = [
        bay.position.x - size * 0.7, 0.04, bay.position.z - size * 0.7,
        bay.position.x + size * 0.7, 0.04, bay.position.z + size * 0.7,
      ];
      const x2 = [
        bay.position.x + size * 0.7, 0.04, bay.position.z - size * 0.7,
        bay.position.x - size * 0.7, 0.04, bay.position.z + size * 0.7,
      ];
      const xGeo1 = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(x1, 3));
      const xGeo2 = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(x2, 3));
      group.add(new Line(xGeo1, new LineBasicMaterial({ color: "#cc3333", transparent: true, opacity: 0.6 })));
      group.add(new Line(xGeo2, new LineBasicMaterial({ color: "#cc3333", transparent: true, opacity: 0.6 })));
    }

    const labelTex = makeParkingBayLabelTexture(bay.id, bay.state);
    const labelGeo = new PlaneGeometry(0.85, 0.42);
    const labelMat = new MeshBasicMaterial({ map: labelTex, transparent: true, opacity: 0.75, side: DoubleSide });
    const labelMesh = new Mesh(labelGeo, labelMat);
    labelMesh.position.set(bay.position.x, 0.045, bay.position.z);
    labelMesh.rotation.x = -Math.PI / 2;
    group.add(labelMesh);
  }

  // Depot entry/exit lanes: one vertical service lane per parking column in the front
  // depot, from the deepest bay up to the main-aisle edge. Drawn symmetrically for the
  // Pack A and Pack B sides so the launch/return corridors robots actually use are visible.
  const mainAisleEdgeZ = ext.mainAisleZ - racks.mainAisleWidth / 2;
  const frontBays = parkingBays.filter(b => b.position.z < mainAisleEdgeZ);
  const columns = new Map<number, { minZ: number; maxZ: number }>();
  for (const bay of frontBays) {
    const key = Math.round(bay.position.x * 10) / 10;
    const entry = columns.get(key);
    if (!entry) columns.set(key, { minZ: bay.position.z, maxZ: bay.position.z });
    else {
      entry.minZ = Math.min(entry.minZ, bay.position.z);
      entry.maxZ = Math.max(entry.maxZ, bay.position.z);
    }
  }
  const laneWidth = scenario.robots.footprintWidth + (scenario.simulation.robotClearanceMeters ?? 0.12) * 2;
  for (const [x, span] of columns) {
    const zFrom = span.minZ - 0.9;
    const zTo = ext.mainAisleZ + racks.mainAisleWidth / 2;
    const length = zTo - zFrom;
    if (length <= 0.5) continue;

    const band = new Mesh(
      new PlaneGeometry(laneWidth, length),
      new MeshBasicMaterial({ color: "#3fd1ff", transparent: true, opacity: 0.10, side: DoubleSide, depthWrite: false })
    );
    band.position.set(x, 0.04, (zFrom + zTo) / 2);
    band.rotation.x = -Math.PI / 2;
    group.add(band);

    const edges = [x - laneWidth / 2, x + laneWidth / 2];
    for (const ex of edges) {
      const pts = [ex, 0.042, zFrom, ex, 0.042, zTo];
      const geo = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(pts, 3));
      group.add(new Line(geo, new LineBasicMaterial({ color: "#3fd1ff", transparent: true, opacity: 0.35 })));
    }

    // Exit chevrons pointing toward the main aisle.
    for (let z = zFrom + 1.4; z < zTo - 0.6; z += 2.4) {
      const wing = laneWidth * 0.32;
      const pts = [x - wing, 0.043, z - 0.45, x, 0.043, z, x + wing, 0.043, z - 0.45];
      const geo = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(pts, 3));
      group.add(new Line(geo, new LineBasicMaterial({ color: "#3fd1ff", transparent: true, opacity: 0.45 })));
    }
  }
}

export function setCameraPreset(
  preset: "overview" | "aisle" | "top-down" | "follow" | "robot-camera",
  target?: { x: number; z: number; heading?: number }
) {
  if (!sceneState) return;
  const { camera, controls } = sceneState;
  switch (preset) {
    case "overview":
      activeRobotCamera = null;
      camera.position.set(44, 42, 54);
      controls.target.set(0, 1.2, 0);
      break;
    case "aisle":
      activeRobotCamera = null;
      camera.position.set(0, 3, 8);
      controls.target.set(0, 2, 0);
      break;
    case "top-down":
      activeRobotCamera = null;
      camera.position.set(0, 60, 0.1);
      controls.target.set(0, 0, 0);
      break;
    case "follow":
      if (target) {
        activeRobotCamera = null;
        camera.position.set(target.x + 8, 8, target.z + 8);
        controls.target.set(target.x, 1, target.z);
      }
      break;
    case "robot-camera":
      if (target) {
        activeRobotCamera = null;
        applyRobotCamera({ id: 0, position: target, heading: target.heading ?? 0 } as RobotRuntime, "robot-camera");
      }
      break;
  }
  controls.update();
}

export function setRobotCamera(robotId: number, mode: RobotCameraMode) {
  activeRobotCamera = { robotId, mode };
}

export function getActiveRobotCamera(): { robotId: number; mode: RobotCameraMode } | null {
  return activeRobotCamera;
}

export function clearRobotCamera() {
  activeRobotCamera = null;
  setCameraPreset("overview");
}

function applyRobotCamera(robot: RobotRuntime, mode: RobotCameraMode) {
  if (!sceneState) return;
  const { camera, controls } = sceneState;
  const heading = robot.heading ?? 0;
  const forwardX = Math.sin(heading);
  const forwardZ = Math.cos(heading);
  const rightX = Math.cos(heading);
  const rightZ = -Math.sin(heading);
  if (mode === "robot-camera") {
    camera.position.set(robot.position.x + forwardX * 0.45, 1.1, robot.position.z + forwardZ * 0.45);
    controls.target.set(robot.position.x + forwardX * 8, 1.05, robot.position.z + forwardZ * 8);
  } else if (mode === "follow-close") {
    camera.position.set(robot.position.x - forwardX * 2.9 + rightX * 1.45, 2.35, robot.position.z - forwardZ * 2.9 + rightZ * 1.45);
    controls.target.set(robot.position.x + forwardX * 0.85, 0.9, robot.position.z + forwardZ * 0.85);
  } else if (mode === "lift-close") {
    camera.position.set(robot.position.x + rightX * 2.15 - forwardX * 1.35, 2.25, robot.position.z + rightZ * 2.15 - forwardZ * 1.35);
    controls.target.set(robot.position.x + forwardX * 0.18, 1.55, robot.position.z + forwardZ * 0.18);
  } else if (mode === "payload-side") {
    camera.position.set(robot.position.x + rightX * 3.1 - forwardX * 2.2, 2.8, robot.position.z + rightZ * 3.1 - forwardZ * 2.2);
    controls.target.set(robot.position.x + forwardX * 0.4, 1.1, robot.position.z + forwardZ * 0.4);
  } else {
    camera.position.set(robot.position.x - forwardX * 4 + 2, 4.2, robot.position.z - forwardZ * 4 + 2);
    controls.target.set(robot.position.x, 0.9, robot.position.z);
  }
  controls.update();
}

export function renderFrame() {
  if (!sceneState) return;
  sceneState.controls.update();
  sceneState.renderer.render(sceneState.scene, sceneState.camera);
}

function clearGroup(group: Group) {
  while (group.children.length > 0) {
    const child = group.children[0];
    group.remove(child);
    const disposable = child as Line | LineSegments | Points;
    if ("geometry" in disposable) {
      disposable.geometry.dispose();
    }
    if ("material" in disposable) {
      const material = disposable.material;
      if (Array.isArray(material)) {
        material.forEach(m => m.dispose());
      } else {
        material.dispose();
      }
    }
  }
}

function buildNavigationGraphVisual(graph: NavGraph, target: Group) {
  const edgePoints: number[] = [];
  const seen = new Set<string>();
  for (const node of graph.nodes.values()) {
    for (const neighborId of node.neighbors) {
      const edgeKey = [node.id, neighborId].sort().join("|");
      if (seen.has(edgeKey)) continue;
      const neighbor = graph.nodes.get(neighborId);
      if (!neighbor) continue;
      if (!isPublicTrackEdge(graph, node.position, neighbor.position)) continue;
      seen.add(edgeKey);
      edgePoints.push(node.position.x, 0.08, node.position.z, neighbor.position.x, 0.08, neighbor.position.z);
    }
  }

  if (edgePoints.length > 0) {
    const edgeGeo = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(edgePoints, 3));
    target.add(new LineSegments(edgeGeo, new LineBasicMaterial({ color: "#1ecf66", transparent: true, opacity: 0.34 })));
  }

  const nodePoints: number[] = [];
  for (const node of graph.nodes.values()) {
    if (!isPublicTrackNode(graph, node.position)) continue;
    nodePoints.push(node.position.x, 0.14, node.position.z);
  }
  if (nodePoints.length > 0) {
    const nodeGeo = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(nodePoints, 3));
    target.add(new Points(nodeGeo, new PointsMaterial({ color: "#8fffa6", size: 0.2, transparent: true, opacity: 0.5 })));
  }

  const qrGeo = new PlaneGeometry(0.5, 0.5);
  const qrMaterial = getQrMarkerMaterial();
  let index = 0;
  for (const node of graph.nodes.values()) {
    if (!isPublicTrackNode(graph, node.position)) continue;
    if (index % 8 === 0) {
      const marker = new Mesh(qrGeo, qrMaterial);
      marker.position.set(node.position.x, 0.075, node.position.z);
      marker.rotation.x = -Math.PI / 2;
      target.add(marker);
    }
    index++;
  }
}

function isPublicTrackEdge(graph: NavGraph, a: Vec2, b: Vec2): boolean {
  const scenario = graph.scenario;
  if (!scenario) return true;
  if (!publicTrackSegmentClear(scenario, a, b)) return false;
  const tol = 0.08;
  const horizontal = Math.abs(a.z - b.z) < 0.05;
  const vertical = Math.abs(a.x - b.x) < 0.05;
  if (horizontal) return publicLaneZs(scenario).some(z => Math.abs(a.z - z) < tol);
  if (vertical) return publicCrossAisleXs(scenario).some(x => Math.abs(a.x - x) < tol);
  return false;
}

function isPublicTrackNode(graph: NavGraph, point: Vec2): boolean {
  const scenario = graph.scenario;
  if (!scenario) return true;
  if (!publicTrackPointClear(scenario, point)) return false;
  const tol = 0.08;
  return publicLaneZs(scenario).some(z => Math.abs(point.z - z) < tol) ||
    publicCrossAisleXs(scenario).some(x => Math.abs(point.x - x) < tol);
}

function publicTrackSegmentClear(scenario: WarehouseScenario, a: Vec2, b: Vec2): boolean {
  const clearance = robotRadius(scenario) + (scenario.simulation.robotClearanceMeters ?? 0.12) + 0.18;
  const solids = buildSolidObstacles(scenario, clearance);
  return !pointInsideSolid(a, solids) && !pointInsideSolid(b, solids) && isClearSegment(a, b, solids);
}

function publicTrackPointClear(scenario: WarehouseScenario, point: Vec2): boolean {
  const clearance = robotRadius(scenario) + (scenario.simulation.robotClearanceMeters ?? 0.12) + 0.18;
  return !pointInsideSolid(point, buildSolidObstacles(scenario, clearance));
}

function publicLaneZs(scenario: WarehouseScenario): number[] {
  const ext = computeWarehouseExtents(scenario);
  const { racks } = scenario;
  const pairCount = Math.ceil(racks.rowCount / 2);
  const zValues: number[] = [];
  for (let pair = 0; pair < pairCount; pair++) {
    const aisleZ = ext.rackBlockStartZ + pair * racks.rowPitch + racks.rowPitch / 2;
    zValues.push(...visualLanePair(aisleZ, racks.aisleWidth, scenario));
  }
  zValues.push(...visualLanePair(ext.mainAisleZ, racks.mainAisleWidth, scenario));
  return dedupeByMinimumSpacing(zValues, visualTrackSpacing(scenario));
}

function publicCrossAisleXs(scenario: WarehouseScenario): number[] {
  const ext = computeWarehouseExtents(scenario);
  const { racks } = scenario;
  const xs = [
    ext.rackBlockStartX - 2,
    ext.rackBlockStartX + ext.rackBlockWidth + 2,
  ];
  const every = Math.max(0, Math.floor(racks.crossAisleEveryBays));
  if (every > 0) {
    for (let bay = every; bay < racks.baysPerRow; bay += every) {
      const leftEdge = rackBayBoundaryX(scenario, bay, ext.rackBlockStartX) - racks.crossAisleWidth;
      xs.push(leftEdge + racks.crossAisleWidth / 2);
    }
  }
  return dedupeByMinimumSpacing(xs, visualTrackSpacing(scenario));
}

function visualLanePair(center: number, width: number, scenario: WarehouseScenario): number[] {
  const minSpacing = visualTrackSpacing(scenario);
  const offset = Math.max(aisleLaneOffset(width), minSpacing / 2);
  const edgeMargin = Math.max(0.7, scenario.robots.footprintWidth * 0.45);
  const maxOffset = Math.max(0, width / 2 - edgeMargin);
  const clampedOffset = Math.min(offset, maxOffset);

  // If the physical aisle cannot show two robot-clear guide lanes, render one
  // clean public centerline instead of two misleading cramped lines.
  if (clampedOffset * 2 < minSpacing) return [center];
  return [center - clampedOffset, center + clampedOffset];
}

function visualTrackSpacing(scenario: WarehouseScenario): number {
  const footprint = Math.max(scenario.robots.footprintWidth, scenario.robots.footprintDepth);
  const clearance = scenario.simulation.robotClearanceMeters ?? 0.12;
  return footprint * 1.75 + clearance + 0.55;
}

function dedupeByMinimumSpacing(values: number[], minSpacing: number): number[] {
  const sorted = [...new Set(values.map(value => Number(value.toFixed(4))))].sort((a, b) => a - b);
  const kept: number[] = [];
  for (const value of sorted) {
    if (kept.length === 0 || Math.abs(value - kept[kept.length - 1]) >= minSpacing) {
      kept.push(value);
    }
  }
  return kept;
}

function getQrMarkerMaterial(): MeshBasicMaterial {
  if (qrMarkerMaterial) return qrMarkerMaterial;

  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#f7f7f2";
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = "#111";
  drawFinder(ctx, 4, 4);
  drawFinder(ctx, 42, 4);
  drawFinder(ctx, 4, 42);
  const cells = [
    [28, 10], [34, 10], [28, 18], [38, 22], [22, 30], [30, 30],
    [46, 32], [22, 40], [34, 42], [46, 46], [28, 52], [54, 26],
  ];
  for (const [x, y] of cells) {
    ctx.fillRect(x, y, 6, 6);
  }
  ctx.strokeStyle = "#1ecf66";
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, 61, 61);

  const texture = new CanvasTexture(canvas);
  qrMarkerMaterial = new MeshBasicMaterial({ map: texture, transparent: true });
  return qrMarkerMaterial;
}

function drawFinder(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.fillRect(x, y, 18, 18);
  ctx.fillStyle = "#f7f7f2";
  ctx.fillRect(x + 4, y + 4, 10, 10);
  ctx.fillStyle = "#111";
  ctx.fillRect(x + 7, y + 7, 4, 4);
}
