#!/usr/bin/env node
// run-epoch.js — CLI entry point for one epoch.
//
//   node scripts/run-epoch.js <epoch-id> [--parallel <N>]
//
// --parallel N   run N candidates simultaneously
import { resolve } from "node:path";
import { bootFactorioService } from "../src/factorio-process.js";
import { loadConfig } from "../src/config.js";
import { loadEpoch, runEpoch } from "../src/runner/epoch.js";

// Parse flags before loadConfig() so env vars are set first.
const args = process.argv.slice(2);
const epochId = args.find((a) => !a.startsWith("--") && !Number.isFinite(Number(a)));
if (!epochId) {
  console.error("usage: run-epoch.js <epoch-id> [--parallel <N>]");
  process.exit(2);
}

const parallelIdx = args.indexOf("--parallel");
if (parallelIdx !== -1) {
  const n = parseInt(args[parallelIdx + 1], 10);
  if (!Number.isFinite(n) || n < 1) {
    console.error("--parallel requires a positive integer");
    process.exit(2);
  }
  process.env.FOUNDRY_PARALLEL_CANDIDATES = String(n);
}

const { config, factorio, shutdown } = await bootFactorioService();
console.log(`[run-epoch] foundry HTTP service: ${config.serviceUrl}`);
if (config.parallelCandidates > 1) {
  console.log(`[run-epoch] parallel mode: ${config.parallelCandidates} candidates`);
}

let exitCode = 0;
try {
  const epoch = await loadEpoch(resolve(config.rootDir, "epochs"), epochId);
  console.log(`[run-epoch] epoch ${epoch.id} kind=${epoch.kind}`);
  const result = await runEpoch({ config, factorio, epoch });
  console.log(`[run-epoch] result:`, JSON.stringify(result, null, 2));
  if (!result.ok) exitCode = 1;
} catch (error) {
  console.error(`[run-epoch] failed: ${error.message}`);
  console.error(error.stack);
  exitCode = 1;
} finally {
  await shutdown();
}
process.exit(exitCode);
