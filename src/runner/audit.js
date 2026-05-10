// audit.js — deterministic verdict generator. Reads the audit script
// referenced by the epoch's target_metric, runs it via RCON before and
// after a tick window, derives `measured` per the module's aggregate
// strategy, then evaluates each `epoch.success_criteria` entry against
// the world.
//
// Critical invariant: this module never invokes `pi`. Auditor must be
// deterministic so the multi-branch and multi-run comparisons are valid.
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolveAudit } from "./audit-resolver.js";
import {
  evaluateCriteria, validateCriteria, coerceLegacyCriteria, headlineThreshold,
} from "./success-criteria.js";

const TICKS_PER_SECOND = 60;

function readMeasured(snapshot) {
  if (typeof snapshot.measured === "number") return snapshot.measured;
  if (typeof snapshot.cumulative_produced === "number") return snapshot.cumulative_produced;
  throw new Error("audit script must return numeric `measured` (or legacy `cumulative_produced`)");
}

// Same `ok === false` semantics that the old in-file rconRunScript enforced:
// the script may return `ok=false` while still returning a usable measured
// value (some authored scripts conflate ok with "passes threshold"). Only
// throw when the read truly produced nothing usable.
function assertSnapshotUsable(snap) {
  if (snap && snap.ok === false
      && typeof snap.measured !== "number"
      && typeof snap.cumulative_produced !== "number") {
    throw new Error(`audit script failed: ${snap.error || "unknown"}`);
  }
}

/**
 * @param {object} args
 * @param {object} args.controller     — FactorioController (rcon + advanceTicks + runLuaScript + countEntities)
 * @param {object} args.targetMetric   — see audit-resolver.js for the 3 supported shapes
 * @param {Array<object>} [args.successCriteria] — epoch.success_criteria; if absent,
 *        a legacy `target_metric.threshold` is auto-converted to a single
 *        threshold criterion. If neither is present we fall back to a
 *        `nonzero` criterion so the verdict shape stays uniform.
 * @param {string} args.outDir         — plans/<run>/ directory; audit.json is written here
 * @param {Map<string, object>} [args.modules]  — module map (lib + staged); required for module-driven shapes
 * @param {object} [args.plan]         — plan.yaml object; required for goal-only metric shape
 * @param {string} [args.stagedDir]    — candidate's staged-modules/ for resolving in-flight audit lua
 * @returns {Promise<object>}
 */
export async function runAudit({
  controller, targetMetric, outDir, modules, plan, stagedDir, successCriteria,
}) {
  const resolved = resolveAudit({
    targetMetric, modules, plan, stagedDir,
    rootDir: controller.config.rootDir,
  });
  const { scriptPath, params, aggregate, metric, item, moduleId, auditId } = resolved;
  const windowTicks = params.window_ticks ?? 3600;

  const criteria = (successCriteria && successCriteria.length > 0)
    ? successCriteria
    : (coerceLegacyCriteria({ targetMetric, defaultMetric: metric }).length > 0
        ? coerceLegacyCriteria({ targetMetric, defaultMetric: metric })
        : [{ kind: "nonzero", metric }]);
  validateCriteria(criteria);

  const auditStart = Date.now();
  let before = null, after;
  if (aggregate === "snapshot_post") {
    await controller.advanceTicks(windowTicks);
    after = await controller.runLuaScript(scriptPath, params);
    assertSnapshotUsable(after);
  } else {
    before = await controller.runLuaScript(scriptPath, params);
    assertSnapshotUsable(before);
    await controller.advanceTicks(windowTicks);
    after = await controller.runLuaScript(scriptPath, params);
    assertSnapshotUsable(after);
  }
  const wall_clock_ms = Date.now() - auditStart;
  const entity_count = await controller.countEntities().catch(() => null);

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

  const ctx = {
    measured,
    metric,
    snapshot: after || null,
    executeOk: true, // we only reach audit if execute didn't throw
    countEntities: (name) => controller.countEntitiesByName({ name }),
  };
  const { pass, results: criteriaResults } = await evaluateCriteria(criteria, ctx);

  // Headline threshold (legacy field) — pulled from the first
  // threshold-kind criterion if any, so summary tooling that reads
  // verdict.threshold keeps working.
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
  await mkdir(dirname(resolve(outDir, "audit.json")), { recursive: true });
  await writeFile(resolve(outDir, "audit.json"), JSON.stringify(verdict, null, 2), "utf8");
  return verdict;
}
