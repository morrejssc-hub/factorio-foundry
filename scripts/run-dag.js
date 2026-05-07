#!/usr/bin/env node
// run-dag.js — Run epochs in DAG topological order.
//
//   node scripts/run-dag.js [--from <epoch-id>] [--to <epoch-id>] [--force]
//                           [--parallel <N>] [--benchmark] [--dry-run]
//
// Reads epochs/dag.yaml, resolves topological order, and runs each epoch
// in sequence using the same Factorio service instance. Epochs whose
// output_save already exists on disk are skipped (unless --force is given).
//
// --from <id>      start from this epoch (and its transitive dependents)
// --to <id>        stop after this epoch
// --force          re-run even if output_save already exists
// --parallel <N>   pass through to each epoch (implies benchmark audit)
// --benchmark      use fast benchmark audit instead of 60s live window
// --dry-run        print the planned execution order and exit without running
import { resolve } from "node:path";
import { readFile, access } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { bootFactorioService } from "../src/factorio-process.js";
import { loadEpoch, runEpoch } from "../src/runner/epoch.js";

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { from: null, to: null, force: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from") out.from = args[++i];
    else if (args[i] === "--to") out.to = args[++i];
    else if (args[i] === "--force") out.force = true;
    else if (args[i] === "--dry-run") out.dryRun = true;
    else if (args[i] === "--parallel") {
      const n = parseInt(args[++i], 10);
      if (!Number.isFinite(n) || n < 1) {
        console.error("--parallel requires a positive integer");
        process.exit(2);
      }
      process.env.FOUNDRY_PARALLEL_CANDIDATES = String(n);
    } else if (args[i] === "--benchmark") {
      process.env.FOUNDRY_BENCHMARK_AUDIT = "1";
    } else {
      console.error(`unknown argument: ${args[i]}`);
      process.exit(2);
    }
  }
  if (process.env.FOUNDRY_PARALLEL_CANDIDATES && Number(process.env.FOUNDRY_PARALLEL_CANDIDATES) > 1) {
    process.env.FOUNDRY_BENCHMARK_AUDIT = "1";
  }
  return out;
}

function topoSort(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const visited = new Set();
  const result = [];
  function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const node = byId.get(id);
    if (!node) return;
    for (const dep of (node.depends_on || [])) visit(dep);
    result.push(node);
  }
  for (const node of nodes) visit(node.id);
  return result;
}

// Inclusive slice: keep nodes from `from` to `to` in topo order.
// If `from` is set, also include all dependencies needed to reach it.
function filterRange(ordered, fromId, toId) {
  let fromIdx = fromId ? ordered.findIndex((n) => n.id === fromId) : 0;
  let toIdx   = toId   ? ordered.findIndex((n) => n.id === toId)   : ordered.length - 1;
  if (fromId && fromIdx === -1) {
    console.error(`--from epoch "${fromId}" not found in DAG`);
    process.exit(2);
  }
  if (toId && toIdx === -1) {
    console.error(`--to epoch "${toId}" not found in DAG`);
    process.exit(2);
  }
  if (fromIdx > toIdx) {
    console.error(`--from "${fromId}" comes after --to "${toId}" in topological order`);
    process.exit(2);
  }
  return ordered.slice(fromIdx, toIdx + 1);
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

const opts = parseArgs(process.argv);

const dagPath = new URL("../epochs/dag.yaml", import.meta.url).pathname;
const dag = parseYaml(await readFile(dagPath, "utf8"));
const ordered = topoSort(dag.nodes || []);
const plan = filterRange(ordered, opts.from, opts.to);

console.log(`[run-dag] DAG: ${dag.id}`);
console.log(`[run-dag] ${plan.length} epoch(s) in plan: ${plan.map((n) => n.id).join(" → ")}`);

if (opts.dryRun) {
  console.log("[run-dag] --dry-run: exiting without running");
  process.exit(0);
}

const { config, factorio, shutdown } = await bootFactorioService();
console.log(`[run-dag] foundry HTTP service: ${config.serviceUrl}`);

const results = [];
let exitCode = 0;

try {
  for (const node of plan) {
    const epoch = await loadEpoch(resolve(config.rootDir, "epochs"), node.id);

    if (!opts.force && epoch.output_save) {
      const savePath = resolve(config.rootDir, epoch.output_save);
      if (await exists(savePath)) {
        console.log(`[run-dag] skipping ${node.id}: output_save exists (use --force to re-run)`);
        results.push({ id: node.id, status: "skipped" });
        continue;
      }
    }

    console.log(`\n[run-dag] ── running epoch: ${node.id} ──`);
    const t0 = Date.now();
    try {
      const result = await runEpoch({ config, factorio, epoch });
      const wall = ((Date.now() - t0) / 1000).toFixed(1);
      const status = result.ok ? "pass" : "fail";
      console.log(`[run-dag] ${node.id}: ${status} in ${wall}s`);
      results.push({ id: node.id, status, wall_s: +wall, result });
      if (!result.ok) {
        console.error(`[run-dag] epoch ${node.id} did not pass — stopping DAG run`);
        exitCode = 1;
        break;
      }
    } catch (err) {
      const wall = ((Date.now() - t0) / 1000).toFixed(1);
      console.error(`[run-dag] epoch ${node.id} threw after ${wall}s: ${err.message}`);
      results.push({ id: node.id, status: "error", wall_s: +wall, error: err.message });
      exitCode = 1;
      break;
    }
  }
} finally {
  await shutdown();
}

console.log("\n[run-dag] ── summary ──");
for (const r of results) {
  const icon = r.status === "pass" ? "✓" : r.status === "skipped" ? "–" : "✗";
  const wall = r.wall_s != null ? ` (${r.wall_s}s)` : "";
  console.log(`  ${icon} ${r.id}${wall}`);
}

process.exit(exitCode);
