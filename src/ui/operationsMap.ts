import type { WarehouseScenario, RobotRuntime, Slot, NavGraph, Mission, SimMetrics } from "../domain/schema";
import { computeWarehouseExtents, rackBayBoundaryX } from "../domain/warehouseGenerator";
import { getRobotColor } from "../render/materials";
import { getState, setStatus } from "../app/appState";
import { setSelectedRobotId, getSelectedRobotId } from "../render/sceneManager";

let mapCanvas: HTMLCanvasElement | null = null;
let mapContainer: HTMLElement | null = null;

export function createOperationsMapPanel(viewport: HTMLElement): HTMLElement {
  mapContainer = document.createElement("div");
  mapContainer.className = "ops-map-container";
  mapContainer.innerHTML = `
    <div class="ops-map-header">
      <span class="ops-map-title">Operations Map</span>
      <div class="ops-map-controls">
        <select class="ops-map-mode" title="Map mode">
          <option value="qr-track" selected>QR Track</option>
          <option value="layout">Layout</option>
          <option value="missions">Missions</option>
          <option value="traffic">Traffic</option>
          <option value="congestion">Congestion</option>
        </select>
        <button class="ops-map-toggle" title="Collapse map">_</button>
      </div>
    </div>
    <canvas class="ops-map-canvas" width="280" height="220"></canvas>
  `;

  viewport.appendChild(mapContainer);
  mapCanvas = mapContainer.querySelector(".ops-map-canvas") as HTMLCanvasElement;

  const toggleBtn = mapContainer.querySelector(".ops-map-toggle") as HTMLButtonElement;
  toggleBtn.addEventListener("click", () => {
    const canvas = mapContainer!.querySelector(".ops-map-canvas") as HTMLCanvasElement;
    const isHidden = canvas.style.display === "none";
    canvas.style.display = isHidden ? "block" : "none";
    toggleBtn.textContent = isHidden ? "_" : "+";
  });

  const modeSelect = mapContainer.querySelector(".ops-map-mode") as HTMLSelectElement;
  modeSelect.addEventListener("change", () => {
    (mapContainer as any).__mapMode = modeSelect.value;
  });

  mapCanvas.addEventListener("click", (e) => {
    if (!mapCanvas) return;
    const rect = mapCanvas.getBoundingClientRect();
    const clickX = ((e.clientX - rect.left) / Math.max(1, rect.width)) * mapCanvas.width;
    const clickY = ((e.clientY - rect.top) / Math.max(1, rect.height)) * mapCanvas.height;
    const state = getState();
    const ww = state.scenario.warehouse.width;
    const wd = state.scenario.warehouse.depth;
    const padding = 12;
    const scale = Math.min((mapCanvas.width - padding * 2) / ww, (mapCanvas.height - padding * 2) / wd);
    const offsetX = (mapCanvas.width - ww * scale) / 2;
    const offsetZ = (mapCanvas.height - wd * scale) / 2;
    const toX = (x: number) => offsetX + (x + ww / 2) * scale;
    const toZ = (z: number) => offsetZ + (z + wd / 2) * scale;

    let best: RobotRuntime | null = null;
    let bestDist = 14;
    for (const r of state.robots) {
      const d = Math.hypot(toX(r.position.x) - clickX, toZ(r.position.z) - clickY);
      if (d < bestDist) {
        bestDist = d;
        best = r;
      }
    }
    if (best) {
      setSelectedRobotId(best.id);
      setStatus(`Selected R${String(best.id).padStart(2, "0")} from Operations Map`);
    }
  });

  return mapContainer;
}

export function updateOperationsMap(
  scenario: WarehouseScenario,
  robots: RobotRuntime[],
  slots: Slot[],
  navGraph: NavGraph,
  missions: Mission[],
  congestionMap: Map<string, number>,
  metrics: SimMetrics
) {
  if (!mapCanvas || !mapContainer) return;
  if (mapCanvas.style.display === "none") return;

  const mode = (mapContainer as any).__mapMode ?? scenario.simulation.operationsMapMode ?? "missions";
  const ctx = mapCanvas.getContext("2d");
  if (!ctx) return;

  const w = mapCanvas.width;
  const h = mapCanvas.height;
  const padding = 12;
  const ext = computeWarehouseExtents(scenario);

  const ww = scenario.warehouse.width;
  const wd = scenario.warehouse.depth;
  const scaleX = (w - padding * 2) / ww;
  const scaleZ = (h - padding * 2) / wd;
  const scale = Math.min(scaleX, scaleZ);

  const offsetX = (w - ww * scale) / 2;
  const offsetZ = (h - wd * scale) / 2;

  const toX = (x: number) => offsetX + (x + ww / 2) * scale;
  const toZ = (z: number) => offsetZ + (z + wd / 2) * scale;

  ctx.clearRect(0, 0, w, h);

  const qrMode = mode === "qr-track";

  ctx.fillStyle = qrMode ? "#f7f7f2" : "#0d1117";
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = qrMode ? "#e40000" : "rgba(98, 215, 184, 0.2)";
  ctx.lineWidth = qrMode ? 2 : 1;
  ctx.strokeRect(toX(-ww / 2), toZ(-wd / 2), ww * scale, wd * scale);

  if (mode === "congestion") {
    drawCongestionHeatmap(ctx, congestionMap, toX, toZ, scale, ww);
  }

  const { racks } = scenario;
  ctx.fillStyle = qrMode ? "transparent" : mode === "layout" ? "rgba(31, 95, 209, 0.5)" : "rgba(31, 95, 209, 0.3)";
  ctx.strokeStyle = qrMode ? "#e40000" : "transparent";
  ctx.lineWidth = qrMode ? 2 : 0;
  const segments = getRackMapSegments(scenario);
  for (let row = 0; row < racks.rowCount; row++) {
    const pairIndex = Math.floor(row / 2);
    const side = row % 2 === 0 ? -1 : 1;
    const z = ext.rackBlockStartZ + pairIndex * racks.rowPitch + side * (racks.shelfDepth / 2 + 0.1);
    for (const segment of segments) {
      const x1 = rackBayBoundaryX(scenario, segment.start, ext.rackBlockStartX);
      const x2 = rackBayBoundaryX(scenario, segment.end, ext.rackBlockStartX);
      const rx = toX(x1);
      const rz = toZ(z - racks.shelfDepth / 2);
      const rw = (x2 - x1) * scale;
      const rh = racks.shelfDepth * scale;
      if (qrMode) {
        ctx.strokeRect(rx, rz, rw, rh);
        drawRackBayTicks(ctx, rx, rz, rw, rh, segment.end - segment.start);
      } else {
        ctx.fillRect(rx, rz, rw, rh);
      }
    }
  }

  for (const station of scenario.stations) {
    const colors: Record<string, string> = {
      packing: "rgba(31, 143, 120, 0.6)",
      inbound: "rgba(39, 86, 163, 0.6)",
      charging: "rgba(163, 136, 39, 0.6)",
      buffer: "rgba(122, 59, 163, 0.6)",
    };
    ctx.fillStyle = qrMode ? "transparent" : colors[station.type] ?? "rgba(100,100,100,0.6)";
    ctx.strokeStyle = qrMode ? "#e40000" : "transparent";
    ctx.lineWidth = qrMode ? 2 : 0;
    ctx.fillRect(
      toX(station.position.x - station.width / 2),
      toZ(station.position.z - station.depth / 2),
      station.width * scale,
      station.depth * scale
    );
    if (qrMode) {
      ctx.strokeRect(
        toX(station.position.x - station.width / 2),
        toZ(station.position.z - station.depth / 2),
        station.width * scale,
        station.depth * scale
      );
    }
    ctx.fillStyle = qrMode ? "#e40000" : "#ccc";
    ctx.font = "7px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(station.label, toX(station.position.x), toZ(station.position.z) + 3);
  }

  if (mode === "layout" || mode === "traffic" || qrMode) {
    drawNavGraph(ctx, navGraph, toX, toZ, qrMode);
  }

  if (mode === "missions" || mode === "traffic") {
    drawMissionRoutes(ctx, robots, missions, toX, toZ);
  }

  const selectedId = getSelectedRobotId();
  for (const robot of robots) {
    const color = getRobotColor(robot.id);
    const rx = toX(robot.position.x);
    const rz = toZ(robot.position.z);

    if (robot.id === selectedId) {
      ctx.strokeStyle = qrMode ? "#0891b2" : "#38e2c7";
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(rx, rz, Math.max(5.5, scale * 1.15), 0, Math.PI * 2);
      ctx.stroke();
    }

    if (robot.state === "idle") {
      ctx.fillStyle = qrMode ? "#111" : "rgba(100,100,100,0.8)";
    } else if (robot.state === "charging" || robot.state === "to-charge") {
      ctx.fillStyle = "#f5c542";
    } else {
      ctx.fillStyle = color;
    }

    ctx.beginPath();
    ctx.arc(rx, rz, Math.max(2.5, scale * 0.6), 0, Math.PI * 2);
    ctx.fill();

    const dirX = Math.sin(robot.heading) * scale * 1.2;
    const dirZ = Math.cos(robot.heading) * scale * 1.2;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rx, rz);
    ctx.lineTo(rx + dirX, rz + dirZ);
    ctx.stroke();
  }
}

function drawNavGraph(
  ctx: CanvasRenderingContext2D,
  navGraph: NavGraph,
  toX: (x: number) => number,
  toZ: (z: number) => number,
  qrMode = false
) {
  ctx.strokeStyle = qrMode ? "rgba(33, 190, 95, 0.85)" : "rgba(55, 212, 93, 0.12)";
  ctx.lineWidth = qrMode ? 1.2 : 0.5;
  const seen = new Set<string>();
  for (const node of navGraph.nodes.values()) {
    for (const neighborId of node.neighbors) {
      const key = [node.id, neighborId].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const neighbor = navGraph.nodes.get(neighborId);
      if (!neighbor) continue;
      ctx.beginPath();
      ctx.moveTo(toX(node.position.x), toZ(node.position.z));
      ctx.lineTo(toX(neighbor.position.x), toZ(neighbor.position.z));
      ctx.stroke();
    }
  }

  if (qrMode) {
    let index = 0;
    for (const node of navGraph.nodes.values()) {
      if (index % 2 === 0) drawQrDot(ctx, toX(node.position.x), toZ(node.position.z));
      index++;
    }
  }
}

function drawQrDot(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const s = 5;
  ctx.fillStyle = "#fff";
  ctx.fillRect(x - s / 2, y - s / 2, s, s);
  ctx.fillStyle = "#111";
  ctx.fillRect(x - 2, y - 2, 1.5, 1.5);
  ctx.fillRect(x + 0.5, y - 2, 1.5, 1.5);
  ctx.fillRect(x - 2, y + 0.5, 1.5, 1.5);
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 0.5;
  ctx.strokeRect(x - s / 2, y - s / 2, s, s);
}

function drawRackBayTicks(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, bays: number) {
  if (bays <= 1) return;
  ctx.strokeStyle = "#e40000";
  ctx.lineWidth = 1;
  for (let i = 1; i < bays; i++) {
    const tx = x + (w / bays) * i;
    ctx.beginPath();
    ctx.moveTo(tx, y);
    ctx.lineTo(tx, y + h);
    ctx.stroke();
  }
}

function getRackMapSegments(scenario: WarehouseScenario): Array<{ start: number; end: number }> {
  const { racks } = scenario;
  const every = Math.max(0, Math.floor(racks.crossAisleEveryBays));
  if (every <= 0 || every >= racks.baysPerRow) return [{ start: 0, end: racks.baysPerRow }];
  const segments: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < racks.baysPerRow; start += every) {
    segments.push({ start, end: Math.min(start + every, racks.baysPerRow) });
  }
  return segments;
}

function drawMissionRoutes(
  ctx: CanvasRenderingContext2D,
  robots: RobotRuntime[],
  missions: Mission[],
  toX: (x: number) => number,
  toZ: (z: number) => number
) {
  for (const robot of robots) {
    if (robot.path.length < 2) continue;
    const color = getRobotColor(robot.id);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    for (let i = robot.pathIndex; i < robot.path.length; i++) {
      const px = toX(robot.path[i].x);
      const pz = toZ(robot.path[i].z);
      if (i === robot.pathIndex) ctx.moveTo(px, pz);
      else ctx.lineTo(px, pz);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawCongestionHeatmap(
  ctx: CanvasRenderingContext2D,
  congestionMap: Map<string, number>,
  toX: (x: number) => number,
  toZ: (z: number) => number,
  scale: number,
  warehouseWidth: number
) {
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
    ctx.fillStyle = `rgba(${r},${g},30,${0.15 + 0.35 * intensity})`;
    const halfW = warehouseWidth / 2;
    ctx.fillRect(toX(-halfW), toZ(z - 1.5), warehouseWidth * scale, 3 * scale);
  }
}

export function setOperationsMapVisible(visible: boolean) {
  if (mapContainer) {
    mapContainer.style.display = visible ? "flex" : "none";
  }
}

export function exportOperationsMapPNG(): Blob | null {
  if (!mapCanvas) return null;
  let blob: Blob | null = null;
  mapCanvas.toBlob(b => { blob = b; }, "image/png");
  return blob;
}

export function exportOperationsMapSVG(
  scenario: WarehouseScenario,
  robots: RobotRuntime[],
  navGraph: NavGraph,
  missions: Mission[]
): string {
  const ext = computeWarehouseExtents(scenario);
  const ww = scenario.warehouse.width;
  const wd = scenario.warehouse.depth;
  const { racks } = scenario;
  const svgW = 600;
  const svgH = Math.round((wd / ww) * svgW);
  const padding = 20;
  const scale = (svgW - padding * 2) / ww;
  const offsetX = padding;
  const offsetZ = padding;
  const toX = (x: number) => offsetX + (x + ww / 2) * scale;
  const toZ = (z: number) => offsetZ + (z + wd / 2) * scale;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH + padding * 2}" viewBox="0 0 ${svgW} ${svgH + padding * 2}">\n`;
  svg += `<rect width="100%" height="100%" fill="#0d1117"/>\n`;
  svg += `<rect x="${toX(-ww / 2)}" y="${toZ(-wd / 2)}" width="${ww * scale}" height="${wd * scale}" fill="none" stroke="rgba(98,215,184,0.3)" stroke-width="1"/>\n`;

  const rackLength = racks.baysPerRow * racks.bayWidth;
  for (let row = 0; row < racks.rowCount; row++) {
    const pairIndex = Math.floor(row / 2);
    const side = row % 2 === 0 ? -1 : 1;
    const z = ext.rackBlockStartZ + pairIndex * racks.rowPitch + side * (racks.shelfDepth / 2 + 0.1);
    svg += `<rect x="${toX(-rackLength / 2)}" y="${toZ(z - racks.shelfDepth / 2)}" width="${rackLength * scale}" height="${racks.shelfDepth * scale}" fill="rgba(31,95,209,0.4)"/>\n`;
  }

  for (const station of scenario.stations) {
    const colors: Record<string, string> = {
      packing: "rgba(31,143,120,0.6)", inbound: "rgba(39,86,163,0.6)",
      charging: "rgba(163,136,39,0.6)", buffer: "rgba(122,59,163,0.6)",
    };
    svg += `<rect x="${toX(station.position.x - station.width / 2)}" y="${toZ(station.position.z - station.depth / 2)}" width="${station.width * scale}" height="${station.depth * scale}" fill="${colors[station.type] ?? 'gray'}"/>\n`;
    svg += `<text x="${toX(station.position.x)}" y="${toZ(station.position.z) + 4}" text-anchor="middle" fill="#ccc" font-size="9">${station.label}</text>\n`;
  }

  for (const robot of robots) {
    const color = getRobotColor(robot.id);
    svg += `<circle cx="${toX(robot.position.x)}" cy="${toZ(robot.position.z)}" r="${Math.max(3, scale * 0.6)}" fill="${color}"/>\n`;
  }

  svg += `</svg>`;
  return svg;
}
