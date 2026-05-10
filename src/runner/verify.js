// verify.js — Unified verify phase. Orchestrates static validation, module
// placement, harness placement, meter window with ticker, criteria
// evaluation, harness teardown, and save-on-pass.
//
// NOTE: the "verify replaces execute" framing in this header reflects the
// long-term intent (see verify-plan.md). Today verify still runs alongside a
// separate runExecute call in epoch.js — verify dirties a fork with harness,
// then epoch.js reloads input save and re-runs runExecute on the clean save.
// See docs/drifting-tinkering-crayon.md for the planned snapshot/rollback
// migration that will make the header literally true.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  placeOne,
  runPreparation,
  routeConnections,
} from "./execute.js";
import { runDryValidate } from "./dry-validate.js";
import { resolveAudit } from "./audit-resolver.js";
import {
  evaluateCriteria, validateCriteria, coerceLegacyCriteria, headlineThreshold,
} from "./success-criteria.js";

const TICKS_PER_SECOND = 60;

function readMeasured(snapshot) {
  if (typeof snapshot.measured === "number") return snapshot.measured;
  if (typeof snapshot.cumulative_produced === "number") return snapshot.cumulative_produced;
  throw new Error(`meter script must return numeric measured (or legacy cumulative_produced)`);
}

// Same `ok === false` semantics as audit.js: tolerate scripts that conflate
// ok with "passes threshold" so long as they still return a usable measured.
function assertSnapshotUsable(snap) {
  if (snap && snap.ok === false
      && typeof snap.measured !== "number"
      && typeof snap.cumulative_produced !== "number") {
    throw new Error(`meter script failed: ${snap.error || "unknown"}`);
  }
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
 * @param {object} args.controller     — FactorioController
 * @param {object} args.epoch          — epoch metadata
 * @param {object} args.plan           — plan.yaml object
 * @param {Map<string, object>} args.modules — module map (lib + staged)
 * @param {string} args.outDir         — plans/<run>/candidates/cN/ directory
 * @param {string} [args.stateYamlPath] — path to state.yaml
 * @returns {Promise<{verdict: object, perPlacement?: object[]}>}
 */
export async function runVerify({
  controller, epoch, plan, modules, outDir, stateYamlPath,
}) {
  await mkdir(outDir, { recursive: true });

  // Step 1: static validation
  const dryResult = await runDryValidate({ plan, modules, outDir });
  if (!dryResult.ok) {
    throw new Error(`dry-validate: ${dryResult.errors.join("; ")}`);
  }

  // Step 2: place modules (reuse execute.js helpers)
  await runPreparation({ controller, plan, log: () => {} });
  const perPlacement = [];
  for (const placement of plan.placements) {
    try {
      const result = await placeOne({ controller, placement, modules, log: () => {} });
      perPlacement.push({ placement, ok: true, dry: result.dry, live: result.live });
    } catch (err) {
      perPlacement.push({ placement, ok: false, error: err.message });
      throw err;
    }
  }

  // Step 3: route connections
  await routeConnections({ controller, plan, modules, log: () => {} });

  // Step 4: place item harness
  const harnessManifest = deriveHarnessManifest(plan, modules);
  let placedHarnessManifest = [];
  if (harnessManifest.length > 0) {
    console.log(`[verify] harness input: ${JSON.stringify(harnessManifest)}`);
    const placeResult = await controller.action("place_harness", { placements: harnessManifest });
    console.log(`[verify] place_harness result: placed=${placeResult?.placed} manifest=${JSON.stringify(placeResult?.manifest)}`);
    placedHarnessManifest = Array.isArray(placeResult?.manifest) ? placeResult.manifest : [];
  }

  // Step 4b: place power harness (accumulator + pole at power ports)
  const powerHarnessManifest = derivePowerHarnessManifest(plan, modules);
  if (powerHarnessManifest.length > 0) {
    await controller.action("power_harness_setup", { placements: powerHarnessManifest });
  }

  // Step 5: resolve audit/meter configuration
  const resolved = resolveAudit({
    targetMetric: epoch.target_metric,
    modules,
    plan,
    stagedDir: outDir.replace(/\/execute$/, "") + "/staged-modules",
    rootDir: controller.config.rootDir,
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

  // Step 6: run meter window with harness ticker. advanceTicks drives the
  // simulation forward sim-tick by sim-tick (matches audit.js semantics);
  // chunking lets the harness ticker fire every 600 ticks (10s game-time).
  const verifyStart = Date.now();
  let ticksElapsed = 0;
  let before = null, after;

  if (aggregate === "snapshot_post") {
    while (ticksElapsed < windowTicks) {
      const chunk = Math.min(windowTicks - ticksElapsed, 600);
      await controller.advanceTicks(chunk);
      ticksElapsed += chunk;

      if (placedHarnessManifest.length > 0) {
        await controller.action("harness_tick", { manifest: placedHarnessManifest });
      }
    }
    after = await controller.runLuaScript(scriptPath, params);
    assertSnapshotUsable(after);
  } else {
    before = await controller.runLuaScript(scriptPath, params);
    assertSnapshotUsable(before);

    while (ticksElapsed < windowTicks) {
      const chunk = Math.min(windowTicks - ticksElapsed, 600);
      await controller.advanceTicks(chunk);
      ticksElapsed += chunk;

      if (placedHarnessManifest.length > 0) {
        await controller.action("harness_tick", { manifest: placedHarnessManifest });
      }
    }

    after = await controller.runLuaScript(scriptPath, params);
    assertSnapshotUsable(after);
  }

  const wall_clock_ms = Date.now() - verifyStart;
  const entity_count = await controller.countEntities().catch(() => null);

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
    countEntities: (name) => controller.countEntitiesByName({ name }),
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
    await controller.action("harness_teardown");
  }

  // Write verify.json (was audit.json — observe writes its own observe.json
  // alongside, so split names avoid the same-filename collision in the
  // candidate dir).
  await mkdir(dirname(resolve(outDir, "verify.json")), { recursive: true });
  await writeFile(resolve(outDir, "verify.json"), JSON.stringify(verdict, null, 2), "utf8");

  return { verdict, perPlacement };
}
