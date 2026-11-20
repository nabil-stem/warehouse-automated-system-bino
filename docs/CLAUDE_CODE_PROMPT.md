# Claude Code prompt — BINO Warehouse Swarm Lab

Copy the text below into Claude Code while working in the existing `warehouse-swarm-sim` folder.

---

You are working on my existing BINO Warehouse Swarm Lab project at:
`C:\Users\NABIL\CPGE_Quant_Books\warehouse-swarm-sim`

This is a TypeScript + Three.js warehouse robot simulator built with Vite. My production site is https://warehouse-swarm-sim.vercel.app/. Improve the project introduction and documentation, preserve the full simulator, and publish the finished update to the same Vercel project when authenticated.

Start by reading any applicable AGENTS.md, README.md, package.json, vite.config.ts, index.html, simulator/index.html, src/landing.css, src/main.ts, src/styles.css, src/app/defaultScenario.ts, docs/SCENARIO_PARAMETERS.md, and the existing smoke tests. Inspect the actual current implementation before making changes. The landing page and two-page build may already be implemented: continue from the existing state and fix observed shortcomings instead of rebuilding or duplicating working features.

## Required project identity

- Project name: BINO — Warehouse Swarm Lab.
- Creator: Nabil ES-SAADI (preserve the exact spelling and capitalization).
- Date made: June 2026. Do not substitute today's date or invent an exact day.
- Credit: “I made this simulator for our BINO project for the Capgemini competition.”
- Put this credit at the END of the README and include matching credit in the landing-page footer/project section.
- Describe a competition project. Do not invent prizes, results, official endorsements, customers, team members, or quantified performance gains.

## Routes and implementation

- `/` is the public landing page.
- `/simulator/` is the existing interactive simulator.
- `/simulator/?demo=jury` opens the simulator and starts the jury demo after initialization.
- Every “Open simulator” or “Launch” link must open the actual simulator.
- Keep a clearly labeled way to return from the simulator to the homepage.
- Both HTML entry points must be built by Vite and included in dist.
- Keep model paths absolute (for example `/models/warehouse-from-step.glb`) so they work from the simulator subdirectory.
- Keep the homepage lightweight: it should not instantiate the simulator or load its Three.js bundle until the visitor launches it.
- Preserve local storage keys, imports/exports, CAD reference, robot models, navigation, traffic behavior, mission phases, charging, parking, camera modes, jury controls, and scenario editing.
- Update tests and preview/video tools that assumed the simulator was at `/`.
- Do not add a backend, authentication, paid services, or unrelated dependencies.

## Landing page

Refine the existing responsive landing page into a polished industrial robotics project showcase. Use a restrained dark navy, white, and mint palette that relates to the simulator, readable typography, strong hierarchy, intentional spacing, subtle borders, and clear keyboard focus states.

Use real simulator imagery, preferably `public/images/warehouse-preview.jpg`. Do not use stock images of unrelated robots. If replacing the image, capture the actual application and preserve a useful view of the warehouse and robot fleet. Add meaningful alt text and correct image dimensions.

Include a project introduction, a strong launch action, an actual simulator preview, explanations of warehouse configuration/fleet coordination/operational analysis, a short first-run walkthrough, a direct jury-demo action, and the author/project credit. Label default scenario numbers as editable configuration values, not performance results. Read current defaults before displaying them.

Make the homepage usable at 320, 390, 768, and 1440+ pixel widths. Check horizontal overflow, readable text, touch targets, image loading, internal anchors, keyboard focus, and prefers-reduced-motion. Add appropriate title, description, canonical URL, social preview metadata, and favicon. Avoid decorative fake dashboards, fake live metrics, unavailable links, and excessive motion.

## README

Produce professional, accurate project documentation with a clear introduction, image, live links, quick demo walkthrough, feature table, editable defaults, prerequisites, npm commands, simulator panel guide, mission modes, traffic/collision metric explanation, browser-local persistence, exports, tests, project tree, CAD conversion, and Vercel deployment instructions.

Clearly distinguish physical collisions from avoidance events. Do not promise collision-free behavior for every possible configuration. Explain that scenarios saved in the browser use local storage and are not cloud-backed.

Document the exact current routes and commands. The current simulation suite contains 67 cases; inspect the suite if changing the stated count. Browser smoke tests contain some observational checks, so do not present every reported pass as proof of full mission completion. End with my exact credit and creation date.

## Verification

1. Run npm ci only if dependencies need installation.
2. Run npm run build (includes TypeScript checking).
3. Run npm run test:sim if simulation behavior changes; run it at least once for a complete implementation review.
4. Start the production preview and run npm run test:browser with TEST_URL set to its `/simulator/` URL. Install Playwright Chromium only if missing.
5. Inspect screenshots of the homepage at desktop and phone widths. Verify no horizontal overflow and that all internal links target real sections/pages.
6. Open `/simulator/` directly and refresh it. Confirm the CAD model loads, navigation panels work, missions dispatch, and camera controls still work.
7. Open `/simulator/?demo=jury` and verify it starts the demo without requiring another click. Confirm the initial demo reports zero physical collisions in the tested scenario.
8. Check console errors and failed network requests. Fix actual regressions before publishing.
9. Keep generated test files and raw recordings out of source uploads. Preserve all source and unique project assets.

## Vercel publication

Use the existing `.vercel/project.json` association for `warehouse-swarm-sim`; do not create another project, change the domain, or publish to a different host. Use build command `npm run build`, output directory `dist`, and the Vite preset. Preserve the two-page build and public assets.

Check the authenticated account first. If logged out, run `npx vercel login` and provide the actual device-login link/code for me to complete. Never request my password or write credentials into the repository. Finish all independent implementation and testing while waiting for authentication.

Once authenticated, deployment is authorized: run `npx vercel --prod` from this project. Wait for a successful production deployment, then verify the live homepage, `/simulator/`, `/simulator/?demo=jury`, styles, image, model loading, and direct route refresh. Do not claim the update is live until the actual production URL serves the new page.

Report changed files, tests and observed results, the deployed URL, and any remaining blocker. If publication is blocked by authentication, state that clearly and give the exact next command; do not claim deployment succeeded.
