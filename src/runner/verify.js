// verify.js — Unified verify phase. Orchestrates static validation, module
// placement, harness placement, meter window with ticker, criteria
// evaluation, harness teardown, and save-on-pass.
//
// Replaces the former execute + audit split. The pipeline is:
//   static → place modules → place harness → window+ticker → meter → criteria → teardown → save
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  placeOne,
  runPreparation,
  routeConnections,
  rotateRelPos,
  postAction,
} from "./execute.js";
import { runDryValidate } from "./dry-validate.js";
import { resolveAudit } from "./audit-resolver.js";
import {
  evaluateCriteria, validateCriteria, coerceLegacyCriteria, headlineThreshold,
} from "./success-criteria.js";
import { readFile } from "node:fs/promises";
import { rconExec, buildLuaCommand } from "../rcon.js";

const TICKS_PER_SECOND = 60;
const ENTITY_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const HARNESS_TICK_INTERVAL_MS = 5000;

async function rconCountEntities(config) {
  const command = `/silent-command rcon.print(#game.surfaces[1].find_entities())`;
  const body = await rconExec({
    host: config.rconHost, port: config.rconPort,
    password: config.rconPassword, command, timeoutMs: 10000,
  });
  return parseInt(body.trim(), 10) || 0;
}

async function rconCountEntitiesByName({ config, name, surface = "nauvis" }) {
  if (!ENTITY_NAME_RE.test(name)) {
    throw new Error(`refusing to query entity name with unsafe chars: ${JSON.stringify(name)}`);
  }
  if (!ENTITY_NAME_RE.test(surface)) {
    throw new Error(`refusing to query surface with unsafe chars: ${JSON.stringify(surface)}`);
  }
  const command = `/silent-command rcon.print(#game.surfaces["${surface}"].find_entities_filtered{name="${name}"})`;
  const body = await rconExec({
    host: config.rconHost, port: config.rconPort,
    password: config.rconPassword, command, timeoutMs: 10000,
  });
  const n = parseInt(body.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

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
  } catch (error) {
    throw new Error(`meter script returned non-JSON: ${body.slice(0, 200)}`);
  }
  if (parsed.ok === false && typeof parsed.measured !== "number" && typeof parsed.cumulative_produced !== "number") {
    throw new Error(`meter script failed: ${parsed.error || "unknown"}`);
  }
  return parsed;
}

function readMeasured(snapshot) {
  if (typeof snapshot.measured === "number") return snapshot.measured;
  if (typeof snapshot.cumulative_produced === "number") return snapshot.cumulative_produced;
  throw new Error(`meter script must return numeric measured (or legacy cumulative_produced)`);
}

// Derive harness port_specs from plan placements and their modules.
// Returns { placements: [...], port_specs: [...] } suitable for place_harness action.
function deriveHarnessManifest(plan, modules) {
  const harnessPlacements = [];
  for (const placement of (plan.placements || [])) {
    const mod = modules.get(placement.module);
    if (!mod) continue;
    const ports = [];
    for (const port of [...(mod.inputs || []), ...(mod.outputs || [])]) {
      if (port.kind === "belt" || port.kind === "inventory") {
        ports.push({
          name: port.name,
          kind: port.kind,
          side: port.side,
          rel_pos: port.rel_pos,
          item: port.item,
          role: mod.inputs?.includes(port) || mod.inputs?.some((p) => p.name === port.name) ? "input" : "output",
        });
      }
    }
    if (ports.length > 0) {
      harnessPlacements.push({
        module_id: placement.module,
        anchor: placement.anchor,
        direction: placement.direction || "north",
        ports,
      });
    }
  }
  return harnessPlacements;
}

// Derive power harness placements from plan placements and their modules.
// Returns array suitable for power_harness_setup action.
function derivePowerHarnessManifest(plan, modules) {
  const placements = [];
  for (const placement of (plan.placements || [])) {
    const mod = modules.get(placement.module);
    if (!mod) continue;
    const ports = [];
    for (const port of [...(mod.inputs || []), ...(mod.outputs || [])]) {
      if (port.kind === "power") {
        ports.push({
          name: port.name,
          kind: "power",
          side: port.side,
          rel_pos: port.rel_pos,
        });
      }
    }
    if (ports.length > 0) {
      placements.push({
        module_id: placement.module,
        anchor: placement.anchor,
        direction: placement.direction || "north",
        ports,
      });
    }
  }
  return placements;
}

/**
 * @param {object} args
 * @param {object} args.config         — loaded foundry config
 * @param {object} args.factorio       — FactorioServer instance
 * @param {object} args.epoch          — epoch metadata
 * @param {object} args.plan           — plan.yaml object
 * @param {Map<string, object>} args.modules — module map (lib + staged)
 * @param {string} args.outDir         — plans/<run>/candidates/cN/ directory
 * @param {string} [args.stateYamlPath] — path to state.yaml
 * @returns {Promise<{verdict: object, perPlacement?: object[]}>}
 */
export async function runVerify({
  config, factorio, epoch, plan, modules, outDir, stateYamlPath,
}) {
  await mkdir(outDir, { recursive: true });

  // Step 1: static validation
  const dryResult = await runDryValidate({ plan, modules, outDir });
  if (!dryResult.ok) {
    throw new Error(`dry-validate: ${dryResult.errors.join("; ")}`);
  }

  // Step 2: place modules (reuse execute.js helpers)
  const preparation = await runPreparation({ config, plan, log: () => {} });
  const perPlacement = [];
  for (const placement of plan.placements) {
    try {
      const result = await placeOne({ config, placement, modules, log: () => {} });
      perPlacement.push({ placement, ok: true, dry: result.dry, live: result.live });
    } catch (err) {
      perPlacement.push({ placement, ok: false, error: err.message });
      throw err;
    }
  }

  // Step 3: route connections
  await routeConnections({ config, plan, modules, log: () => {} });

  // Step 4: place item harness
  const harnessManifest = deriveHarnessManifest(plan, modules);
  if (harnessManifest.length > 0) {
    await factorio.handleAction({ action: "place_harness", placements: harnessManifest });
  }

  // Step 4b: place power harness (accumulator + pole at power ports)
  const powerHarnessManifest = derivePowerHarnessManifest(plan, modules);
  if (powerHarnessManifest.length > 0) {
    await factorio.handleAction({ action: "power_harness_setup", placements: powerHarnessManifest });
  }

  // Step 5: resolve audit/meter configuration
  const resolved = resolveAudit({
    targetMetric: epoch.target_metric,
    modules,
    plan,
    stagedDir: outDir.replace(/\/execute$/, "") + "/staged-modules",
    rootDir: config.rootDir,
  });
  const { scriptPath, params, aggregate, metric, item, moduleId, auditId } = resolved;
  const windowTicks = params.window_ticks ?? 3600;

  // Resolve success criteria
  const successCriteria = epoch.success_criteria;
  const criteria = (successCriteria && successCriteria.length > 0)
    ? successCriteria
    : (coerceLegacyCriteria({ targetMetric: epoch.target_metric, defaultMetric: metric }).length > 0
        ? coerceLegacyCriteria({ targetMetric: epoch.target_metric, defaultMetric: metric })
        : [{ kind: "nonzero", metric }]);
  validateCriteria(criteria);

  // Step 6: run meter window with harness ticker (yield-and-poll)
  const verifyStart = Date.now();
  const msPerTick = 1000 / TICKS_PER_SECOND;
  const totalMs = windowTicks * msPerTick;
  let ticksElapsed = 0;
  let before = null, after;

  if (aggregate === "snapshot_post") {
    // Single snapshot: wait the full window, then run meter once
    while (ticksElapsed < windowTicks) {
      const chunk = Math.min(windowTicks - ticksElapsed, 600); // 10s chunks
      await new Promise((r) => setTimeout(r, Math.ceil(chunk * msPerTick)));
      ticksElapsed += chunk;

      // Harness tick every 5s
      if (harnessManifest.length > 0) {
        await factorio.handleAction({ action: "harness_tick", manifest: harnessManifest });
      }
    }
    after = await rconRunScript({ config, scriptPath, params });
  } else {
    // Before snapshot
    before = await rconRunScript({ config, scriptPath, params });

    // Wait window with periodic harness ticks
    while (ticksElapsed < windowTicks) {
      const chunk = Math.min(windowTicks - ticksElapsed, 600);
      await new Promise((r) => setTimeout(r, Math.ceil(chunk * msPerTick)));
      ticksElapsed += chunk;

      if (harnessManifest.length > 0) {
        await factorio.handleAction({ action: "harness_tick", manifest: harnessManifest });
      }
    }

    // After snapshot
    after = await rconRunScript({ config, scriptPath, params });
  }

  const wall_clock_ms = Date.now() - verifyStart;
  const entity_count = await rconCountEntities(config).catch(() => null);

  // Step 7: compute measured value
  const tickDelta = before ? (after.tick - before.tick) : windowTicks;
  const seconds = tickDelta / TICKS_PER_SECOND;

  let measured, producedDelta = null;
  if (aggregate === "rate_from_cumulative") {
    producedDelta = readMeasured(after) - readMeasured(before);
    measured = seconds > 0 ? producedDelta / seconds : 0;
  } else if (aggregate === "snapshot_post") {
    measured = readMeasured(after);
  } else if (aggregate === "snapshot_avg") {
    measured = (readMeasured(before) + readMeasured(after)) / 2;
  } else {
    throw new Error(`unsupported aggregate: ${aggregate}`);
  }

  // Step 8: evaluate criteria
  const ctx = {
    measured,
    metric,
    snapshot: after || null,
    executeOk: true,
    countEntities: (name) => rconCountEntitiesByName({ config, name }),
  };
  const { pass, results: criteriaResults } = await evaluateCriteria(criteria, ctx);

  const { threshold } = headlineThreshold(criteria);

  const verdict = {
    pass,
    item,
    metric,
    measured,
    threshold,
    aggregate,
    criteria: criteriaResults,
    window_ticks_requested: windowTicks,
    window_ticks_actual: tickDelta,
    seconds_actual: seconds,
    produced_delta: producedDelta,
    wall_clock_ms,
    entity_count,
    before,
    after,
    audit_script: resolved.scriptRel,
    module_id: moduleId,
    audit_id: auditId,
    timestamp: new Date().toISOString(),
  };

  // Step 9: teardown harness (always, regardless of verdict)
  // Both item and power harness entities live on audit-harness force, so
  // a single harness_teardown call destroys all of them.
  if (harnessManifest.length > 0 || powerHarnessManifest.length > 0) {
    await factorio.handleAction({ action: "harness_teardown" });
  }

  // Write audit.json for backward compatibility with tooling that reads it
  await mkdir(dirname(resolve(outDir, "audit.json")), { recursive: true });
  await writeFile(resolve(outDir, "audit.json"), JSON.stringify(verdict, null, 2), "utf8");

  return { verdict, perPlacement };
}
