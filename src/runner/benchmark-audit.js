// benchmark-audit.js — fast audit using Factorio's --benchmark CLI flag.
// Replaces the 60-second live waitTicks window with an offline benchmark
// process that completes 3600 ticks in ~1-2s. A tiny Lua mod writes
// cumulative production stats to script-output at the end of the window;
// we bracket that with a live RCON "before" snapshot taken while the
// Factorio server is still running post-execute.
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { rconExec, buildLuaCommand } from "../rcon.js";
import { resolveAudit } from "./audit-resolver.js";
import {
  evaluateCriteria, validateCriteria, coerceLegacyCriteria, headlineThreshold,
} from "./success-criteria.js";

const TICKS_PER_SECOND = 60;

async function rconRunScript({ config, scriptPath, params }) {
  const lua = await readFile(scriptPath, "utf8");
  const command = buildLuaCommand(scriptPath.split("/").pop(), lua, params);
  const body = await rconExec({
    host: config.rconHost,
    port: config.rconPort,
    password: config.rconPassword,
    command,
    timeoutMs: 15000,
  });
  let parsed;
  try {
    parsed = JSON.parse(body.trim());
  } catch {
    throw new Error(`audit script returned non-JSON: ${body.slice(0, 200)}`);
  }
  if (parsed.ok === false) throw new Error(`audit script failed: ${parsed.error || "unknown"}`);
  return parsed;
}

async function rconCountEntities(config) {
  const command = `/silent-command rcon.print(#game.surfaces[1].find_entities())`;
  const body = await rconExec({
    host: config.rconHost, port: config.rconPort,
    password: config.rconPassword, command, timeoutMs: 10000,
  });
  return parseInt(body.trim(), 10) || 0;
}

function makeControlLua(item, windowTicks) {
  // Use Factorio 2.0 API: force.get_item_production_statistics(surface).get_input_count(item)
  // Build JSON manually to avoid game.table_to_json / helpers.table_to_json version issues.
  return [
    `local item = ${JSON.stringify(item)}`,
    `local window = ${windowTicks}`,
    `local start_tick = nil`,
    `script.on_event(defines.events.on_tick, function(e)`,
    `  if start_tick == nil then start_tick = e.tick end`,
    `  if e.tick == start_tick + window then`,
    `    local force = game.forces["player"]`,
    `    local surface = game.surfaces["nauvis"]`,
    `    local count = 0`,
    `    if force and surface then`,
    `      local stats = force.get_item_production_statistics(surface)`,
    `      count = stats.get_input_count(item)`,
    `    end`,
    `    helpers.write_file("benchmark-stats.json",`,
    `      '{"tick":' .. e.tick .. ',"cumulative_produced":' .. count .. '}',`,
    `      false)`,
    `  end`,
    `end)`,
  ].join("\n");
}

function makeConfigIni(writeDataPath) {
  return [
    "; version=13",
    "[path]",
    "read-data=__PATH__executable__/../../data",
    `write-data=${writeDataPath}`,
  ].join("\n") + "\n";
}

async function spawnBenchmark({ binaryPath, configIniPath, savePath, modsDir, windowTicks }) {
  // Give 10× the expected wall time plus 30s overhead for startup.
  const timeoutMs = Math.ceil((windowTicks / TICKS_PER_SECOND) * 1000 * 10) + 30_000;
  return new Promise((resolve, reject) => {
    // Run one extra tick so the mod fires at start_tick + windowTicks (which
    // would otherwise be 1 past the last tick of an exact-window benchmark).
    const proc = spawn(binaryPath, [
      "-c", configIniPath,
      "--benchmark", savePath,
      "--benchmark-ticks", String(windowTicks + 1),
      "--benchmark-sanitize",
      "--mod-directory", modsDir,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`factorio --benchmark timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(
          `factorio --benchmark exited ${code}\nstdout: ${stdout.slice(0, 500)}\nstderr: ${stderr.slice(0, 500)}`,
        ));
      } else {
        resolve({ stdout, stderr });
      }
    });

    proc.once("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn factorio --benchmark: ${err.message}`));
    });
  });
}

/**
 * Fast benchmark-mode audit. Measures production throughput using Factorio's
 * --benchmark flag instead of a live 60-second waitTicks window.
 *
 * @param {object} args
 * @param {object} args.config            — loaded foundry config (per-slot for pool mode)
 * @param {object} args.factorio          — live FactorioServer (still running post-execute)
 * @param {object} args.targetMetric      — { audit: <relpath>, params: {...} }
 * @param {string} args.outDir            — candidate dir; audit.json written here
 * @param {string} args.candidateSavePath — the .zip produced by execute phase
 */
export async function runBenchmarkAudit({ config, factorio, targetMetric, outDir, candidateSavePath, modules, plan, stagedDir, successCriteria }) {
  const resolved = resolveAudit({
    targetMetric, modules, plan, stagedDir,
    rootDir: config.rootDir,
  });
  if (resolved.aggregate !== "rate_from_cumulative") {
    throw new Error(
      `benchmark-audit only supports aggregate=rate_from_cumulative; ` +
      `audit '${resolved.auditId ?? "(legacy)"}' uses '${resolved.aggregate}'. ` +
      `Disable benchmark mode (unset FOUNDRY_BENCHMARK_AUDIT and parallel) for this epoch.`,
    );
  }
  const { scriptPath, params, item: resolvedItem } = resolved;
  const item = resolvedItem || params.item || "coal";
  const windowTicks = params.window_ticks ?? 3600;

  // Resolve criteria. Benchmark mode runs offline so entity_exists can't
  // hit a live world — reject criteria that need RCON introspection.
  const criteria = (successCriteria && successCriteria.length > 0)
    ? successCriteria
    : (coerceLegacyCriteria({ targetMetric, defaultMetric: resolved.metric }).length > 0
        ? coerceLegacyCriteria({ targetMetric, defaultMetric: resolved.metric })
        : [{ kind: "nonzero", metric: resolved.metric }]);
  validateCriteria(criteria);
  const livenessCriterion = criteria.find((c) => c.kind === "entity_exists" || c.kind === "build_only");
  if (livenessCriterion) {
    throw new Error(
      `benchmark-audit cannot evaluate criterion kind '${livenessCriterion.kind}' (no live world). ` +
      `Disable benchmark mode for epochs that need entity introspection.`,
    );
  }

  const auditStart = Date.now();

  // 1. Snapshot "before" stats via live RCON (Factorio still running post-execute).
  const before = await rconRunScript({ config, scriptPath, params });
  const entity_count = await rconCountEntities(config).catch(() => null);

  // 2. Stop the live Factorio server — benchmark runs offline.
  await factorio.stop();

  // 3. Isolated temp dir: mod + config.ini → script-output isolation per invocation.
  const tmpDir = await mkdtemp(join(tmpdir(), "ff-bench-"));
  let after;
  try {
    const modsDir = join(tmpDir, "mods");
    const modDir = join(modsDir, "benchmark-audit");
    await mkdir(modDir, { recursive: true });
    await writeFile(join(tmpDir, "config.ini"), makeConfigIni(tmpDir));
    await writeFile(join(modDir, "info.json"), JSON.stringify({
      name: "benchmark-audit",
      version: "1.0.0",
      title: "Factorio Foundry Benchmark Audit",
      author: "factorio-foundry",
      factorio_version: "2.0",
      dependencies: [],
    }, null, 2));
    await writeFile(join(modDir, "control.lua"), makeControlLua(item, windowTicks));

    // 4. Run benchmark — completes in ~1-2s for 3600 ticks.
    const binaryPath = resolve(config.factorioDir, "bin/x64/factorio");
    await spawnBenchmark({ binaryPath, configIniPath: join(tmpDir, "config.ini"), savePath: candidateSavePath, modsDir, windowTicks });

    // 5. Read stats written by the mod.
    const statsPath = join(tmpDir, "script-output", "benchmark-stats.json");
    try {
      after = JSON.parse(await readFile(statsPath, "utf8"));
    } catch (err) {
      throw new Error(
        `benchmark-audit: script-output missing at ${statsPath} — on_tick mod may not have fired (Factorio 2.0 benchmark compatibility issue?). ${err.message}`,
      );
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  const wall_clock_ms = Date.now() - auditStart;
  const tickDelta = after.tick - before.tick;
  const producedDelta = after.cumulative_produced - before.cumulative_produced;
  const seconds = tickDelta / TICKS_PER_SECOND;
  const measured = seconds > 0 ? producedDelta / seconds : 0;

  const ctx = {
    measured,
    metric: resolved.metric,
    snapshot: after || null,
    executeOk: true,
    countEntities: () => { throw new Error("entity introspection unavailable in benchmark mode"); },
  };
  const { pass, results: criteriaResults } = await evaluateCriteria(criteria, ctx);
  const { threshold } = headlineThreshold(criteria);

  const verdict = {
    pass, item, measured,
    threshold,
    criteria: criteriaResults,
    window_ticks_requested: windowTicks,
    window_ticks_actual: tickDelta,
    seconds_actual: seconds,
    produced_delta: producedDelta,
    wall_clock_ms,
    entity_count,
    before, after,
    audit_script: resolved.scriptRel,
    metric: resolved.metric,
    aggregate: resolved.aggregate,
    module_id: resolved.moduleId,
    audit_id: resolved.auditId,
    benchmark_mode: true,
    timestamp: new Date().toISOString(),
  };
  await mkdir(dirname(resolve(outDir, "audit.json")), { recursive: true });
  await writeFile(resolve(outDir, "audit.json"), JSON.stringify(verdict, null, 2), "utf8");
  return verdict;
}
