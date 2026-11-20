import { getState, loadScenario, setStatus } from "../app/appState";
import {
  downloadJSON, downloadCSV, slotsToCSV, missionsToCSV,
  generateTextToCADPrompt, saveScenarioToStorage, loadScenarioList,
  loadScenarioFromStorage, deleteScenarioFromStorage, downloadBlob,
  generateSDFWorld,
} from "../app/persistence";
import { exportGLB, exportScreenshot } from "../render/exporters";
import { getSceneState } from "../render/sceneManager";
import { validateScenario } from "../app/validation";
import { exportTracesAsJSON, exportTracesAsCSV, getAllTraces } from "../domain/traceRecorder";

export function renderExportPanel(container: HTMLElement) {
  const state = getState();
  const saved = loadScenarioList();

  container.innerHTML = `
    <div class="panel-section">
      <h3>Save / Load</h3>
      <button class="btn" data-action="save-local">Save to Browser</button>
      <div class="saved-list">
        ${saved.map(s => `
          <div class="saved-entry">
            <span>${s.name}</span>
            <small>${new Date(s.savedAt).toLocaleDateString()}</small>
            <button class="btn btn-sm" data-action="load-saved" data-name="${s.name}">Load</button>
            <button class="btn btn-sm btn-danger" data-action="delete-saved" data-name="${s.name}">x</button>
          </div>
        `).join("")}
        ${saved.length === 0 ? "<div class='empty-msg'>No saved scenarios</div>" : ""}
      </div>
    </div>
    <div class="panel-section">
      <h3>Export</h3>
      <button class="btn" data-action="export-json">Download Scenario JSON</button>
      <label class="btn btn-file">Upload Scenario JSON
        <input type="file" accept=".json" id="scenario-import" hidden />
      </label>
      <button class="btn" data-action="export-inventory">Download Inventory CSV</button>
      <button class="btn" data-action="export-missions">Download Mission Log CSV</button>
      <button class="btn" data-action="export-screenshot">Download Screenshot PNG</button>
      <button class="btn" data-action="export-glb">Download Warehouse GLB</button>
      <button class="btn" data-action="export-sdf">Download SDF World</button>
      <button class="btn" data-action="export-cad">Download Text-to-CAD Prompt</button>
    </div>
    <div class="panel-section">
      <h3>Mission Traces (${getAllTraces().length})</h3>
      <button class="btn" data-action="export-trace-json">Download Trace JSON</button>
      <button class="btn" data-action="export-trace-csv">Download Trace CSV</button>
    </div>
    <div class="panel-section">
      <button class="btn btn-danger" data-action="reset-default">Reset to Default Scenario</button>
    </div>
  `;

  const importInput = container.querySelector("#scenario-import") as HTMLInputElement;
  if (importInput) importInput.onchange = () => {
    const file = importInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        const candidate = parsed.scenario ?? parsed;
        const validation = validateScenario(candidate);
        if (!validation.ok) {
          setStatus(`Invalid scenario: ${validation.errors.slice(0, 2).join("; ")}`);
          return;
        }
        if (parsed.scenario) {
          loadScenario(parsed.scenario, parsed.slots, parsed.missions);
          setStatus("Scenario imported from JSON");
        } else if (parsed.version) {
          loadScenario(parsed);
          setStatus("Scenario imported from JSON");
        } else {
          setStatus("Invalid scenario JSON");
        }
      } catch {
        setStatus("Failed to parse JSON file");
      }
    };
    reader.readAsText(file);
  };

  container.onclick = async (e) => {
    const btn = (e.target as HTMLElement).closest("[data-action]") as HTMLElement;
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === "save-local") {
      saveScenarioToStorage(state.scenario, state.slots, state.missions);
      setStatus("Scenario saved to browser");
      renderExportPanel(container);
    }
    if (action === "load-saved") {
      const name = btn.dataset.name!;
      const data = loadScenarioFromStorage(name);
      if (data) {
        loadScenario(data.scenario, data.slots, data.missions);
        setStatus(`Loaded "${name}"`);
      }
    }
    if (action === "delete-saved") {
      const name = btn.dataset.name!;
      deleteScenarioFromStorage(name);
      setStatus(`Deleted "${name}"`);
      renderExportPanel(container);
    }
    if (action === "export-json") {
      const payload = {
        version: 1,
        scenario: state.scenario,
        slots: state.slots,
        missions: state.missions,
        robotStates: state.robots,
      };
      const dateStr = new Date().toISOString().split("T")[0];
      downloadJSON(payload, `${state.scenario.name.replace(/\s+/g, "-").toLowerCase()}-${dateStr}.json`);
      setStatus("Scenario JSON exported");
    }
    if (action === "export-inventory") {
      downloadCSV(slotsToCSV(state.slots), `inventory-${Date.now()}.csv`);
      setStatus("Inventory CSV exported");
    }
    if (action === "export-missions") {
      downloadCSV(missionsToCSV(state.missions), `missions-${Date.now()}.csv`);
      setStatus("Mission log CSV exported");
    }
    if (action === "export-screenshot") {
      const ss = getSceneState();
      if (ss) {
        exportScreenshot(ss.renderer, `warehouse-screenshot-${Date.now()}.png`);
        setStatus("Screenshot exported");
      }
    }
    if (action === "export-glb") {
      const ss = getSceneState();
      if (ss) {
        try {
          const dateStr = new Date().toISOString().split("T")[0];
          await exportGLB(ss.scene, `${state.scenario.name.replace(/\s+/g, "-").toLowerCase()}-${dateStr}.glb`);
          setStatus("GLB exported");
        } catch (err) {
          setStatus(`GLB export failed: ${err}`);
        }
      }
    }
    if (action === "export-sdf") {
      const sdf = generateSDFWorld(state.scenario, state.slots, state.robots);
      const blob = new Blob([sdf], { type: "application/xml" });
      downloadBlob(blob, `${state.scenario.name.replace(/\s+/g, "-").toLowerCase()}-${Date.now()}.world`);
      setStatus("SDF world exported");
    }
    if (action === "export-cad") {
      const prompt = generateTextToCADPrompt(state.scenario);
      const blob = new Blob([prompt], { type: "text/markdown" });
      downloadBlob(blob, `text-to-cad-prompt-${Date.now()}.md`);
      setStatus("CAD prompt exported");
    }
    if (action === "export-trace-json") {
      const json = exportTracesAsJSON();
      const blob = new Blob([json], { type: "application/json" });
      downloadBlob(blob, `mission-traces-${Date.now()}.json`);
      setStatus("Trace JSON exported");
    }
    if (action === "export-trace-csv") {
      const csv = exportTracesAsCSV();
      downloadCSV(csv, `mission-traces-${Date.now()}.csv`);
      setStatus("Trace CSV exported");
    }
    if (action === "reset-default") {
      const { createDefaultScenario } = await import("../app/defaultScenario");
      loadScenario(createDefaultScenario());
      setStatus("Reset to default scenario");
    }
  };
}
