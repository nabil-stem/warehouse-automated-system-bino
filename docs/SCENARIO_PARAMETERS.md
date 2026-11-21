# Scenario Parameters Reference

All parameters are fields of the `WarehouseScenario` object defined in [`src/domain/schema.ts`](../src/domain/schema.ts), with baseline defaults configured in [`src/app/defaultScenario.ts`](../src/app/defaultScenario.ts). Edit them live via the simulator sidebar panels or by importing a JSON scenario file.

## Top-Level

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `version` | `1` | `1` | Schema version identifier |
| `name` | `string` | `"Warehouse Swarm Lab"` | Scenario display name |
| `seed` | `number` | `42` | Random seed for deterministic mission and inventory generation |
| `units` | `"meters"` | `"meters"` | All spatial dimensions are expressed in meters |

## `warehouse` — Floor & Envelope Dimensions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `width` | `number` | `84` | Floor width (X axis) in meters before geometry normalization |
| `depth` | `number` | `58` | Floor depth (Z axis) in meters before geometry normalization |
| `floorThickness` | `number` | `0.2` | Concrete slab thickness in meters |
| `wallHeight` | `number` | `8` | Perimeter wall height (when shown) |
| `showWalls` | `boolean` | `true` | Render perimeter walls |
| `showRoof` | `boolean` | `true` | Render overhead roof structure |
| `gridSpacing` | `number` | `4` | Visual floor grid cell spacing in meters |

## `racks` — Storage Rack Layout

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `rowCount` | `number` | `8` | Number of rack rows |
| `baysPerRow` | `number` | `14` | Bays per row |
| `levels` | `number` | `3` | Vertical shelf levels per bay |
| `bayWidth` | `number` | `3.2` | Width of each bay in meters |
| `shelfDepth` | `number` | `1.3` | Depth of each shelf in meters |
| `levelHeight` | `number` | `1.4` | Vertical spacing between shelf levels in meters |
| `bottomShelfHeight` | `number` | `1.2` | Height of the lowest shelf above the floor in meters |
| `rowPitch` | `number` | `7.5` | Center-to-center distance between rack row pairs in meters |
| `aisleWidth` | `number` | `4.2` | Nominal picking aisle width parameter in meters |
| `mainAisleWidth` | `number` | `6.0` | Width of main front/rear cross-corridors in meters |
| `crossAisleEveryBays` | `number` | `4` | Insert a transverse cross-aisle every `N` bays |
| `crossAisleWidth` | `number` | `3.0` | Width of transverse cross-aisles in meters |
| `rackBeamThickness` | `number` | `0.22` | Horizontal beam member thickness in meters |
| `uprightThickness` | `number` | `0.16` | Vertical upright column thickness in meters |

## `boxes` — Box / Tote Dimensions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `width` | `number` | `1.2` | Box width in meters |
| `height` | `number` | `0.7` | Box height in meters |
| `depth` | `number` | `0.8` | Box depth in meters |
| `defaultFillRate` | `number` | `0.78` | Default fraction of storage slots occupied (`0`–`1`) |
| `maxStackPerSlot` | `number` | `1` | Maximum stacked boxes per storage slot |

## `inventory` — Inventory Generation

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `skuFamilies` | `string[]` | `["A14", "B22", "C05", "D73", "E18", "F41", "G09", "H66", "J31"]` | SKU family identifiers used during slot population |
| `rowRules` | `RowInventoryRule[]` | `[]` | Per-row slotting overrides (see below) |
| `hotSkuPercentage` | `number` | `15` | Percentage of SKUs marked high-demand (`0`–`100`) |
| `emptySlotPercentage` | `number` | `22` | Percentage of slots left empty (`0`–`100`) |

### `RowInventoryRule`

| Field | Type | Description |
|-------|------|-------------|
| `rowIndex` | `number` | Target row index (`0`-based) |
| `fillRate` | `number` | Override occupancy fraction for this row (`0`–`1`) |
| `boxesPerBay` | `number?` | Optional override for boxes per bay |
| `skuFamilies` | `string[]?` | Optional subset of SKU families permitted in this row |

## `visual` — Rendering & CAD Overlay Options

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `rackStyle` | `"shelf"` \| `"pallet"` \| `"bin-wall"` | `"pallet"` | Rack structural style |
| `boxStyle` | `"cartons"` \| `"totes"` | `"totes"` | Payload container style |
| `polishedFloor` | `boolean` | `true` | Reflective industrial floor material |
| `showHazardLanes` | `boolean` | `true` | Yellow hazard lane markings |
| `showOverheadStructure` | `boolean` | `true` | Ceiling trusses and lighting fixtures |
| `showRackBracing` | `boolean` | `true` | Diagonal structural bracing on racks |
| `showBinFaces` | `boolean` | `true` | Front faces on bin-wall racks |
| `showSupportColumns` | `boolean` | `false` | Structural columns (disabled by default to avoid blocking custom narrow aisles) |
| `showDockDoors` | `boolean` | `true` | Loading dock doors along the perimeter |
| `showSafetyBollards` | `boolean` | `true` | Protective yellow bollards at rack row ends and stations |
| `showFloorTrafficMarks` | `boolean` | `false` | Painted floor arrows and lane markings |
| `showPallets` | `boolean` | `true` | Pallet meshes beneath stored boxes |
| `referenceModelScale` | `number` | `22` | Scale factor for the reference `.glb` CAD overlay |
| `referenceModelUrl` | `string?` | `"/models/warehouse-from-step.glb"` | URL of the auto-loaded `.glb` reference warehouse model |
| `referenceModelOpacity` | `number` | `0.42` | Opacity of the reference CAD model overlay (`0`–`1`) |
| `showProceduralUnderReference` | `boolean` | `true` | Render procedural warehouse geometry alongside the reference model |

## `robots` — Autonomous Robot Fleet

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `count` | `number` | `12` | Total number of robots in the fleet |
| `speedMetersPerSecond` | `number` | `2.0` | Maximum linear travel speed in `m/s` |
| `turnSpeedRadPerSecond` | `number` | `3.0` | Angular turning rate in `rad/s` |
| `maxAccelerationMps2` | `number?` | `5.5` | Maximum linear acceleration in `m/s²` |
| `maxDecelerationMps2` | `number?` | `6.5` | Maximum braking deceleration in `m/s²` |
| `footprintWidth` | `number` | `1.2` | Robot chassis width in meters |
| `footprintDepth` | `number` | `1.0` | Robot chassis depth in meters |
| `bodyHeight` | `number` | `0.65` | Robot chassis base height in meters |
| `liftMaxHeight` | `number` | `4.0` | Maximum vertical reach of the scissor lift in meters |
| `batteryCapacityMinutes` | `number` | `120` | Full battery capacity in simulated minutes |
| `visualType` | `"compact-lift"` \| `"stacker-amr"` \| `"tote-carrier"` \| `"scissor-lift"` | `"scissor-lift"` | 3D robot chassis visual model |
| `showMast` | `boolean` | `true` | Render vertical stabilization mast on the robot |
| `useCustomModel` | `boolean` | `false` | Replace procedural robot mesh with a custom uploaded `.glb` |
| `customModelUrl` | `string?` | — | Object URL or path to custom robot `.glb` |
| `customModelScale` | `number` | `1.0` | Scale multiplier for custom robot `.glb` |

## `stations[]` — Operational Work Stations

Default stations: `PACK_A` (`-20, -22`), `PACK_B` (`20, -22`), `INBOUND` (`0, 22`), and `CHARGE_A` (`-30, 24`).

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique station identifier |
| `type` | `"packing"` \| `"inbound"` \| `"charging"` \| `"buffer"` | Functional station role |
| `label` | `string` | Human-readable label shown in UI and 3D badges |
| `position` | `{ x: number, z: number }` | World coordinates on the warehouse floor in meters |
| `width` | `number` | Station footprint width in meters |
| `depth` | `number` | Station footprint depth in meters |
| `capacity` | `number` | Maximum item capacity at the station |
| `queueCapacity` | `number` | Maximum concurrent robots queued/serviced at this station |

## `simulation` — Simulation & Coordination Engine

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `tickMs` | `number` | `100` | Simulated milliseconds per discrete tick |
| `timeScale` | `number` | `1.0` | Playback speed multiplier (`0.1`–`5.0`) |
| `missionCount` | `number` | `10` | Number of missions created when clicking **Generate Missions** |
| `routing` | `"direct"` \| `"a-star"` \| `"reservation-table"` | `"reservation-table"` | Pathfinding and space-time reservation algorithm |
| `allocator` | `"round-robin"` \| `"nearest-robot"` \| `"least-busy"` \| `"eta-optimal"` | `"nearest-robot"` | Task-to-robot assignment strategy |
| `collisionAvoidance` | `boolean` | `true` | Enable predictive spacing, yielding, and deadlock recovery |
| `showRoutes` | `boolean` | `true` | Render active robot route polylines in 3D |
| `showHeatmap` | `boolean` | `false` | Render aisle congestion heatmap overlay |
| `showOperationsMap` | `boolean` | `true` | Show the 2D Operations Map HUD |
| `operationsMapMode` | `"layout"` \| `"traffic"` \| `"missions"` \| `"congestion"` \| `"qr-track"` | `"qr-track"` | Active visualization layer in the 2D Operations Map |
| `lowBatteryThreshold` | `number` | `15` | Remaining battery minutes threshold that triggers charging dispatch |
| `pickPlaceTimePerLevel` | `number` | `20` | Additional ticks per vertical shelf tier for scissor-lift extension |
| `maxActiveMissions` | `number` | `4` | Base limit on simultaneously active missions |
| `autoScaleActiveMissions` | `boolean` | `true` | Dynamically scale active mission concurrency with fleet size and aisle capacity |
| `robotClearanceMeters` | `number` | `0.22` | Minimum safety clearance buffer around robot footprints in meters |
| `aisleLanes` | `AisleLaneConfig[]` | `[]` | Optional per-aisle directional overrides (`one-way-forward`, `one-way-reverse`, `two-way`) |
| `showYieldBays` | `boolean` | `true` | Render yield-bay markers in the 3D scene |
| `showLaneGeometry` | `boolean` | `true` | Render navigation graph lanes and QR waypoints |
| `parkingStrategy` | `"home-slots"` \| `"farthest-free"` \| `"nearest-free"` \| `"least-congested"` \| `"balanced-sides"` | `"home-slots"` | Standby bay selection policy when robots complete work |
| `returnBoxesToShelf` | `boolean?` | `false` | Operator round-trip mode: return processed boxes from station back to their origin shelf slot |
| `operatorProcessTicks` | `number?` | `120` | Ticks spent by station operator processing a box before return-to-shelf transport |
| `juryChargingShowcase` | `boolean?` | `true` | Include a low-battery robot during Jury Demo to showcase autonomous charging dispatch |

## Mission Types

| Type | Description |
|------|-------------|
| `pick-and-drop` | Default fulfillment mission. The source slot is atomically reserved upon creation. An assigned robot travels to the rack access node, elevates its scissor lift to the slot's `levelIndex`, picks the tote, lowers the lift, travels to the target station, and places the tote (with optional operator round-trip back to the shelf when `returnBoxesToShelf` is enabled). |
| `move-to-point` | Point-to-point navigation mission. The assigned robot travels along the navigation graph to a target `(X, Z)` floor coordinate without slot reservation or lift actuation. |

## Camera Modes

| Mode | Behavior |
|------|----------|
| `overview` | Orbiting perspective camera framing the full warehouse floor |
| `top-down` | Planimetric overhead view for layout and traffic inspection |
| `aisle` | Low-angle perspective aligned down a picking corridor |
| `follow` | Third-person chase camera tracking the selected robot |
| `robot-camera` | First-person view mounted on the selected robot chassis looking along its heading |
| `lift-closeup` | Close-up inspection camera focused on the selected robot's scissor-lift mechanism |

## Obstacle Model & Scissor Lift Timing

Solid collision rectangles are constructed from the scenario geometry:

- **Rack & Station Solids:** Always active, padded by robot clearance during path planning.
- **Safety Bollards (`visual.showSafetyBollards`):** Enabled by default at rack ends and station corners.
- **Dock Bumpers (`visual.showDockDoors`):** Enabled by default along rear dock doors.
- **Support Columns (`visual.showSupportColumns`):** Disabled by default (`false`) so custom narrow-aisle layouts are not obstructed by fixed structural grids.

When picking or placing at shelf tier `levelIndex` (`0`-based), the scissor lift targets height `bottomShelfHeight + levelIndex * levelHeight` and takes:

```text
waitTicks = 60 + levelIndex * pickPlaceTimePerLevel
```
