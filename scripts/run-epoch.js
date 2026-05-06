#!/usr/bin/env node
// run-epoch.js — CLI entry point for one epoch.
//
//   node scripts/run-epoch.js <epoch-id>
//
// e.g.:
//   node scripts/run-epoch.js e0-bootstrap
//   node scripts/run-epoch.js e1-first-coal
import { resolve } from "node:path";
import { bootFactorioService } from "../src/factorio-process.js";
import { loadEpoch, runEpoch } from "../src/runner/epoch.js";

const epochId = process.argv[2];
if (!epochId) {
  console.error("usage: run-epoch.js <epoch-id>");
  process.exit(2);
}

const { config, factorio, shutdown } = await bootFactorioService();
console.log(`[run-epoch] foundry HTTP service: ${config.serviceUrl}`);

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
