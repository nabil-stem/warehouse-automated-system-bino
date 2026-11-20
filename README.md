# BINO — Warehouse Swarm Lab

### Interactive 3D simulation for warehouse robot coordination

Design a warehouse, dispatch a fleet of autonomous scissor-lift robots, and examine how missions, traffic, inventory, charging, and parking interact in one browser-based environment.

Developed by **Nabil ES-SAADI** for the **BINO project for the Capgemini competition**. Created in **June 2026**.

**[Project website](https://warehouse-swarm-sim.vercel.app/)** · **[Launch simulator](https://warehouse-swarm-sim.vercel.app/simulator/)** · **[Start jury demo](https://warehouse-swarm-sim.vercel.app/simulator/?demo=jury)**

![BINO simulator showing warehouse racks, robot fleets, packing stations, and the operations map](public/images/warehouse-preview.jpg)

*Actual application view. The warehouse layout and fleet configuration are editable.*

## Contents

- [Overview](#overview)
- [Quick start](#quick-start)
- [Capabilities](#capabilities)
- [Using the simulator](#using-the-simulator)
- [Architecture](#architecture)
- [Verification](#verification)
- [Deployment](#deployment)
- [Project resources](#project-resources)
- [Author and project credit](#author-and-project-credit)

## Overview

BINO makes warehouse automation visible and explorable. A mission involves more than reaching a destination: robots must share aisles, reserve inventory, approach different shelf levels, queue at stations, manage battery levels, and return to available standby bays.

The project combines a configurable simulation with a 3D workspace, an operations map, telemetry, and export tools. It supports competition demonstrations, scenario exploration, and technical analysis of the implemented coordination logic.

The public landing page introduces the project without loading the simulation engine. The full simulator runs at `/simulator/` on the same deployment. Simulation and browser saves run on the client; no application backend or account is required.

### Try the demonstration

1. Open **[Start jury demo](https://warehouse-swarm-sim.vercel.app/simulator/?demo=jury)**. The app loads the warehouse reference and starts a demonstration batch.
2. Watch routes, lift movement, station queues, and parking in the 3D view.
3. Select a robot or switch to follow, robot camera, or lift close-up mode.
4. Review mission progress, throughput, waiting, collisions, and conflicts avoided in the workspace panels.

Use **Home** in the simulator header to return to the project introduction. To restart the demonstration, select **Jury Demo** in the command bar.

## Quick start

### Prerequisites

- **Node.js:** 20.19+ within Node 20, or 22.12+; Node 24 was used for verification. These requirements follow the installed Vite package.
- **npm:** use the committed `package-lock.json` for reproducible dependency installation.
- **Browser:** a modern browser with WebGL support. Hardware acceleration is recommended for 3D rendering.
- **Optional:** Python for the STEP-to-GLB conversion utility; Playwright Chromium for browser checks.

```bash
git clone https://github.com/nabil-stem/warehouse-automated-system-bino.git
cd warehouse-automated-system-bino
npm ci
npm run dev
```

| Local URL | Purpose |
| --- | --- |
| `http://127.0.0.1:5173/` | Project landing page |
| `http://127.0.0.1:5173/simulator/` | Interactive simulator |
| `http://127.0.0.1:5173/simulator/?demo=jury` | Automatic jury demo |

If port 5173 is occupied, use the port printed by Vite.

### Available commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development server. |
| `npm run typecheck` | Run strict TypeScript checks. |
| `npm run build` | Check TypeScript and build both pages into `dist/`. |
| `npm run preview` | Serve the production build, normally on port 4173. |
| `npm run test:sim` | Run the headless simulation regression suite. |
| `npm run test:browser` | Run the simulator browser smoke checks. |
| `npm run test:landing` | Verify responsive layouts, metadata, links, simulator entry, and demo startup. |

## Capabilities

| System | Implemented capabilities |
| --- | --- |
| **Warehouse configuration** | Floor dimensions, racks, bays, shelf levels, aisles, cross-aisles, station locations, and visual references. |
| **Inventory** | SKU families, fill rates, row rules, source-slot reservations, and CSV import/export. |
| **Robot fleet** | Configurable fleet size, speed, acceleration, dimensions, battery capacity, and optional custom models. |
| **Mission control** | Generated batches, individual pick-and-drop tasks, point destinations, phase tracking, and queued work. |
| **Traffic coordination** | A* routes, reservation tables, directional lanes, yielding, station queues, and deadlock recovery. |
| **Lift and payload** | Shelf-dependent scissor extension, pickup, lowering, transport, placement, and optional operator round trips. |
| **Charging and parking** | Charging behavior, return-to-standby movement, and assigned parking bays. |
| **Visualization** | Overview, top-down, aisle, follow, robot camera, lift close-up, and an operations map. |
| **Analysis** | Congestion, waiting, route efficiency, mission estimates, physical collisions, and recorded traces. |
| **Exports** | Scenario JSON, inventory CSV, mission logs, PNG screenshots, warehouse GLB, SDF, text-to-CAD prompts, and trace JSON/CSV. |

### Default scenario

These values describe the base configuration in [`src/app/defaultScenario.ts`](src/app/defaultScenario.ts). They are editable settings, not measured performance results.

| Parameter | Default |
| --- | --- |
| Warehouse footprint | 84 × 58 metres before geometry normalization |
| Fleet | 12 scissor-lift robots |
| Racks | 8 rows × 14 bays × 3 shelf levels |
| Travel speed | 2.0 m/s |
| Simulation tick | 100 ms |
| Generated batch size | 10 missions |
| Routing / assignment | Reservation table / nearest robot |

Geometry normalization may adjust the warehouse to fit racks and stations. Jury Demo applies additional demonstration settings, so its batch can differ from the base configuration.

## Using the simulator

| Panel | Purpose |
| --- | --- |
| **Operations** | Control the run and inspect warehouse state. |
| **Missions** | Generate tasks, select source slots or point destinations, and follow task phases. |
| **Fleet** | Configure robots and activate robot camera views. |
| **Warehouse** | Adjust layout, racks, stations, and visual references. |
| **Inventory** | Manage SKU families, occupancy, row rules, and CSV files. |
| **Traffic** | Inspect coordination, queues, and traffic behavior. |
| **Analytics** | Review operational metrics and mission analysis. |
| **Export** | Save scenarios and download data or visual artifacts. |
| **Debug** | Inspect navigation, obstacles, fleet state, and diagnostics. |

**Pick and drop:** a robot travels to a reserved source slot, extends its lift, collects the payload, lowers it, and delivers it to a station. The optional operator round-trip setting returns the payload to its shelf after processing.

**Go to position:** a robot navigates to a chosen X/Z destination. Mission phases report travel and arrival. Robots can accept queued work before returning to standby.

### Reading the metrics

**Collisions** counts detected physical contacts. **Conflicts Avoided** reports avoidance activity. A run can have avoidance events while recording zero physical contacts. Collision-free regression scenarios validate the tested configurations; they do not guarantee every possible user-created layout.

Support columns are disabled by default because dense obstacle configurations can restrict navigation. Use Debug to inspect the graph and obstacle counts when experimenting with layouts.

### Persistence and model files

**Save to Browser** stores scenarios in local storage for the current browser and origin. Download scenario JSON to transfer a scenario or retain a separate copy. Browser saves are not shared cloud storage.

Robot and warehouse reference uploads support `.glb` and `.gltf`. The built-in CAD reference is [`public/models/warehouse-from-step.glb`](public/models/warehouse-from-step.glb). STEP files require conversion before browser use:

```bash
python -m pip install numpy trimesh
python scripts/step_tessellation_to_glb.py Warehouse.step public/models/warehouse-from-step.glb
```

The converter supports tessellated STEP data; consult [its implementation](scripts/step_tessellation_to_glb.py) before using another source model. Reference scale and visibility are available in the Warehouse panel.

## Architecture

The application uses **TypeScript**, **Three.js**, and **Vite**. A shared browser simulation controller advances state and coordinates the domain logic; Three.js renders the warehouse and robot fleet.

```text
Scenario and UI controls
        │
        ▼
Application state and simulation tick
        │
        ├── Warehouse geometry and navigation graph
        ├── Mission assignment and traffic coordination
        ├── Robot movement, lift, battery, and parking state
        └── Metrics and trace recording
        │
        ▼
Three.js scene · Operations map · Panels · Exports
```

| Path | Responsibility |
| --- | --- |
| `index.html`, `src/landing.css` | Public project introduction. |
| `simulator/index.html`, `src/main.ts` | Simulator entry point and frame loop. |
| `src/app/` | Defaults, application state, validation, and persistence. |
| `src/domain/` | Geometry, routing, missions, traffic, metrics, and traces. |
| `src/render/` | Three.js scene, robot visuals, materials, loading, and exports. |
| `src/ui/` | Panels, operations map, dashboard, and camera toolbar. |
| `public/` | Required preview image, favicon, and warehouse model. |
| `scripts/` | Regression tests, browser checks, diagnostics, CAD conversion, and video tools. |
| `docs/` | Parameter reference and Claude Code handoff. |
| `promo/` | Retained demonstration media. |
| `vite.config.ts` | Two-page production build. |

## Verification

### Build and simulation

```bash
npm run build
npm run test:sim
```

The build includes strict TypeScript checking. The headless suite contains **67 scenarios** covering missions, shelf access, traffic, startup spacing, collision detection, charging, parking, and payload round trips. It prints JSON results and exits with a nonzero code if a scenario fails.

### Browser checks

Install the browser runtime once, then keep a development or production-preview server running in another terminal:

```bash
npx playwright install chromium
npm run preview
```

For the production preview, run these checks in PowerShell:

```powershell
$env:TEST_URL = "http://127.0.0.1:4173/simulator/"
$env:LANDING_URL = "http://127.0.0.1:4173/"
npm run test:browser
npm run test:landing
```

For the deployed site, use the same commands with `https://warehouse-swarm-sim.vercel.app/simulator/` and `https://warehouse-swarm-sim.vercel.app/` respectively. Without overrides, the scripts target the development server on port 5173.

- **Simulator checks:** 29 checks covering rendering, CAD loading, panels, dispatch, cameras, export controls, and the competition demo. Several checks report observed intermediate states rather than assert full mission completion; use the headless suite for simulation regression coverage.
- **Landing checks:** widths of 320, 390, 768, 1440, and 1920 px; overflow, image loading, metadata, touch targets, anchors, deferred simulator loading, credit, and network/console errors. The flow also verifies simulator launch, direct refresh, CAD loading, Home navigation, and automatic jury-demo startup with zero physical collisions at startup.

Generated screenshots and `smoke-build-cjs/` are ignored by Git and excluded from production uploads. Browser checks require a working WebGL environment.

## Deployment

Production is hosted on **Vercel** at **[warehouse-swarm-sim.vercel.app](https://warehouse-swarm-sim.vercel.app/)**.

| Route | Page |
| --- | --- |
| `/` | BINO project landing page |
| `/simulator/` | Interactive simulator |
| `/simulator/?demo=jury` | Automatic jury demo |

Use the **Vite** framework preset, **`npm run build`** as the build command, and **`dist`** as the output directory. Both HTML entry points must be included; the application does not need a backend or runtime secrets.

```bash
npx vercel login
npx vercel --prod
```

For an existing local checkout, preserve `.vercel/project.json` to deploy to the associated project. For a fresh clone, select the existing `warehouse-swarm-sim` project when linking. Vercel account files stay out of Git.

`.vercelignore` excludes documentation, local tools, and promotional media from build uploads. Required website assets belong in `public/`. After deployment, verify both routes, direct refresh, images, model loading, and the jury-demo action.

## Project resources

- [Full scenario parameter reference](docs/SCENARIO_PARAMETERS.md)
- [Claude Code implementation and continuation prompt](docs/CLAUDE_CODE_PROMPT.md)
- [Simulation regression suite](scripts/sim_smoke_test.ts)
- [Simulator browser checks](scripts/browser_smoke_test.mjs)
- [Landing-page browser checks](scripts/landing_smoke_test.mjs)
- [Retained swarm demonstration](promo/warehouse-swarm-lab-swarm-promo.webm)

Preview and video tools drive the actual simulator with Playwright. Set `PROMO_URL` for the `create_*_video.mjs` scripts or `PREVIEW_URL` for `capture_blue_preview.mjs` when using another server. Their default simulator URL is `http://127.0.0.1:5173/simulator/`; raw recordings belong in the ignored `promo/recordings/` folder.

## Author and project credit

I made this simulator for our **BINO project for the Capgemini competition**.

**Created by:** Nabil ES-SAADI<br>
**Date made:** June 2026<br>
**Copyright:** © 2026 Nabil ES-SAADI
