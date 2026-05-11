#!/usr/bin/env node
// run-epoch.js — CLI entry point for one epoch.
//
//   node scripts/run-epoch.js <epoch-id> [--parallel <N>] [--from-artifact <artifact-id>]
//
// --parallel N   run N candidates simultaneously
import { resolve } from "node:path";
import { bootFactorioService } from "../src/factorio-process.js";
import { loadEpoch } from "../src/runner/epoch.js";
import { FoundryController } from "../src/runner/foundry-controller.js";

// Parse flags before bootFactorioService() so env vars are set first.
const args = process.argv.slice(2);
let epochId = null;
let fromArtifactId = null;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--parallel") {
    i++;
  } else if (arg === "--from-artifact") {
    fromArtifactId = args[++i];
  } else if (arg.startsWith("--")) {
    console.error(`unknown argument: ${arg}`);
    process.exit(2);
  } else if (!epochId) {
    epochId = arg;
  } else {
    console.error(`unexpected argument: ${arg}`);
    process.exit(2);
  }
}
if (!epochId) {
  console.error("usage: run-epoch.js <epoch-id> [--parallel <N>] [--from-artifact <artifact-id>]");
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
if (args.includes("--from-artifact") && !fromArtifactId) {
  console.error("--from-artifact requires an artifact id");
  process.exit(2);
}

const { config, factorio, shutdown } = await bootFactorioService();
const controller = new FoundryController({ config, factorio });
console.log(`[run-epoch] foundry HTTP service: ${config.serviceUrl}`);
if (config.parallelCandidates > 1) {
  console.log(`[run-epoch] parallel mode: ${config.parallelCandidates} candidates`);
}

let exitCode = 0;
try {
  const epoch = await loadEpoch(resolve(config.rootDir, "epochs"), epochId);
  console.log(`[run-epoch] epoch ${epoch.id} kind=${epoch.kind}`);
  const result = await controller.runEpoch({ epoch, fromArtifactId });
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
