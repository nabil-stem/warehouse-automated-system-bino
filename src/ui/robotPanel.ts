import { getState, rebuildWorld, setStatus } from "../app/appState";
import { loadRobotModel, clearRobotModel, hasCustomModel } from "../render/loaders";
import { setRobotCamera, getActiveRobotCamera, clearRobotCamera } from "../render/sceneManager";

export function renderRobotPanel(container: HTMLElement) {
  const s = getState().scenario;
  const r = s.robots;
  const modelStatus = hasCustomModel()
    ? "Custom model loaded"
    : r.useCustomModel
      ? "No model uploaded"
      : "Using default robot";

  container.innerHTML = `
    <div class="panel-section">
      <h3>Fleet</h3>
      <label class="ctrl"><span>Robot count</span>
        <input type="number" data-field="count" value="${r.count}" min="1" max="100" /></label>
      <label class="ctrl"><span>Speed (m/s)</span>
        <input type="number" data-field="speed" value="${r.speedMetersPerSecond}" min="0.5" max="5" step="0.1" /></label>
      <label class="ctrl"><span>Accel (m/s²)</span>
        <input type="number" data-field="accel" value="${r.maxAccelerationMps2 ?? 5.5}" min="0.5" max="20" step="0.1" /></label>
      <label class="ctrl"><span>Decel (m/s²)</span>
        <input type="number" data-field="decel" value="${r.maxDecelerationMps2 ?? 6.5}" min="0.5" max="20" step="0.1" /></label>
      <label class="ctrl"><span>Footprint W (m)</span>
        <input type="number" data-field="fpW" value="${r.footprintWidth}" min="0.5" max="3" step="0.1" /></label>
      <label class="ctrl"><span>Footprint D (m)</span>
        <input type="number" data-field="fpD" value="${r.footprintDepth}" min="0.5" max="3" step="0.1" /></label>
      <label class="ctrl"><span>Body height (m)</span>
        <input type="number" data-field="bodyH" value="${r.bodyHeight}" min="0.3" max="2" step="0.05" /></label>
      <label class="ctrl"><span>Lift max (m)</span>
        <input type="number" data-field="liftMax" value="${r.liftMaxHeight}" min="1" max="8" step="0.5" /></label>
      <label class="ctrl"><span>Default visual</span>
        <select data-field="visualType">
          <option value="scissor-lift" ${r.visualType === "scissor-lift" ? "selected" : ""}>Blue scissor lift</option>
          <option value="stacker-amr" ${r.visualType === "stacker-amr" ? "selected" : ""}>Stacker AMR</option>
          <option value="compact-lift" ${r.visualType === "compact-lift" ? "selected" : ""}>Compact lift</option>
          <option value="tote-carrier" ${r.visualType === "tote-carrier" ? "selected" : ""}>Tote carrier</option>
        </select></label>
      <label class="ctrl"><span>Battery (min)</span>
        <input type="number" data-field="battery" value="${r.batteryCapacityMinutes}" min="10" max="480" /></label>
    </div>
    <div class="panel-section">
      <h3>3D Model</h3>
      <div class="model-status">${modelStatus}</div>
      <label class="btn btn-file">Upload GLB/GLTF
        <input type="file" accept=".glb,.gltf" id="robot-model-input" hidden />
      </label>
      <label class="ctrl"><span>Use custom model</span>
        <input type="checkbox" data-field="useCustom" ${r.useCustomModel ? "checked" : ""} /></label>
      <label class="ctrl"><span>Model scale</span>
        <input type="range" data-field="modelScale" value="${r.customModelScale}" min="0.1" max="5" step="0.1" />
        <span class="range-val">${r.customModelScale.toFixed(1)}</span></label>
      <button class="btn btn-sm" data-action="clear-model">Clear Model (Use Default)</button>
    </div>
    <div class="panel-section">
      <h3>Robot Camera</h3>
      ${renderCameraIndicator()}
      <label class="ctrl"><span>Robot view</span>
        <select data-field="cameraRobot">
          ${getState().robots.map(robot => `
            <option value="${robot.id}">R${String(robot.id).padStart(2, "0")} - ${robot.state}</option>
          `).join("")}
        </select></label>
      <div class="sim-controls">
        <button class="btn btn-primary" data-action="robot-camera">View Camera</button>
        <button class="btn" data-action="follow-robot">Follow Robot</button>
        <button class="btn btn-danger btn-sm" data-action="stop-robot-camera">Stop Robot Camera</button>
      </div>
      <div class="model-status">Each robot camera looks forward from the robot body along its current mecanum drive heading.</div>
    </div>
    ${renderLiftTelemetrySection()}
    <div class="panel-section panel-actions">
      <button class="btn btn-primary" data-action="rebuild">Apply & Rebuild</button>
    </div>
  `;

  const modelInput = container.querySelector("#robot-model-input") as HTMLInputElement;
  if (modelInput) modelInput.onchange = async () => {
    const file = modelInput.files?.[0];
    if (!file) return;
    setStatus("Loading robot model...");
    const result = await loadRobotModel(file, r.customModelScale);
    if (result.status === "loaded") {
      r.useCustomModel = true;
      rebuildWorld();
      setStatus("Robot model loaded");
    } else {
      setStatus(`Model failed: ${result.error}`);
    }
    renderRobotPanel(container);
  };

  container.onchange = (e) => {
    const target = e.target as HTMLInputElement;
    const f = target.dataset.field;
    if (!f) return;
    const v = parseFloat(target.value);
    if (f === "count") r.count = Math.max(1, Math.round(v));
    else if (f === "speed") r.speedMetersPerSecond = v;
    else if (f === "accel") r.maxAccelerationMps2 = Math.max(0.5, v);
    else if (f === "decel") r.maxDecelerationMps2 = Math.max(0.5, v);
    else if (f === "fpW") r.footprintWidth = v;
    else if (f === "fpD") r.footprintDepth = v;
    else if (f === "bodyH") r.bodyHeight = v;
    else if (f === "liftMax") r.liftMaxHeight = v;
    else if (f === "visualType") r.visualType = target.value as any;
    else if (f === "battery") r.batteryCapacityMinutes = v;
    else if (f === "useCustom") r.useCustomModel = target.checked;
    else if (f === "modelScale") {
      r.customModelScale = v;
      const rangeVal = target.parentElement?.querySelector(".range-val");
      if (rangeVal) rangeVal.textContent = v.toFixed(1);
    }
  };

  container.onclick = (e) => {
    const btn = (e.target as HTMLElement).closest("[data-action]") as HTMLElement;
    if (!btn) return;
    if (btn.dataset.action === "rebuild") {
      rebuildWorld();
      renderRobotPanel(container);
    }
    if (btn.dataset.action === "clear-model") {
      clearRobotModel();
      r.useCustomModel = false;
      setStatus("Cleared custom model");
      renderRobotPanel(container);
    }
    if (btn.dataset.action === "robot-camera" || btn.dataset.action === "follow-robot") {
      const robotId = parseInt((container.querySelector('[data-field="cameraRobot"]') as HTMLSelectElement)?.value ?? "1");
      const robot = getState().robots.find(r => r.id === robotId);
      if (!robot) {
        setStatus("Robot camera target not found");
        return;
      }
      setRobotCamera(robot.id, btn.dataset.action === "robot-camera" ? "robot-camera" : "follow");
      setStatus(`Viewing R${String(robot.id).padStart(2, "0")} camera`);
      renderRobotPanel(container);
    }
    if (btn.dataset.action === "stop-robot-camera") {
      clearRobotCamera();
      setStatus("Returned to overview camera");
      renderRobotPanel(container);
    }
  };
}

function renderCameraIndicator(): string {
  const cam = getActiveRobotCamera();
  if (!cam) return "";
  const robot = getState().robots.find(r => r.id === cam.robotId);
  const modeLabel = cam.mode === "robot-camera" ? "First-person" : "Follow";
  const lift = robot?.liftTelemetry;
  const levelLabel = lift && lift.payloadState !== "empty" ? `L${lift.targetLevel + 1}` : "-";
  return `
    <div class="robot-camera-indicator">
      <div class="camera-label">${modeLabel}: R${String(cam.robotId).padStart(2, "0")}</div>
      <div class="camera-detail">State: ${robot?.state ?? "unknown"}</div>
      ${lift ? `
        <div class="lift-telemetry-overlay">
          <div class="lift-telem-row"><span>Target level</span><span>${levelLabel}</span></div>
          <div class="lift-telem-row"><span>Extension</span><span>${lift.currentExtensionPct.toFixed(0)}%</span></div>
          <div class="lift-telem-row"><span>Active stages</span><span>${lift.activeStages}</span></div>
          <div class="lift-telem-row"><span>Payload</span><span class="payload-${lift.payloadState}">${lift.payloadState}</span></div>
        </div>
      ` : ""}
    </div>
  `;
}

function renderLiftTelemetrySection(): string {
  const robots = getState().robots;
  const activeLifts = robots.filter(r =>
    r.liftTelemetry.payloadState !== "empty" || r.liftTelemetry.currentExtensionPct > 0
  );
  if (activeLifts.length === 0) return "";
  return `
    <div class="panel-section">
      <h3>Active Lift Telemetry</h3>
      <div class="lift-telem-table">
        <div class="lift-telem-header">
          <span>Robot</span><span>Level</span><span>Ext%</span><span>Stages</span><span>Payload</span>
        </div>
        ${activeLifts.map(r => `
          <div class="lift-telem-row-table">
            <span>R${String(r.id).padStart(2, "0")}</span>
            <span>L${r.liftTelemetry.targetLevel + 1}</span>
            <span>${r.liftTelemetry.currentExtensionPct.toFixed(0)}%</span>
            <span>${r.liftTelemetry.activeStages}</span>
            <span class="payload-${r.liftTelemetry.payloadState}">${r.liftTelemetry.payloadState}</span>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}
