import type { WarehouseScenario } from "../domain/schema";

export type ValidationResult = {
  ok: boolean;
  errors: string[];
};

export function validateScenario(value: unknown): ValidationResult {
  const errors: string[] = [];
  const scenario = value as WarehouseScenario | undefined;

  if (!scenario || typeof scenario !== "object") {
    return { ok: false, errors: ["Scenario is not an object"] };
  }
  if (scenario.version !== 1) errors.push("Unsupported scenario version");
  if (scenario.units !== "meters") errors.push("Scenario units must be meters");
  if (!scenario.warehouse) errors.push("Missing warehouse dimensions");
  if (!scenario.racks) errors.push("Missing rack configuration");
  if (!scenario.boxes) errors.push("Missing box configuration");
  if (!scenario.robots) errors.push("Missing robot configuration");
  if (!Array.isArray(scenario.stations)) errors.push("Missing stations");

  if (scenario.warehouse) {
    positive("warehouse.width", scenario.warehouse.width, errors);
    positive("warehouse.depth", scenario.warehouse.depth, errors);
    positive("warehouse.gridSpacing", scenario.warehouse.gridSpacing, errors);
  }
  if (scenario.racks) {
    integerRange("racks.rowCount", scenario.racks.rowCount, 1, 200, errors);
    integerRange("racks.baysPerRow", scenario.racks.baysPerRow, 1, 200, errors);
    integerRange("racks.levels", scenario.racks.levels, 1, 20, errors);
    positive("racks.bayWidth", scenario.racks.bayWidth, errors);
    positive("racks.shelfDepth", scenario.racks.shelfDepth, errors);
    positive("racks.rowPitch", scenario.racks.rowPitch, errors);
  }
  if (scenario.boxes) {
    positive("boxes.width", scenario.boxes.width, errors);
    positive("boxes.height", scenario.boxes.height, errors);
    positive("boxes.depth", scenario.boxes.depth, errors);
  }
  if (scenario.robots) {
    integerRange("robots.count", scenario.robots.count, 1, 500, errors);
    positive("robots.speedMetersPerSecond", scenario.robots.speedMetersPerSecond, errors);
  }

  return { ok: errors.length === 0, errors };
}

function positive(name: string, value: unknown, errors: string[]) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    errors.push(`${name} must be a positive number`);
  }
}

function integerRange(name: string, value: unknown, min: number, max: number, errors: string[]) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    errors.push(`${name} must be an integer from ${min} to ${max}`);
  }
}
