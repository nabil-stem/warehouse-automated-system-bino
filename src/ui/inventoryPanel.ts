import { getState, rebuildWorld, setState, setStatus } from "../app/appState";
import { downloadCSV, slotsToCSV } from "../app/persistence";
import type { RowInventoryRule } from "../domain/schema";

export function renderInventoryPanel(container: HTMLElement) {
  const s = getState().scenario;
  const inv = s.inventory;
  const slots = getState().slots;
  const occupiedCount = slots.filter(sl => sl.occupied).length;

  container.innerHTML = `
    <div class="panel-section">
      <h3>Global Settings</h3>
      <label class="ctrl"><span>Fill rate (%)</span>
        <input type="number" data-field="fillRate" value="${(s.boxes.defaultFillRate * 100).toFixed(0)}" min="0" max="100" /></label>
      <label class="ctrl"><span>Hot SKU (%)</span>
        <input type="number" data-field="hotSku" value="${inv.hotSkuPercentage}" min="0" max="100" /></label>
      <label class="ctrl"><span>Empty slots (%)</span>
        <input type="number" data-field="emptySlots" value="${inv.emptySlotPercentage}" min="0" max="100" /></label>
      <label class="ctrl"><span>SKU families</span>
        <input type="text" data-field="skuFamilies" value="${inv.skuFamilies.join(",")}" /></label>
      <div class="stat-row">
        <span>Slots: ${slots.length}</span>
        <span>Occupied: ${occupiedCount}</span>
        <span>Fill: ${slots.length > 0 ? ((occupiedCount / slots.length) * 100).toFixed(1) : 0}%</span>
      </div>
    </div>
    <div class="panel-section">
      <h3>Row Rules</h3>
      <div class="row-rules-table" id="row-rules">
        <div class="row-rule-header">
          <span>Row</span><span>Fill%</span><span>Boxes/Bay</span><span>SKUs</span><span></span>
        </div>
        ${inv.rowRules.map((rule, i) => rowRuleRow(rule, i)).join("")}
      </div>
      <button class="btn btn-sm" data-action="add-rule">+ Add Row Rule</button>
    </div>
    <div class="panel-section panel-actions">
      <button class="btn btn-primary" data-action="rebuild">Apply & Rebuild</button>
      <button class="btn" data-action="randomize">Randomize Inventory</button>
      <button class="btn" data-action="export-csv">Export Inventory CSV</button>
      <label class="btn btn-file">Import Inventory/Row CSV
        <input type="file" accept=".csv" data-action="import-csv" hidden />
      </label>
    </div>
  `;

  container.onchange = (e) => {
    const target = e.target as HTMLInputElement;
    const f = target.dataset.field;
    if (f === "fillRate") {
      s.boxes.defaultFillRate = Math.max(0, Math.min(100, parseFloat(target.value) || 0)) / 100;
    } else if (f === "hotSku") {
      inv.hotSkuPercentage = clampPercent(parseFloat(target.value) || 0);
    } else if (f === "emptySlots") {
      inv.emptySlotPercentage = clampPercent(parseFloat(target.value) || 0);
    } else if (f === "skuFamilies") {
      inv.skuFamilies = target.value.split(",").map(s => s.trim()).filter(Boolean);
    }

    if (target.dataset.action === "import-csv" && target.files?.[0]) {
      importInventoryCSV(target.files[0]);
    }
  };

  container.onclick = (e) => {
    const btn = (e.target as HTMLElement).closest("[data-action]") as HTMLElement;
    if (!btn) return;
    if (btn.dataset.action === "rebuild") {
      rebuildWorld();
      renderInventoryPanel(container);
    }
    if (btn.dataset.action === "randomize") {
      s.seed = Math.floor(Math.random() * 999999) + 1;
      rebuildWorld();
      setStatus(`Inventory randomized with seed ${s.seed}`);
      renderInventoryPanel(container);
    }
    if (btn.dataset.action === "export-csv") {
      downloadCSV(slotsToCSV(getState().slots), `inventory-${Date.now()}.csv`);
      setStatus("Inventory CSV exported");
    }
    if (btn.dataset.action === "add-rule") {
      inv.rowRules.push({ rowIndex: inv.rowRules.length, fillRate: s.boxes.defaultFillRate });
      renderInventoryPanel(container);
    }
    if (btn.dataset.action === "remove-rule") {
      const idx = parseInt(btn.dataset.idx ?? "0");
      inv.rowRules.splice(idx, 1);
      renderInventoryPanel(container);
    }
  };

  container.oninput = (e) => {
    const target = e.target as HTMLInputElement;
    if (target.dataset.ruleField) {
      const idx = parseInt(target.dataset.ruleIdx ?? "0");
      const rule = inv.rowRules[idx];
      if (!rule) return;
      const field = target.dataset.ruleField;
      if (field === "rowIndex") rule.rowIndex = parseInt(target.value) || 0;
      else if (field === "fillRate") rule.fillRate = (parseFloat(target.value) || 0) / 100;
      else if (field === "boxesPerBay") rule.boxesPerBay = parseInt(target.value) || undefined;
      else if (field === "skuFamilies") rule.skuFamilies = target.value.split("|").filter(Boolean);
    }
  };
}

function rowRuleRow(rule: RowInventoryRule, index: number): string {
  return `<div class="row-rule">
    <input type="number" data-rule-idx="${index}" data-rule-field="rowIndex" value="${rule.rowIndex}" min="0" max="100" />
    <input type="number" data-rule-idx="${index}" data-rule-field="fillRate" value="${(rule.fillRate * 100).toFixed(0)}" min="0" max="100" />
    <input type="number" data-rule-idx="${index}" data-rule-field="boxesPerBay" value="${rule.boxesPerBay ?? ""}" min="0" max="20" />
    <input type="text" data-rule-idx="${index}" data-rule-field="skuFamilies" value="${(rule.skuFamilies ?? []).join("|")}" placeholder="A|B" />
    <button class="btn btn-sm btn-danger" data-action="remove-rule" data-idx="${index}">x</button>
  </div>`;
}

function importInventoryCSV(file: File) {
  const reader = new FileReader();
  reader.onload = () => {
    const text = reader.result as string;
    const allLines = text.trim().split(/\r?\n/).filter(Boolean);
    const header = allLines[0]?.split(",").map(s => s.trim()) ?? [];
    if (header.includes("bay") && header.includes("level")) {
      importSlotCSV(header, allLines.slice(1));
      return;
    }

    const lines = allLines.slice(1);
    const rules: RowInventoryRule[] = [];
    for (const line of lines) {
      const parts = line.split(",").map(s => s.trim());
      if (parts.length < 2) continue;
      rules.push({
        rowIndex: parseInt(parts[0]) || 0,
        fillRate: parseFloat(parts[1]) || 0.5,
        boxesPerBay: parts[2] ? parseInt(parts[2]) : undefined,
        skuFamilies: parts[3] ? parts[3].split("|").filter(Boolean) : undefined,
      });
    }
    getState().scenario.inventory.rowRules = rules;
    setStatus(`Imported ${rules.length} row rules`);
    rebuildWorld();
  };
  reader.readAsText(file);
}

function importSlotCSV(header: string[], lines: string[]) {
  const state = getState();
  const indexOf = (name: string) => header.indexOf(name);
  const rowIdx = indexOf("row");
  const bayIdx = indexOf("bay");
  const levelIdx = indexOf("level");
  const sideIdx = indexOf("side");
  const skuIdx = indexOf("sku");
  const occupiedIdx = indexOf("occupied");
  const demandIdx = indexOf("demandScore");
  const updates = new Map<string, { sku?: string; occupied: boolean; demandScore: number }>();

  for (const line of lines) {
    const parts = line.split(",").map(s => s.trim());
    const row = (parseInt(parts[rowIdx]) || 1) - 1;
    const bay = (parseInt(parts[bayIdx]) || 1) - 1;
    const level = (parseInt(parts[levelIdx]) || 1) - 1;
    const side = (parts[sideIdx] ?? "left").toLowerCase().startsWith("l") ? -1 : 1;
    const key = `${row}|${bay}|${level}|${side}`;
    updates.set(key, {
      sku: parts[skuIdx] || undefined,
      occupied: /^(true|1|yes)$/i.test(parts[occupiedIdx] ?? ""),
      demandScore: Math.max(1, Math.min(10, parseFloat(parts[demandIdx]) || 1)),
    });
  }

  const nextSlots = state.slots.map(slot => {
    const update = updates.get(`${slot.rowIndex}|${slot.bayIndex}|${slot.levelIndex}|${slot.side}`);
    return update ? { ...slot, ...update } : slot;
  });
  setState({ slots: nextSlots, statusMessage: `Imported ${updates.size} inventory rows` });
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}
