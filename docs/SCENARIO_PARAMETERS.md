# Scenario Parameters Reference

All parameters are fields of the `WarehouseScenario` object. Edit them via the sidebar tabs or by importing a JSON scenario file.

## Top-Level

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Scenario display name |
| `seed` | number | Random seed for deterministic mission/inventory generation |
| `units` | `"meters"` | All dimensions are in meters |

## `warehouse` — Floor Dimensions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `width` | number | 60 | Floor width (X axis) in meters |
| `depth` | number | 40 | Floor depth (Z axis) in meters |
| `floorThickness` | number | 0.15 | Concrete slab thickness |
| `wallHeight` | number | 10 | Perimeter wall height (when shown) |
| `showWalls` | boolean | false | Render perimeter walls |
| `gridSpacing` | number | 1 | Navigation grid cell size |

## `racks` — Rack Layout

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `rowCount` | number | 12 | Number of rack rows |
| `baysPerRow` | number | 14 | Bays per row |
| `levels` | number | 3 | Shelf levels per bay |
| `bayWidth` | number | 1.2 | Width of each bay in meters |
| `shelfDepth` | number | 1.0 | Depth of each shelf |
| `levelHeight` | number | 1.5 | Vertical spacing between levels |
| `bottomShelfHeight` | number | 0.3 | Height of the lowest shelf above floor |
| `rowPitch` | number | 3.8 | Center-to-center distance between rows |
| `aisleWidth` | number | 1.8 | Width of picking aisles between rows |
| `mainAisleWidth` | number | 3.0 | Width of main cross-aisles |
| `crossAisleEveryBays` | number | 7 | Insert a cross-aisle every N bays |
| `crossAisleWidth` | number | 2.0 | Width of cross-aisles |
| `rackBeamThickness` | number | 0.06 | Beam member thickness |
| `uprightThickness` | number | 0.08 | Upright member thickness |

## `boxes` — Box/Tote Dimensions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `width` | number | 0.4 | Box width |
| `height` | number | 0.25 | Box height |
| `depth` | number | 0.3 | Box depth |
| `defaultFillRate` | number | 0.8 | Fraction of slots filled (0–1) |
| `maxStackPerSlot` | number | 2 | Max boxes per slot |

## `inventory` — Inventory Generation

| Parameter | Type | Description |
|-----------|------|-------------|
| `skuFamilies` | string[] | List of SKU family names for generation |
| `rowRules` | RowInventoryRule[] | Per-row overrides (see below) |
| `hotSkuPercentage` | number | Fraction of SKUs marked high-demand (0–1) |
| `emptySlotPercentage` | number | Fraction of slots left empty (0–1) |

### `RowInventoryRule`

| Field | Type | Description |
|-------|------|-------------|
| `rowIndex` | number | Which row (0-based) this rule applies to |
| `fillRate` | number | Override fill rate for this row |
| `boxesPerBay` | number? | Override boxes per bay |
| `skuFamilies` | string[]? | Restrict SKU families for this row |

## `visual` — Rendering Options

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `rackStyle` | `"shelf"` \| `"pallet"` \| `"bin-wall"` | `"shelf"` | Rack visual style |
| `boxStyle` | `"cartons"` \| `"totes"` | `"cartons"` | Box visual style |
| `polishedFloor` | boolean | true | Reflective floor material |
| `showHazardLanes` | boolean | true | Yellow hazard lane markings |
| `showOverheadStructure` | boolean | true | Ceiling beams and lights |
| `showRackBracing` | boolean | true | Diagonal bracing on racks |
| `showBinFaces` | boolean | true | Front faces on bin-wall racks |
| `showSupportColumns` | boolean | true | Structural columns |
| `showDockDoors` | boolean | true | Loading dock doors |
| `showSafetyBollards` | boolean | true | Safety bollards at row ends |
| `showFloorTrafficMarks` | boolean | true | Floor arrows and markings |
| `showPallets` | boolean | true | Pallet meshes under boxes |
| `referenceModelScale` | number | 1.0 | Scale of the reference GLB model |
| `referenceModelUrl` | string? | — | URL to auto-load a GLB reference model |
| `referenceModelOpacity` | number | 0.5 | Opacity of the reference model overlay |
| `showProceduralUnderReference` | boolean | false | Show procedural geometry under the reference model |

## `robots` — Robot Fleet

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `count` | number | 12 | Number of robots |
| `speedMetersPerSecond` | number | 1.5 | Movement speed |
| `turnSpeedRadPerSecond` | number | 3.0 | Turning speed |
| `footprintWidth` | number | 0.6 | Robot body width |
| `footprintDepth` | number | 0.8 | Robot body depth |
| `bodyHeight` | number | 0.3 | Robot body height |
| `liftMaxHeight` | number | 3.5 | Maximum lift extension height |
| `batteryCapacityMinutes` | number | 480 | Battery capacity in simulated minutes |
| `visualType` | string | `"scissor-lift"` | One of: `compact-lift`, `stacker-amr`, `tote-carrier`, `scissor-lift` |
| `showMast` | boolean | true | Show vertical mast on robot |
| `useCustomModel` | boolean | false | Use uploaded custom model |
| `customModelUrl` | string? | — | URL to custom robot GLB |
| `customModelScale` | number | 1.0 | Scale for custom model |

## `stations[]` — Work Stations

Each entry in the `stations` array:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique station identifier |
| `type` | `"packing"` \| `"inbound"` \| `"charging"` \| `"buffer"` | Station purpose |
| `label` | string | Display label |
| `position` | `{ x, z }` | World position in meters |
| `width` | number | Station width |
| `depth` | number | Station depth |
| `capacity` | number | Max items at station |
| `queueCapacity` | number | Max concurrent missions targeting this station |

## `simulation` — Simulation Config

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `tickMs` | number | 100 | Milliseconds per simulation tick |
| `timeScale` | number | 1.0 | Simulation speed multiplier (0.1–5.0) |
| `missionCount` | number | 10 | Number of missions to generate per batch |
| `routing` | string | `"a-star"` | `direct`, `a-star`, or `reservation-table` |
| `allocator` | string | `"nearest-robot"` | `round-robin`, `nearest-robot`, or `least-busy` |
| `collisionAvoidance` | boolean | true | Enable predictive collision avoidance |
| `showRoutes` | boolean | true | Render robot route lines |
| `showHeatmap` | boolean | false | Render aisle congestion heatmap |
| `showOperationsMap` | boolean | true | Show 2D operations map overlay |
| `operationsMapMode` | string | `"qr-track"` | `layout`, `traffic`, `missions`, `congestion`, `qr-track` |
| `lowBatteryThreshold` | number | 30 | Battery minutes threshold to trigger charging |
| `pickPlaceTimePerLevel` | number | 20 | Extra ticks per shelf level for pick/place (scissor lift time) |
| `maxActiveMissions` | number | 8 | Max simultaneous active missions |
| `robotClearanceMeters` | number | 0.3 | Minimum clearance between robots |

## Mission Types

Missions have a `type` field:

| Type | Description |
|------|-------------|
| `pick-and-drop` | Default. Robot drives to source slot, picks box (extending scissor lift per level), drives to target station, places box. Source slot is reserved from creation to completion. |
| `move-to-point` | Robot drives to a free X/Z position on the warehouse floor. No slot reservation, no pick/place phase. Mission completes when the robot arrives. |

## Robot Camera Modes

The robot camera is controlled from the Robots tab:

| Mode | Behavior |
|------|----------|
| `robot-camera` | First-person view from the robot body, looking forward along its mecanum drive heading |
| `follow` | Third-person chase camera behind and above the robot |

An active camera indicator displays the current mode, robot ID, and robot state. The "Stop Robot Camera" button returns to the default overview preset.

## Obstacle Model

The collision system builds solid rectangles from scenario geometry. Each type can be toggled:

| Type | Config toggle | Default | Notes |
|------|---------------|---------|-------|
| Rack solids | Always on | — | Clearance-buffered rack row segments |
| Station solids | Always on | — | Station footprints |
| Bollards | `visual.showSafetyBollards` | true | Row-end and station-corner bollards |
| Support columns | `visual.showSupportColumns` | true | Structural columns on a 16m grid. **Disabled by default in the default scenario** because they block many nav graph nodes and cause long detours or stuck robots. |
| Dock bumpers | `visual.showDockDoors` | true | Loading dock bumpers at warehouse rear |

## Scissor Lift Level Mapping

The scissor lift extends based on the source slot's `levelIndex` (0-based). Pick/place time formula:

```
waitTicks = 60 + levelIndex * pickPlaceTimePerLevel
```

The visual lift height targets `bottomShelfHeight + levelIndex * levelHeight`. Higher levels produce longer pick times and taller scissor extension animations.

## Mecanum Drive

Robots use a mecanum-style wheel configuration (holonomic motion). In the simulation, they follow orthogonal nav-graph paths and smoothly rotate toward their heading using `turnSpeedRadPerSecond`. The robot camera first-person view looks along this heading.
