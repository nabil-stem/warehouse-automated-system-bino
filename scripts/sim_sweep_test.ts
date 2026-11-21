/**
 * Randomized robustness sweep. Generates scenario variations from a fixed PRNG (so runs
 * are reproducible) and checks every one against the stress harness invariants. This
 * guards against fixes that only work for the hand-written stress cases.
 *
 * Run with: npm run test:sweep [-- --runs=40 --seed=7]
 */
import { runStressCase, type StressCase } from "./sim_stress_test";

declare const process: { exitCode?: number; argv: string[] };

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function sweepCases(runs: number, seed: number): StressCase[] {
  const rand = prng(seed);
  const pick = <T>(items: T[]) => items[Math.floor(rand() * items.length)];
  const cases: StressCase[] = [];
  for (let i = 0; i < runs; i++) {
    const robots = pick([6, 8, 10, 12, 14, 16, 20]);
    const missionCount = pick([8, 15, 25, 35]);
    const allocator = pick(["nearest-robot", "nearest-robot", "eta-optimal", "least-busy", "round-robin"] as const);
    const routing = pick(["reservation-table", "reservation-table", "a-star"] as const);
    const narrow = rand() < 0.25;
    const roundTrip = rand() < 0.2;
    const drained = rand() < 0.25;
    const scenarioSeed = 1 + Math.floor(rand() * 10000);
    const maxActive = pick([3, 4, 6]);
    const name = `sweep-${i}-r${robots}-m${missionCount}-${allocator}-${routing}${narrow ? "-narrow" : ""}${roundTrip ? "-rt" : ""}${drained ? "-lowbat" : ""}-s${scenarioSeed}`;
    cases.push({
      name,
      customize: s => {
        s.seed = scenarioSeed;
        s.robots.count = robots;
        s.simulation.missionCount = missionCount;
        s.simulation.allocator = allocator;
        s.simulation.routing = routing;
        s.simulation.maxActiveMissions = maxActive;
        s.simulation.returnBoxesToShelf = roundTrip;
        if (narrow) { s.racks.aisleWidth = 3.0; s.racks.rowPitch = 6.3; }
      },
      prepareRobots: drained ? rs => { for (const r of rs) if (r.id % 4 === 1) r.batteryMinutes = 17; } : undefined,
      maxTicks: 6000 + missionCount * (roundTrip ? 500 : 300),
    });
  }
  return cases;
}

const isMain = typeof process !== "undefined" && process.argv.some(arg => /sim_sweep_test\.js$/.test(arg));
if (isMain) {
  const runs = Number(process.argv.find(a => a.startsWith("--runs="))?.slice(7) ?? 24);
  const seed = Number(process.argv.find(a => a.startsWith("--seed="))?.slice(7) ?? 2026);
  const reports = sweepCases(runs, seed).map(runStressCase);
  for (const r of reports) {
    console.log(`${r.passed ? "PASS" : "FAIL"} ${r.name} done=${r.done}/${r.missions} allDone=${r.allDoneTick} parked=${r.allParkedTick} maxHop=${r.maxHop} stall=${r.maxMissionStallTicks}/${r.maxReturnStallTicks} contacts=${r.bodyContacts} ${r.failures.join("; ")}`);
  }
  const failed = reports.filter(r => !r.passed).length;
  console.log(`\nsweep: ${reports.length - failed}/${reports.length} passed`);
  if (failed > 0) process.exitCode = 1;
}
