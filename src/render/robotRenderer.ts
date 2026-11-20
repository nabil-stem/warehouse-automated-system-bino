import {
  Group, Mesh, BoxGeometry, CylinderGeometry, MeshStandardMaterial,
  MeshLambertMaterial, SphereGeometry,
} from "three";
import type { Mission, RobotRuntime, Slot, WarehouseScenario } from "../domain/schema";
import { getRobotColor } from "./materials";
import { makeLabelTexture } from "./labels";
import { boxMaterial } from "./materials";

export type RobotVisual = {
  group: Group;
  liftGroup: Group;
  forkGroup: Group;
  carriedBox: Mesh;
  statusLight?: Mesh;
  statusLightMaterial?: MeshStandardMaterial;
  id: number;
};

const baseDarkMat = new MeshStandardMaterial({ color: "#101317", roughness: 0.45 });
const baseBlueMat = new MeshStandardMaterial({ color: "#12365f", roughness: 0.38, metalness: 0.18 });
const robotAccentMat = new MeshStandardMaterial({ color: "#1f7ae0", roughness: 0.32, metalness: 0.24 });
const scissorArmMat = new MeshStandardMaterial({ color: "#1558a6", roughness: 0.36, metalness: 0.28 });
const blackRubberMat = new MeshStandardMaterial({ color: "#090b0e", roughness: 0.62, metalness: 0.05 });
const whiteStripMat = new MeshStandardMaterial({ color: "#f2f6f8", emissive: "#ffffff", emissiveIntensity: 0.18, roughness: 0.2 });
const forkMat = new MeshStandardMaterial({ color: "#d7dde2", metalness: 0.3, roughness: 0.38 });
const mastRailMat = new MeshStandardMaterial({ color: "#3a4550", metalness: 0.5, roughness: 0.3 });
const toteMat = new MeshStandardMaterial({ color: "#252b31", roughness: 0.54, metalness: 0.04 });
const toteLidMat = new MeshStandardMaterial({ color: "#3d4650", roughness: 0.48, metalness: 0.08 });
const hydraulicMat = new MeshStandardMaterial({ color: "#c8d0d6", metalness: 0.65, roughness: 0.22 });
const sensorBlackMat = new MeshStandardMaterial({ color: "#05070a", roughness: 0.26, metalness: 0.12 });
const warningYellowMat = new MeshStandardMaterial({ color: "#f5c542", emissive: "#9b6f00", emissiveIntensity: 0.18, roughness: 0.35 });

export function createProceduralRobot(id: number, scenario: WarehouseScenario): RobotVisual {
  const visualType = scenario.robots.visualType ?? "compact-lift";
  switch (visualType) {
    case "scissor-lift": return createScissorLiftRobot(id, scenario);
    case "stacker-amr": return createStackerAMR(id, scenario);
    case "tote-carrier": return createToteCarrier(id, scenario);
    default: return createCompactLift(id, scenario);
  }
}

function createScissorLiftRobot(id: number, scenario: WarehouseScenario): RobotVisual {
  const group = new Group();
  group.name = `robot-${id}`;

  const fw = scenario.robots.footprintWidth;
  const fd = scenario.robots.footprintDepth;
  const bh = scenario.robots.bodyHeight;

  const base = new Mesh(new BoxGeometry(fw, bh * 0.62, fd * 1.08), blackRubberMat);
  base.position.y = bh * 0.31;
  base.castShadow = true;
  group.add(base);

  const roundedFront = new Mesh(new CylinderGeometry(fw * 0.5, fw * 0.5, fd * 1.05, 28, 1, false, 0, Math.PI), blackRubberMat);
  roundedFront.rotation.z = Math.PI / 2;
  roundedFront.rotation.y = Math.PI / 2;
  roundedFront.position.set(0, bh * 0.31, -fd * 0.52);
  roundedFront.castShadow = true;
  group.add(roundedFront);

  const topDeck = new Mesh(new BoxGeometry(fw * 1.04, 0.16, fd * 1.08), robotAccentMat);
  topDeck.position.y = bh * 0.72;
  topDeck.castShadow = true;
  group.add(topDeck);

  const rearCover = new Mesh(new BoxGeometry(fw * 0.96, 0.26, fd * 0.22), robotAccentMat);
  rearCover.position.set(0, bh * 0.86, fd * 0.38);
  rearCover.castShadow = true;
  group.add(rearCover);

  const frontApron = new Mesh(new BoxGeometry(fw * 1.08, 0.28, 0.1), robotAccentMat);
  frontApron.position.set(0, bh * 0.64, -fd * 0.58);
  frontApron.castShadow = true;
  group.add(frontApron);

  for (const side of [-1, 1]) {
    const sidePanel = new Mesh(new BoxGeometry(0.055, 0.22, fd * 0.82), robotAccentMat);
    sidePanel.position.set(side * fw * 0.54, bh * 0.73, -fd * 0.02);
    sidePanel.castShadow = true;
    group.add(sidePanel);

    const rail = new Mesh(new BoxGeometry(0.035, 0.05, fd * 0.84), forkMat);
    rail.position.set(side * fw * 0.46, bh * 0.98, -fd * 0.02);
    rail.castShadow = true;
    group.add(rail);
  }

  addScissorBaseDetails(group, fw, fd, bh);

  for (const x of [-fw * 0.26, fw * 0.26]) {
    const strip = new Mesh(new BoxGeometry(fw * 0.32, 0.035, 0.025), whiteStripMat);
    strip.position.set(x, bh * 0.75, -fd * 0.64);
    group.add(strip);
  }

  for (const xSide of [-1, 1]) {
    for (const zSide of [-1, 1]) {
      group.add(createMecanumWheel(xSide * fw * 0.42, zSide * fd * 0.42, zSide > 0 ? 1 : -1));
    }
  }

  const liftGroup = new Group();
  const scissorGroup = new Group();
  scissorGroup.name = "scissor-arms";
  scissorGroup.position.y = bh * 0.86;
  for (let stageIndex = 0; stageIndex < 3; stageIndex++) {
    const stageGroup = new Group();
    stageGroup.name = `scissor-stage-${stageIndex + 1}`;
    stageGroup.userData.stageIndex = stageIndex;
    stageGroup.userData.baseY = stageIndex * 0.14;
    stageGroup.position.y = stageGroup.userData.baseY;
    addScissorStage(stageGroup, fw, fd, stageIndex % 2 === 0 ? 0 : 0.16);
    scissorGroup.add(stageGroup);
  }
  addHydraulicAssist(scissorGroup, fw, fd, bh);
  group.add(scissorGroup);

  const platform = new Mesh(new BoxGeometry(fw * 1.08, 0.14, fd * 1.02), robotAccentMat);
  platform.position.y = bh * 0.88;
  platform.castShadow = true;
  liftGroup.add(platform);

  const platformTop = new Mesh(new BoxGeometry(fw * 0.86, 0.035, fd * 0.76), forkMat);
  platformTop.position.y = bh * 0.97;
  platformTop.castShadow = true;
  liftGroup.add(platformTop);
  addLiftDeckDetails(liftGroup, fw, fd, bh);

  const pusherBase = new Mesh(new BoxGeometry(fw * 0.28, 0.28, 0.12), robotAccentMat);
  pusherBase.position.set(-fw * 0.28, bh * 1.06, -fd * 0.42);
  pusherBase.castShadow = true;
  liftGroup.add(pusherBase);

  const pusherArm = new Mesh(new BoxGeometry(0.06, 0.06, fd * 0.42), scissorArmMat);
  pusherArm.position.set(-fw * 0.12, bh * 1.08, -fd * 0.58);
  pusherArm.rotation.y = -0.35;
  liftGroup.add(pusherArm);

  const forkGroup = new Group();
  const frontLip = new Mesh(new BoxGeometry(fw * 0.92, 0.06, 0.08), forkMat);
  frontLip.position.set(0, bh * 0.98, -fd * 0.56);
  forkGroup.add(frontLip);

  for (const x of [-fw * 0.24, fw * 0.24]) {
    const fork = new Mesh(new BoxGeometry(0.08, 0.045, fd * 0.62), forkMat);
    fork.position.set(x, bh * 0.99, -fd * 0.64);
    fork.castShadow = true;
    forkGroup.add(fork);
  }
  liftGroup.add(forkGroup);
  group.add(liftGroup);

  const carriedBox = createCarriedPayloadMesh(scenario, fw * 0.92, 0.52, fd * 0.72);
  carriedBox.position.set(0, bh + 0.36, -fd * 0.04);
  carriedBox.visible = false;
  group.add(carriedBox);

  addScissorRobotLabel(group, id, fw, fd, bh);
  const statusLight = addStatusLight(group, fw, bh * 0.7, fd);

  return { group, liftGroup, forkGroup, carriedBox, statusLight, statusLightMaterial: statusLight.material as MeshStandardMaterial, id };
}

function addScissorBaseDetails(group: Group, fw: number, fd: number, bh: number) {
  const camera = new Mesh(new BoxGeometry(fw * 0.2, 0.1, 0.06), sensorBlackMat);
  camera.position.set(0, bh * 0.93, -fd * 0.67);
  group.add(camera);

  const lens = new Mesh(new CylinderGeometry(0.035, 0.035, 0.025, 14), hydraulicMat);
  lens.rotation.x = Math.PI / 2;
  lens.position.set(0, bh * 0.93, -fd * 0.715);
  group.add(lens);

  const qrScanner = new Mesh(new BoxGeometry(fw * 0.28, 0.035, 0.12), sensorBlackMat);
  qrScanner.position.set(0, 0.08, -fd * 0.22);
  qrScanner.rotation.x = -0.08;
  group.add(qrScanner);

  const beacon = new Mesh(new CylinderGeometry(0.045, 0.055, 0.08, 12), warningYellowMat);
  beacon.position.set(fw * 0.36, bh * 1.04, fd * 0.35);
  group.add(beacon);

  for (const side of [-1, 1]) {
    const baseRail = new Mesh(new BoxGeometry(0.05, 0.08, fd * 0.72), mastRailMat);
    baseRail.position.set(side * fw * 0.31, bh * 0.88, 0);
    group.add(baseRail);
  }
}

function addHydraulicAssist(scissorGroup: Group, fw: number, fd: number, bh: number) {
  const cylinderGroup = new Group();
  cylinderGroup.name = "hydraulic-assist";
  cylinderGroup.position.y = bh * 0.88;
  for (const side of [-1, 1]) {
    const barrel = new Mesh(new BoxGeometry(0.055, 0.48, 0.055), mastRailMat);
    barrel.position.set(side * fw * 0.2, 0.18, -fd * 0.28);
    barrel.rotation.z = side * -0.45;
    cylinderGroup.add(barrel);

    const rod = new Mesh(new BoxGeometry(0.035, 0.6, 0.035), hydraulicMat);
    rod.name = "hydraulic-rod";
    rod.userData.side = side;
    rod.position.set(side * fw * 0.3, 0.42, -fd * 0.28);
    rod.rotation.z = side * -0.45;
    cylinderGroup.add(rod);
  }
  scissorGroup.add(cylinderGroup);
}

function addLiftDeckDetails(liftGroup: Group, fw: number, fd: number, bh: number) {
  for (const side of [-1, 1]) {
    const guard = new Mesh(new BoxGeometry(0.04, 0.28, fd * 0.92), robotAccentMat);
    guard.position.set(side * fw * 0.5, bh * 1.12, -fd * 0.02);
    liftGroup.add(guard);

    const guideRoller = new Mesh(new CylinderGeometry(0.045, 0.045, 0.06, 14), hydraulicMat);
    guideRoller.rotation.z = Math.PI / 2;
    guideRoller.position.set(side * fw * 0.43, bh * 0.88, fd * 0.36);
    liftGroup.add(guideRoller);
  }

  for (let i = 0; i < 3; i++) {
    const marker = new Mesh(new BoxGeometry(0.055, 0.035, 0.11), i === 2 ? warningYellowMat : whiteStripMat);
    marker.position.set(-fw * 0.42 + i * fw * 0.11, bh * 1.1, fd * 0.5);
    liftGroup.add(marker);
  }
}

function createMecanumWheel(x: number, z: number, rollerDirection: number): Group {
  const wheelGroup = new Group();
  wheelGroup.name = "mecanum-wheel";
  wheelGroup.position.set(x, 0.13, z);

  const tire = new Mesh(new CylinderGeometry(0.13, 0.13, 0.12, 18), blackRubberMat);
  tire.rotation.z = Math.PI / 2;
  tire.castShadow = true;
  wheelGroup.add(tire);

  const hub = new Mesh(new CylinderGeometry(0.07, 0.07, 0.135, 14), forkMat);
  hub.rotation.z = Math.PI / 2;
  wheelGroup.add(hub);

  for (let i = 0; i < 8; i++) {
    const angle = (Math.PI * 2 * i) / 8;
    const roller = new Mesh(new CylinderGeometry(0.022, 0.022, 0.13, 8), mastRailMat);
    roller.position.set(0, Math.sin(angle) * 0.105, Math.cos(angle) * 0.105);
    roller.rotation.x = Math.PI / 2;
    roller.rotation.z = rollerDirection * Math.PI / 4;
    wheelGroup.add(roller);
  }

  return wheelGroup;
}

function addScissorStage(group: Group, fw: number, fd: number, zOffset: number) {
  const armLength = fw * 0.92;
  const armThickness = 0.07;
  for (const z of [-fd * 0.22 + zOffset, fd * 0.22 - zOffset]) {
    const armA = new Mesh(new BoxGeometry(armLength, armThickness, armThickness), scissorArmMat);
    armA.position.set(0, 0, z);
    armA.rotation.z = 0.28;
    armA.userData.scissorDirection = 1;
    armA.castShadow = true;
    group.add(armA);

    const armB = new Mesh(new BoxGeometry(armLength, armThickness, armThickness), scissorArmMat);
    armB.position.set(0, 0, z);
    armB.rotation.z = -0.28;
    armB.userData.scissorDirection = -1;
    armB.castShadow = true;
    group.add(armB);

    const pivot = new Mesh(new CylinderGeometry(0.045, 0.045, 0.035, 12), forkMat);
    pivot.rotation.x = Math.PI / 2;
    pivot.position.set(0, 0, z);
    group.add(pivot);

    for (const x of [-armLength * 0.42, armLength * 0.42]) {
      const endPivot = new Mesh(new CylinderGeometry(0.032, 0.032, 0.04, 10), hydraulicMat);
      endPivot.rotation.x = Math.PI / 2;
      endPivot.position.set(x, 0, z);
      group.add(endPivot);
    }
  }

  const crossTie = new Mesh(new BoxGeometry(fw * 0.72, 0.035, 0.035), mastRailMat);
  crossTie.position.set(0, 0, 0);
  group.add(crossTie);
}

function createCompactLift(id: number, scenario: WarehouseScenario): RobotVisual {
  const color = getRobotColor(id);
  const group = new Group();
  group.name = `robot-${id}`;

  const fw = scenario.robots.footprintWidth;
  const fd = scenario.robots.footprintDepth;
  const bh = scenario.robots.bodyHeight;

  const base = new Mesh(new BoxGeometry(fw, bh, fd), baseDarkMat);
  base.position.y = bh / 2;
  base.castShadow = true;
  group.add(base);

  const shell = new Mesh(
    new CylinderGeometry(fw * 0.48, fw * 0.52, bh * 0.5, 24),
    new MeshStandardMaterial({ color: "#101317", roughness: 0.35 })
  );
  shell.rotation.x = Math.PI / 2;
  shell.position.y = bh * 0.6;
  shell.castShadow = true;
  group.add(shell);

  const lidar = new Mesh(
    new CylinderGeometry(0.08, 0.08, 0.15, 12),
    new MeshStandardMaterial({ color: "#333" })
  );
  lidar.position.set(0, bh + 0.08, -fd * 0.35);
  group.add(lidar);

  addLEDStrips(group, fw, fd, bh, color);
  const statusLight = addStatusLight(group, fw, bh, fd);

  const liftGroup = new Group();
  const liftMat = new MeshStandardMaterial({ color, roughness: 0.42 });
  const liftPlatform = new Mesh(new BoxGeometry(fw * 0.9, 0.18, fd * 0.85), liftMat);
  liftPlatform.position.y = bh + 0.1;
  liftGroup.add(liftPlatform);

  const showMast = scenario.robots.showMast ?? true;
  if (showMast) {
    addMastRails(liftGroup, fw, fd, bh, 1.2, color);
  }

  const forkGroup = new Group();
  addForks(forkGroup, fw, fd, bh);
  liftGroup.add(forkGroup);
  group.add(liftGroup);

  addLabel(group, id, color, fw, fd, bh);

  const carriedBox = createCarriedPayloadMesh(scenario, fw * 0.6, 0.45, fd * 0.5);
  carriedBox.position.set(0, bh + 0.4, -fd * 0.6);
  carriedBox.visible = false;
  group.add(carriedBox);

  return { group, liftGroup, forkGroup, carriedBox, statusLight, statusLightMaterial: statusLight.material as MeshStandardMaterial, id };
}

function createStackerAMR(id: number, scenario: WarehouseScenario): RobotVisual {
  const color = getRobotColor(id);
  const group = new Group();
  group.name = `robot-${id}`;

  const fw = scenario.robots.footprintWidth;
  const fd = scenario.robots.footprintDepth;
  const bh = scenario.robots.bodyHeight;
  const mastHeight = Math.min(scenario.robots.liftMaxHeight, 4.0);

  const base = new Mesh(new BoxGeometry(fw, bh * 0.7, fd * 1.1), baseBlueMat);
  base.position.y = bh * 0.35;
  base.castShadow = true;
  group.add(base);

  const topCover = new Mesh(
    new BoxGeometry(fw * 0.85, bh * 0.35, fd * 0.9),
    new MeshStandardMaterial({ color: "#0d1520", roughness: 0.35, metalness: 0.1 })
  );
  topCover.position.y = bh * 0.52;
  topCover.castShadow = true;
  group.add(topCover);

  for (const xSide of [-1, 1]) {
    for (const zSide of [-1, 1]) {
      const wheel = new Mesh(
        new CylinderGeometry(0.1, 0.1, 0.08, 12),
        new MeshStandardMaterial({ color: "#222", roughness: 0.8 })
      );
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(xSide * fw * 0.42, 0.1, zSide * fd * 0.4);
      group.add(wheel);
    }
  }

  const lidar = new Mesh(
    new CylinderGeometry(0.1, 0.1, 0.12, 16),
    new MeshStandardMaterial({ color: "#1a1a2e", roughness: 0.3, metalness: 0.4 })
  );
  lidar.position.set(0, bh * 0.7, -fd * 0.4);
  group.add(lidar);

  addLEDStrips(group, fw, fd, bh, color);
  const statusLight = addStatusLight(group, fw, bh, fd);

  const liftGroup = new Group();

  const showMast = scenario.robots.showMast ?? true;
  if (showMast) {
    for (const xOff of [-fw * 0.38, fw * 0.38]) {
      const rail = new Mesh(new BoxGeometry(0.06, mastHeight, 0.06), mastRailMat);
      rail.position.set(xOff, bh + mastHeight / 2, -fd * 0.35);
      rail.castShadow = true;
      liftGroup.add(rail);

      const crossCount = Math.max(2, Math.floor(mastHeight / 0.8));
      for (let i = 0; i < crossCount; i++) {
        const crossY = bh + 0.3 + i * (mastHeight / crossCount);
        const cross = new Mesh(new BoxGeometry(0.03, 0.03, 0.04), mastRailMat);
        cross.position.set(xOff, crossY, -fd * 0.35);
        liftGroup.add(cross);
      }
    }

    const mastCross = new Mesh(
      new BoxGeometry(fw * 0.76 + 0.06, 0.04, 0.04),
      mastRailMat
    );
    mastCross.position.set(0, bh + mastHeight, -fd * 0.35);
    liftGroup.add(mastCross);
  }

  const carriageMat = new MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.2 });
  const carriage = new Mesh(new BoxGeometry(fw * 0.8, 0.14, fd * 0.15), carriageMat);
  carriage.position.set(0, bh + 0.15, -fd * 0.45);
  liftGroup.add(carriage);

  const forkGroup = new Group();
  addForks(forkGroup, fw, fd, bh);
  liftGroup.add(forkGroup);
  group.add(liftGroup);

  addLabel(group, id, color, fw, fd, bh);

  const carriedBox = createCarriedPayloadMesh(scenario, fw * 0.6, 0.45, fd * 0.5);
  carriedBox.position.set(0, bh + 0.4, -fd * 0.6);
  carriedBox.visible = false;
  group.add(carriedBox);

  return { group, liftGroup, forkGroup, carriedBox, statusLight, statusLightMaterial: statusLight.material as MeshStandardMaterial, id };
}

function createToteCarrier(id: number, scenario: WarehouseScenario): RobotVisual {
  const color = getRobotColor(id);
  const group = new Group();
  group.name = `robot-${id}`;

  const fw = scenario.robots.footprintWidth;
  const fd = scenario.robots.footprintDepth;
  const bh = scenario.robots.bodyHeight;

  const base = new Mesh(new BoxGeometry(fw, bh * 0.6, fd), baseBlueMat);
  base.position.y = bh * 0.3;
  base.castShadow = true;
  group.add(base);

  const tray = new Mesh(
    new BoxGeometry(fw * 0.9, 0.06, fd * 0.85),
    new MeshStandardMaterial({ color, roughness: 0.4 })
  );
  tray.position.y = bh * 0.62;
  group.add(tray);

  for (const side of [-1, 1]) {
    const wall = new Mesh(
      new BoxGeometry(0.04, 0.2, fd * 0.85),
      new MeshStandardMaterial({ color, roughness: 0.4 })
    );
    wall.position.set(side * fw * 0.44, bh * 0.72, 0);
    group.add(wall);
  }

  const lidar = new Mesh(
    new CylinderGeometry(0.07, 0.07, 0.1, 12),
    new MeshStandardMaterial({ color: "#333" })
  );
  lidar.position.set(0, bh * 0.65, -fd * 0.38);
  group.add(lidar);

  addLEDStrips(group, fw, fd, bh * 0.6, color);
  const statusLight = addStatusLight(group, fw, bh * 0.6, fd);

  const liftGroup = new Group();
  const forkGroup = new Group();
  liftGroup.add(forkGroup);
  group.add(liftGroup);

  addLabel(group, id, color, fw, fd, bh * 0.65);

  const carriedBox = createCarriedPayloadMesh(scenario, fw * 0.7, 0.35, fd * 0.65);
  carriedBox.position.set(0, bh * 0.85, 0);
  carriedBox.visible = false;
  group.add(carriedBox);

  return { group, liftGroup, forkGroup, carriedBox, statusLight, statusLightMaterial: statusLight.material as MeshStandardMaterial, id };
}

function createCarriedPayloadMesh(scenario: WarehouseScenario, width: number, height: number, depth: number): Mesh {
  const material = scenario.visual.boxStyle === "totes" ? toteMat : boxMaterial;
  const mesh = new Mesh(new BoxGeometry(width, height, depth), material);
  mesh.name = scenario.visual.boxStyle === "totes" ? "carried-dark-tote" : "carried-carton";
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  if (scenario.visual.boxStyle === "totes") {
    const lid = new Mesh(new BoxGeometry(width * 1.03, Math.max(0.035, height * 0.08), depth * 0.92), toteLidMat);
    lid.name = "carried-tote-lid";
    lid.position.y = height * 0.53;
    mesh.add(lid);
  }

  return mesh;
}

function addLEDStrips(group: Group, fw: number, fd: number, bh: number, color: string) {
  const ledMat = new MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5 });
  const front = new Mesh(new BoxGeometry(fw * 0.6, 0.04, 0.04), ledMat);
  front.position.set(0, bh * 0.3, -fd / 2 - 0.02);
  group.add(front);

  const back = new Mesh(new BoxGeometry(fw * 0.6, 0.04, 0.04), ledMat.clone());
  (back.material as MeshStandardMaterial).emissiveIntensity = 0.3;
  back.position.set(0, bh * 0.3, fd / 2 + 0.02);
  group.add(back);
}

function addStatusLight(group: Group, fw: number, bh: number, fd: number): Mesh {
  const mat = new MeshStandardMaterial({ color: "#38d36f", emissive: "#38d36f", emissiveIntensity: 0.7 });
  const light = new Mesh(new SphereGeometry(0.06, 8, 8), mat);
  light.position.set(0, bh + 0.12, 0);
  group.add(light);
  return light;
}

function addMastRails(liftGroup: Group, fw: number, fd: number, bh: number, mastH: number, color: string) {
  const mastMat = new MeshStandardMaterial({ color, roughness: 0.35 });
  const mast1 = new Mesh(new BoxGeometry(0.08, mastH, 0.08), mastMat);
  mast1.position.set(-fw * 0.35, bh + mastH / 2, -fd * 0.3);
  liftGroup.add(mast1);
  const mast2 = new Mesh(new BoxGeometry(0.08, mastH, 0.08), mastMat);
  mast2.position.set(fw * 0.35, bh + mastH / 2, -fd * 0.3);
  liftGroup.add(mast2);
}

function addForks(forkGroup: Group, fw: number, fd: number, bh: number) {
  const fork1 = new Mesh(new BoxGeometry(0.12, 0.06, fd * 0.7), forkMat);
  fork1.position.set(-fw * 0.22, bh + 0.05, -fd * 0.55);
  forkGroup.add(fork1);
  const fork2 = new Mesh(new BoxGeometry(0.12, 0.06, fd * 0.7), forkMat);
  fork2.position.set(fw * 0.22, bh + 0.05, -fd * 0.55);
  forkGroup.add(fork2);
}

function addLabel(group: Group, id: number, color: string, fw: number, fd: number, bh: number) {
  const labelMesh = new Mesh(
    new BoxGeometry(0.5, 0.03, 0.25),
    new MeshLambertMaterial({ map: makeLabelTexture(String(id).padStart(2, "0"), color) })
  );
  labelMesh.position.set(0, bh + 0.02, -fd / 2 - 0.14);
  labelMesh.rotation.x = -Math.PI / 2;
  group.add(labelMesh);
}

function addScissorRobotLabel(group: Group, id: number, fw: number, fd: number, bh: number) {
  const labelMesh = new Mesh(
    new BoxGeometry(fw * 0.48, 0.035, fd * 0.22),
    new MeshLambertMaterial({ map: makeLabelTexture(String(id).padStart(2, "0"), "#ffffff") })
  );
  labelMesh.position.set(0, bh * 0.34, -fd * 0.62);
  labelMesh.rotation.x = -Math.PI / 2;
  group.add(labelMesh);
}

export function updateRobotVisual(
  visual: RobotVisual,
  runtime: RobotRuntime,
  scenario: WarehouseScenario,
  dt: number,
  missions: Mission[] = [],
  slots: Slot[] = []
) {
  const smoothing = Math.min(1, Math.max(0.12, dt / 90));
  if (Math.hypot(visual.group.position.x - runtime.position.x, visual.group.position.z - runtime.position.z) > 4) {
    visual.group.position.x = runtime.position.x;
    visual.group.position.z = runtime.position.z;
  } else {
    visual.group.position.x += (runtime.position.x - visual.group.position.x) * smoothing;
    visual.group.position.z += (runtime.position.z - visual.group.position.z) * smoothing;
  }
  visual.group.rotation.y = smoothAngle(visual.group.rotation.y, runtime.heading, smoothing);
  visual.group.traverse(child => {
    if (child.name === "mecanum-wheel") {
      child.rotation.x = runtime.totalDistance * 5;
    }
  });

  const isCarrying = runtime.carryingSlotId !== undefined;
  const mission = runtime.missionId ? missions.find(m => m.id === runtime.missionId) : undefined;
  const sourceSlot = mission ? slots.find(slot => slot.id === mission.sourceSlotId) : undefined;
  const activeLevelIndex = sourceSlot?.levelIndex ?? 0;
  const targetShelfHeight = getLiftTargetForLevel(activeLevelIndex, scenario);
  const isHandlingBox = runtime.state === "picking" || runtime.state === "placing";
  visual.carriedBox.visible = isCarrying || runtime.state === "picking";

  const isPicking = runtime.state === "picking";
  const isPlacing = runtime.state === "placing";
  const liftTarget = isPicking ? targetShelfHeight : isPlacing ? Math.max(0.55, targetShelfHeight * 0.35) : isCarrying ? 0.32 : 0;
  const liftSpeed = isHandlingBox ? 0.16 : 0.08;
  visual.liftGroup.position.y += (liftTarget - visual.liftGroup.position.y) * liftSpeed;

  const scissorArms = visual.group.getObjectByName("scissor-arms");
  if (scissorArms) {
    updateScissorStages(scissorArms as Group, visual.liftGroup.position.y, scenario);
  }

  if (visual.carriedBox.visible) {
    visual.carriedBox.position.y = scenario.robots.bodyHeight + 0.44 + visual.liftGroup.position.y;
    visual.carriedBox.position.z = scenario.robots.footprintDepth * -0.05;
  }

  if (visual.statusLightMaterial) {
    const isActive = runtime.state !== "idle";
    const isCharging = runtime.state === "charging" || runtime.state === "to-charge";
    const lowBattery = runtime.batteryMinutes < (scenario.simulation.lowBatteryThreshold ?? 15);

    if (isCharging) {
      visual.statusLightMaterial.color.set("#f5c542");
      visual.statusLightMaterial.emissive.set("#f5c542");
    } else if (lowBattery) {
      visual.statusLightMaterial.color.set("#e23b2f");
      visual.statusLightMaterial.emissive.set("#e23b2f");
    } else if (isActive) {
      visual.statusLightMaterial.color.set("#38d36f");
      visual.statusLightMaterial.emissive.set("#38d36f");
    } else {
      visual.statusLightMaterial.color.set("#555555");
      visual.statusLightMaterial.emissive.set("#333333");
      visual.statusLightMaterial.emissiveIntensity = 0.3;
    }
  }
}

function updateScissorStages(scissorArms: Group, extension: number, scenario: WarehouseScenario) {
  const stageCount = 3;
  const maxLift = Math.max(0.6, scenario.robots.liftMaxHeight);
  const perStage = maxLift / stageCount;
  let accumulatedRise = 0;

  scissorArms.scale.set(1, 1, 1);
  for (const child of scissorArms.children) {
    if (!(child instanceof Group)) continue;
    if (child.name === "hydraulic-assist") continue;
    const stageIndex = child.userData.stageIndex ?? 0;
    const localOpen = clamp((extension - stageIndex * perStage) / perStage, 0, 1);
    const stageRise = localOpen * perStage * 0.72;
    child.visible = extension > 0.04 || stageIndex === 0;
    child.position.y = (child.userData.baseY ?? 0) + accumulatedRise + stageRise * 0.5;

    const armAngle = 0.25 + localOpen * 0.86;
    child.children.forEach((part, index) => {
      if (part instanceof Mesh && part.geometry instanceof BoxGeometry) {
        const direction = part.userData.scissorDirection ?? (index % 2 === 0 ? 1 : -1);
        if (part.userData.scissorDirection !== undefined) {
          part.rotation.z = direction * armAngle;
        }
      }
    });

    accumulatedRise += stageRise;
  }

  const hydraulic = scissorArms.getObjectByName("hydraulic-assist") as Group | undefined;
  if (hydraulic) {
    const openPct = clamp(extension / maxLift, 0, 1);
    hydraulic.children.forEach(part => {
      if (part instanceof Mesh && part.name === "hydraulic-rod") {
        part.scale.y = 0.65 + openPct * 1.45;
        part.position.y = 0.34 + openPct * 0.62;
      }
    });
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function smoothAngle(current: number, target: number, amount: number): number {
  let delta = target - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return current + delta * amount;
}

function getLiftTargetForLevel(levelIndex: number, scenario: WarehouseScenario): number {
  const shelfHeight = scenario.racks.bottomShelfHeight + levelIndex * scenario.racks.levelHeight;
  const deckBaseHeight = scenario.robots.bodyHeight * 0.88;
  const target = Math.max(0, shelfHeight - deckBaseHeight);
  return Math.min(scenario.robots.liftMaxHeight, Math.max(0.18, target));
}

export function disposeRobotVisual(visual: RobotVisual) {
  visual.group.traverse((obj) => {
    if (obj instanceof Mesh) {
      obj.geometry.dispose();
    }
  });
}
