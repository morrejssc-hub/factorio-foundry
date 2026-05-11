#!/usr/bin/env node
// run-dag.js — Run epochs in DAG topological order with graph-backed state.
//
//   node scripts/run-dag.js [--from <epoch-id>] [--to <epoch-id>] [--force]
//                           [--from-artifact <artifact-id>]
//                           [--parallel <N>] [--dry-run]
//
// Skipping is based on state/graph/refs.json selected artifacts, not on
// output_save files. Legacy input_save remains the fallback when graph has no
// selected artifact for an epoch dependency.
import { bootFactorioService } from "../src/factorio-process.js";
import { loadConfig } from "../src/config.js";
import { FoundryController } from "../src/runner/foundry-controller.js";

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { from: null, to: null, fromArtifactId: null, force: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from") out.from = args[++i];
    else if (args[i] === "--to") out.to = args[++i];
    else if (args[i] === "--from-artifact") out.fromArtifactId = args[++i];
    else if (args[i] === "--force") out.force = true;
    else if (args[i] === "--dry-run") out.dryRun = true;
    else if (args[i] === "--parallel") {
      const n = parseInt(args[++i], 10);
      if (!Number.isFinite(n) || n < 1) {
        console.error("--parallel requires a positive integer");
        process.exit(2);
      }
      process.env.FOUNDRY_PARALLEL_CANDIDATES = String(n);
    } else {
      console.error(`unknown argument: ${args[i]}`);
      process.exit(2);
    }
  }
  return out;
}

function describeInput(input) {
  if (!input || input.source === "none") return "input=none";
  const artifact = input.artifactId ? ` artifact=${input.artifactId}` : "";
  return `input=${input.path} source=${input.source}${artifact}`;
}

function describeSelected(step) {
  return step.selectedArtifactId ? `selected=${step.selectedArtifactId}` : "selected=-";
}

const opts = parseArgs(process.argv);

if (opts.dryRun) {
  const config = loadConfig();
  const controller = new FoundryController({ config });
  try {
    const plan = await controller.planDag({
      from: opts.from,
      to: opts.to,
      fromArtifactId: opts.fromArtifactId,
    });
    console.log(`[run-dag] DAG: ${plan.dag.id}`);
    console.log(`[run-dag] ${plan.steps.length} epoch(s) in plan: ${plan.steps.map((step) => step.id).join(" -> ")}`);
    for (const step of plan.steps) {
      console.log(`[run-dag] dry ${step.id}: ${describeInput(step.input)} ${describeSelected(step)}`);
    }
    console.log("[run-dag] --dry-run: exiting without running");
  } catch (error) {
    console.error(`[run-dag] failed: ${error.message}`);
    process.exit(1);
  }
  process.exit(0);
}

const { config, factorio, shutdown } = await bootFactorioService();
const controller = new FoundryController({ config, factorio });
console.log(`[run-dag] foundry HTTP service: ${config.serviceUrl}`);

const results = [];
let exitCode = 0;

try {
  const plan = await controller.planDag({
    from: opts.from,
    to: opts.to,
    fromArtifactId: opts.fromArtifactId,
  });
  console.log(`[run-dag] DAG: ${plan.dag.id}`);
  console.log(`[run-dag] ${plan.steps.length} epoch(s) in plan: ${plan.steps.map((step) => step.id).join(" -> ")}`);

  const resumeRun = !!opts.fromArtifactId;
  for (const [index, step] of plan.steps.entries()) {
    const selected = await controller.selectedArtifact(step.id);
    if (!opts.force && !resumeRun && selected) {
      console.log(`[run-dag] skipping ${step.id}: graph selected artifact exists (${selected.artifact_id}); use --force to re-run`);
      results.push({ id: step.id, status: "skipped", selectedArtifactId: selected.artifact_id });
      continue;
    }

    const input = await controller.resolveEpochInput({
      epoch: step.epoch,
      fromArtifactId: index === 0 ? opts.fromArtifactId : null,
    });
    console.log(`\n[run-dag] -- running epoch: ${step.id} --`);
    console.log(`[run-dag] ${step.id}: ${describeInput(input)}`);
    const t0 = Date.now();
    try {
      const result = await controller.runEpoch({
        epoch: step.epoch,
        fromArtifactId: index === 0 ? opts.fromArtifactId : null,
      });
      const wall = ((Date.now() - t0) / 1000).toFixed(1);
      const status = result.ok ? "pass" : "fail";
      console.log(`[run-dag] ${step.id}: ${status} in ${wall}s graph_run=${result.graph?.runId}`);
      results.push({ id: step.id, status, wall_s: +wall, result });
      if (!result.ok) {
        console.error(`[run-dag] epoch ${step.id} did not pass; stopping DAG run`);
        exitCode = 1;
        break;
      }
    } catch (error) {
      const wall = ((Date.now() - t0) / 1000).toFixed(1);
      console.error(`[run-dag] epoch ${step.id} threw after ${wall}s: ${error.message}`);
      results.push({ id: step.id, status: "error", wall_s: +wall, error: error.message });
      exitCode = 1;
      break;
    }
  }
} catch (error) {
  console.error(`[run-dag] failed: ${error.message}`);
  exitCode = 1;
} finally {
  await shutdown();
}

console.log("\n[run-dag] -- summary --");
for (const r of results) {
  const icon = r.status === "pass" ? "PASS" : r.status === "skipped" ? "SKIP" : "FAIL";
  const wall = r.wall_s != null ? ` (${r.wall_s}s)` : "";
  console.log(`  ${icon} ${r.id}${wall}`);
}

process.exit(exitCode);
