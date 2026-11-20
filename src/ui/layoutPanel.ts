import { getState, rebuildWorld, setStatus } from "../app/appState";
import { rebuildScene, setCameraPreset } from "../render/sceneManager";
import {
  clearReferenceWarehouseModel,
  hasReferenceWarehouseModel,
  loadReferenceWarehouseModel,
  loadReferenceWarehouseModelFromUrl,
} from "../render/loaders";
import { requiredWarehouseDimensions } from "../domain/warehouseGenerator";

export function renderLayoutPanel(container: HTMLElement) {
  const s = getState().scenario;
  const { warehouse: w, racks: r } = s;

  container.innerHTML = `
    <div class="panel-section">
      <label class="ctrl"><span>Scenario name</span>
        <input type="text" data-field="name" value="${s.name}" /></label>
      <label class="ctrl"><span>Seed</span>
        <input type="number" data-field="seed" value="${s.seed}" min="1" max="999999" /></label>
    </div>
    <div class="panel-section">
      <h3>Warehouse</h3>
      ${numInput("Width (m)", "w-width", w.width, 20, 500)}
      ${numInput("Depth (m)", "w-depth", w.depth, 20, 500)}
      ${numInput("Grid spacing (m)", "w-grid", w.gridSpacing, 1, 20)}
      <label class="ctrl"><span>Show walls</span>
        <input type="checkbox" data-field="w-walls" ${w.showWalls ? "checked" : ""} /></label>
      <label class="ctrl"><span>Show roof</span>
        <input type="checkbox" data-field="w-roof" ${w.showRoof ? "checked" : ""} /></label>
    </div>
    <div class="panel-section">
      <h3>Visual References</h3>
      <label class="ctrl"><span>Rack style</span>
        <select data-field="v-rackStyle">
          <option value="shelf" ${s.visual.rackStyle === "shelf" ? "selected" : ""}>Shelf cartons</option>
          <option value="pallet" ${s.visual.rackStyle === "pallet" ? "selected" : ""}>High-bay pallet</option>
          <option value="bin-wall" ${s.visual.rackStyle === "bin-wall" ? "selected" : ""}>Bin wall</option>
        </select></label>
      <label class="ctrl"><span>Box style</span>
        <select data-field="v-boxStyle">
          <option value="cartons" ${s.visual.boxStyle === "cartons" ? "selected" : ""}>Cartons</option>
          <option value="totes" ${s.visual.boxStyle === "totes" ? "selected" : ""}>Totes</option>
        </select></label>
      <label class="ctrl"><span>Polished floor</span>
        <input type="checkbox" data-field="v-polished" ${s.visual.polishedFloor ? "checked" : ""} /></label>
      <label class="ctrl"><span>Hazard lanes</span>
        <input type="checkbox" data-field="v-hazard" ${s.visual.showHazardLanes ? "checked" : ""} /></label>
      <label class="ctrl"><span>Overhead lights</span>
        <input type="checkbox" data-field="v-overhead" ${s.visual.showOverheadStructure ? "checked" : ""} /></label>
      <label class="ctrl"><span>Rack bracing</span>
        <input type="checkbox" data-field="v-bracing" ${s.visual.showRackBracing ? "checked" : ""} /></label>
      <label class="ctrl"><span>Bin faces</span>
        <input type="checkbox" data-field="v-binFaces" ${s.visual.showBinFaces ? "checked" : ""} /></label>
      <div class="model-status">
        ${hasReferenceWarehouseModel() ? "Reference warehouse model loaded" : "No reference warehouse model loaded"}
        ${s.visual.referenceModelUrl ? `<br />Built-in CAD: ${s.visual.referenceModelUrl}` : ""}
      </div>
      <label class="btn btn-file">Upload Reference GLB/GLTF
        <input type="file" accept=".glb,.gltf" id="reference-model-input" hidden />
      </label>
      <label class="ctrl"><span>Reference scale</span>
        <input type="range" data-field="v-referenceScale" value="${s.visual.referenceModelScale}" min="0.01" max="60" step="0.05" />
        <span class="range-val">${s.visual.referenceModelScale.toFixed(2)}</span></label>
      <label class="ctrl"><span>Reference opacity</span>
        <input type="range" data-field="v-referenceOpacity" value="${s.visual.referenceModelOpacity}" min="0.05" max="1" step="0.05" />
        <span class="range-val">${s.visual.referenceModelOpacity.toFixed(2)}</span></label>
      <label class="ctrl"><span>Show procedural layer</span>
        <input type="checkbox" data-field="v-proceduralReference" ${s.visual.showProceduralUnderReference ? "checked" : ""} /></label>
      ${s.visual.referenceModelUrl ? `<button class="btn btn-sm" data-action="reload-reference-model">Reload Built-in CAD</button>` : ""}
      <button class="btn btn-sm" data-action="clear-reference-model">Clear Reference Model</button>
    </div>
    <div class="panel-section">
      <h3>Racks</h3>
      ${numInput("Row count", "r-rowCount", r.rowCount, 2, 60)}
      ${numInput("Bays/row", "r-baysPerRow", r.baysPerRow, 2, 40)}
      ${numInput("Levels", "r-levels", r.levels, 1, 8)}
      ${numInput("Bay width (m)", "r-bayWidth", r.bayWidth, 1, 6, 0.1)}
      ${numInput("Shelf depth (m)", "r-shelfDepth", r.shelfDepth, 0.5, 3, 0.1)}
      ${numInput("Level height (m)", "r-levelHeight", r.levelHeight, 0.8, 3, 0.1)}
      ${numInput("Bottom shelf (m)", "r-bottomShelf", r.bottomShelfHeight, 0.5, 3, 0.1)}
      ${numInput("Row pitch (m)", "r-rowPitch", r.rowPitch, 3, 12, 0.5)}
      ${numInput("Aisle width (m)", "r-aisleWidth", r.aisleWidth, 2, 8, 0.5)}
      ${numInput("Main aisle (m)", "r-mainAisle", r.mainAisleWidth, 3, 12, 0.5)}
      ${numInput("Cross aisle every bays", "r-crossEvery", r.crossAisleEveryBays, 0, 20)}
      ${numInput("Cross aisle width (m)", "r-crossWidth", r.crossAisleWidth, 0, 8, 0.1)}
    </div>
    <div class="panel-section">
      <h3>Aisle Lanes & Yield Bays</h3>
      <label class="ctrl"><span>Show yield bays</span>
        <input type="checkbox" data-field="sim-showYieldBays" ${s.simulation.showYieldBays !== false ? "checked" : ""} /></label>
      <label class="ctrl"><span>Show lane geometry</span>
        <input type="checkbox" data-field="sim-showLaneGeometry" ${s.simulation.showLaneGeometry !== false ? "checked" : ""} /></label>
      <div class="aisle-lane-table">
        <div class="aisle-lane-header"><span>Aisle</span><span>Direction</span></div>
        ${Array.from({ length: Math.ceil(r.rowCount / 2) }, (_, i) => {
          const lane = (s.simulation.aisleLanes ?? []).find((l: any) => l.aisleIndex === i);
          const dir = lane?.direction ?? "two-way";
          return `
            <div class="aisle-lane-row">
              <span>Aisle ${i}</span>
              <select data-field="aisleLane" data-aisle-idx="${i}">
                <option value="two-way" ${dir === "two-way" ? "selected" : ""}>Two-way</option>
                <option value="one-way-forward" ${dir === "one-way-forward" ? "selected" : ""}>One-way &rarr;</option>
                <option value="one-way-reverse" ${dir === "one-way-reverse" ? "selected" : ""}>One-way &larr;</option>
              </select>
            </div>
          `;
        }).join("")}
      </div>
    </div>
    <div class="panel-section">
      <h3>Stations</h3>
      <div class="station-table">
        <div class="station-header">
          <span>Label</span><span>X</span><span>Z</span><span>W</span><span>D</span><span>Cap</span>
        </div>
        ${s.stations.map((station, index) => `
          <div class="station-row">
            <input type="text" data-station-idx="${index}" data-station-field="label" value="${station.label}" />
            <input type="number" data-station-idx="${index}" data-station-field="x" value="${station.position.x}" step="0.5" />
            <input type="number" data-station-idx="${index}" data-station-field="z" value="${station.position.z}" step="0.5" />
            <input type="number" data-station-idx="${index}" data-station-field="width" value="${station.width}" min="1" step="0.5" />
            <input type="number" data-station-idx="${index}" data-station-field="depth" value="${station.depth}" min="1" step="0.5" />
            <input type="number" data-station-idx="${index}" data-station-field="capacity" value="${station.capacity}" min="1" step="1" />
          </div>
        `).join("")}
      </div>
    </div>
    <div class="panel-section panel-actions">
      <button class="btn btn-primary" data-action="rebuild">Rebuild Scenario</button>
      <button class="btn" data-action="reset-camera">Reset Camera</button>
      <div class="camera-presets">
        <button class="btn btn-sm" data-cam="overview">Overview</button>
        <button class="btn btn-sm" data-cam="aisle">Aisle</button>
        <button class="btn btn-sm" data-cam="top-down">Top-down</button>
      </div>
    </div>
    <div class="validation-msg" id="layout-validation"></div>
  `;

  const refInput = container.querySelector("#reference-model-input") as HTMLInputElement;
  if (refInput) refInput.onchange = async () => {
    const file = refInput.files?.[0];
    if (!file) return;
    setStatus("Loading reference warehouse model...");
    const result = await loadReferenceWarehouseModel(file, s.visual.referenceModelScale);
    if (result.status === "loaded") {
      refreshScene();
      setStatus("Reference warehouse model loaded");
    } else {
      setStatus(`Reference model failed: ${result.error}`);
    }
    renderLayoutPanel(container);
  };

  container.onchange = (e) => {
    const target = e.target as HTMLInputElement;
    applyField(target);
  };

  container.onclick = (e) => {
    const btn = (e.target as HTMLElement).closest("[data-action]") as HTMLElement;
    if (btn?.dataset.action === "rebuild") {
      applyAllFields(container);
      validateAndRebuild(container);
    }
    if (btn?.dataset.action === "reset-camera") {
      setCameraPreset("overview");
    }
    if (btn?.dataset.action === "clear-reference-model") {
      clearReferenceWarehouseModel();
      refreshScene();
      setStatus("Cleared reference warehouse model");
      renderLayoutPanel(container);
    }
    if (btn?.dataset.action === "reload-reference-model") {
      void reloadBuiltInReference(container);
    }
    const cam = (e.target as HTMLElement).closest("[data-cam]") as HTMLElement;
    if (cam) {
      setCameraPreset(cam.dataset.cam as any);
    }
  };
}

function applyField(input: HTMLInputElement) {
  const state = getState();
  const s = state.scenario;
  const f = input.dataset.field;
  const stationField = input.dataset.stationField;
  if (stationField) {
    const station = s.stations[parseInt(input.dataset.stationIdx ?? "0")];
    if (!station) return;
    if (stationField === "label") {
      station.label = input.value;
      return;
    }
    const value = parseFloat(input.value);
    if (!Number.isFinite(value)) return;
    if (stationField === "x") station.position.x = value;
    else if (stationField === "z") station.position.z = value;
    else if (stationField === "width") station.width = Math.max(1, value);
    else if (stationField === "depth") station.depth = Math.max(1, value);
    else if (stationField === "capacity") station.capacity = Math.max(1, Math.round(value));
    return;
  }

  if (!f) return;

  if (f === "sim-showYieldBays") { s.simulation.showYieldBays = input.checked; return; }
  if (f === "sim-showLaneGeometry") { s.simulation.showLaneGeometry = input.checked; return; }
  if (f === "aisleLane") {
    const idx = parseInt(input.dataset.aisleIdx ?? "0");
    const dir = input.value as any;
    if (!s.simulation.aisleLanes) s.simulation.aisleLanes = [];
    const existing = s.simulation.aisleLanes.find(l => l.aisleIndex === idx);
    if (existing) {
      existing.direction = dir;
    } else {
      s.simulation.aisleLanes.push({ aisleIndex: idx, direction: dir });
    }
    return;
  }

  if (f === "name") { s.name = input.value; return; }
  if (f === "seed") { s.seed = parseInt(input.value) || 1; return; }
  if (f === "w-walls") { s.warehouse.showWalls = input.checked; return; }
  if (f === "w-roof") { s.warehouse.showRoof = input.checked; return; }
  if (f === "v-rackStyle") { s.visual.rackStyle = input.value as any; return; }
  if (f === "v-boxStyle") { s.visual.boxStyle = input.value as any; return; }
  if (f === "v-polished") { s.visual.polishedFloor = input.checked; return; }
  if (f === "v-hazard") { s.visual.showHazardLanes = input.checked; return; }
  if (f === "v-overhead") { s.visual.showOverheadStructure = input.checked; return; }
  if (f === "v-bracing") { s.visual.showRackBracing = input.checked; return; }
  if (f === "v-binFaces") { s.visual.showBinFaces = input.checked; return; }
  if (f === "v-proceduralReference") {
    s.visual.showProceduralUnderReference = input.checked;
    refreshScene();
    return;
  }
  if (f === "v-referenceScale") {
    s.visual.referenceModelScale = parseFloat(input.value) || 1;
    const rv = input.parentElement?.querySelector(".range-val");
    if (rv) rv.textContent = s.visual.referenceModelScale.toFixed(2);
    refreshScene();
    return;
  }
  if (f === "v-referenceOpacity") {
    s.visual.referenceModelOpacity = Math.max(0.05, Math.min(1, parseFloat(input.value) || 1));
    const rv = input.parentElement?.querySelector(".range-val");
    if (rv) rv.textContent = s.visual.referenceModelOpacity.toFixed(2);
    refreshScene();
    return;
  }

  const v = parseFloat(input.value);
  if (isNaN(v)) return;

  const map: Record<string, () => void> = {
    "w-width": () => s.warehouse.width = v,
    "w-depth": () => s.warehouse.depth = v,
    "w-grid": () => s.warehouse.gridSpacing = v,
    "r-rowCount": () => s.racks.rowCount = Math.max(2, Math.round(v)),
    "r-baysPerRow": () => s.racks.baysPerRow = Math.max(2, Math.round(v)),
    "r-levels": () => s.racks.levels = Math.max(1, Math.round(v)),
    "r-bayWidth": () => s.racks.bayWidth = v,
    "r-shelfDepth": () => s.racks.shelfDepth = v,
    "r-levelHeight": () => s.racks.levelHeight = v,
    "r-bottomShelf": () => s.racks.bottomShelfHeight = v,
    "r-rowPitch": () => s.racks.rowPitch = v,
    "r-aisleWidth": () => s.racks.aisleWidth = v,
    "r-mainAisle": () => s.racks.mainAisleWidth = v,
    "r-crossEvery": () => s.racks.crossAisleEveryBays = Math.max(0, Math.round(v)),
    "r-crossWidth": () => s.racks.crossAisleWidth = Math.max(0, v),
  };

  map[f]?.();
}

function applyAllFields(container: HTMLElement) {
  const controls = container.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-field], [data-station-field]");
  controls.forEach(control => applyField(control as HTMLInputElement));
}

function refreshScene() {
  const state = getState();
  rebuildScene(state.scenario, state.slots, state.robots, state.navGraph);
}

async function reloadBuiltInReference(container: HTMLElement) {
  const state = getState();
  const url = state.scenario.visual.referenceModelUrl;
  if (!url) return;

  setStatus("Loading built-in CAD reference...");
  const result = await loadReferenceWarehouseModelFromUrl(url, state.scenario.visual.referenceModelScale);
  if (result.status === "loaded") {
    refreshScene();
    setStatus("Loaded built-in CAD reference");
  } else {
    setStatus(`Built-in CAD reference failed: ${result.error}`);
  }
  renderLayoutPanel(container);
}

function validateAndRebuild(container: HTMLElement) {
  const s = getState().scenario;
  const r = s.racks;
  const warnings: string[] = [];
  const crossCount = r.crossAisleEveryBays > 0 ? Math.floor((r.baysPerRow - 1) / r.crossAisleEveryBays) : 0;
  const rackWidth = r.baysPerRow * r.bayWidth + crossCount * r.crossAisleWidth;
  const rackDepth = Math.ceil(r.rowCount / 2) * r.rowPitch;
  const required = requiredWarehouseDimensions(s);

  if (required.width > s.warehouse.width || required.depth > s.warehouse.depth) {
    warnings.push(`Warehouse will auto-size to ${required.width.toFixed(0)}m x ${required.depth.toFixed(0)}m`);
  }
  if (rackWidth > required.width * 0.95) {
    warnings.push(`Rack width (${rackWidth.toFixed(1)}m) leaves too little side service margin`);
  }
  if (rackDepth + r.mainAisleWidth > required.depth * 0.95) {
    warnings.push(`Rack depth + main aisle leaves too little front/back service margin`);
  }
  for (const station of s.stations) {
    if (Math.abs(station.position.x) + station.width / 2 > s.warehouse.width / 2) {
      warnings.push(`${station.label} exceeds warehouse width`);
    }
    if (Math.abs(station.position.z) + station.depth / 2 > s.warehouse.depth / 2) {
      warnings.push(`${station.label} exceeds warehouse depth`);
    }
  }

  const msgEl = container.querySelector("#layout-validation") as HTMLElement;
  if (msgEl) {
    msgEl.textContent = warnings.join("; ");
    msgEl.className = warnings.length > 0 ? "validation-msg warn" : "validation-msg";
  }

  rebuildWorld();
}

function numInput(label: string, field: string, value: number, min: number, max: number, step = 1): string {
  return `<label class="ctrl"><span>${label}</span>
    <input type="number" data-field="${field}" value="${value}" min="${min}" max="${max}" step="${step}" /></label>`;
}
