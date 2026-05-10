// meter.js — shared meter-window orchestration for verify and observe.
//
// Both phases run the same Lua meter script before/after a tick window;
// the only differences are (1) verify drives a harness ticker mid-window,
// (2) the output JSON filename. Everything else (meter resolution, criteria
// evaluation, verdict assembly, JSON write) is identical, so we collapse
// it here and let the caller plug in the chunk-callback if needed.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolveMeter } from "./meter-resolver.js";
import {
  evaluateCriteria, validateCriteria, coerceLegacyCriteria, headlineThreshold,
} from "./success-criteria.js";

const TICKS_PER_SECOND = 60;

function readMeasured(snapshot) {
  if (typeof snapshot.measured === "number") return snapshot.measured;
  if (typeof snapshot.cumulative_produced === "number") return snapshot.cumulative_produced;
  throw new Error("meter script must return numeric `measured` (or legacy `cumulative_produced`)");
}

// Tolerate scripts that conflate ok with "passes threshold" so long as
// they still return a usable measured. Only throw when the read truly
// produced nothing usable.
function assertSnapshotUsable(snap) {
  if (snap && snap.ok === false
      && typeof snap.measured !== "number"
      && typeof snap.cumulative_produced !== "number") {
    throw new Error(`meter script failed: ${snap.error || "unknown"}`);
  }
}

// Walk the window in chunks so onAdvance can fire after each chunk
// (verify uses this to trigger harness_tick every 600 ticks). When
// chunkTicks is unset, the whole window advances in a single call —
// that's the observe path.
async function advanceWindow(controller, totalTicks, chunkTicks, onAdvance) {
  if (!chunkTicks || chunkTicks >= totalTicks) {
    await controller.advanceTicks(totalTicks);
    if (onAdvance) await onAdvance(totalTicks, totalTicks, totalTicks);
    return;
  }
  let elapsed = 0;
  while (elapsed < totalTicks) {
    const chunk = Math.min(totalTicks - elapsed, chunkTicks);
    await controller.advanceTicks(chunk);
    elapsed += chunk;
    if (onAdvance) await onAdvance(chunk, elapsed, totalTicks);
  }
}

/**
 * Run a meter window: snapshot meter (if needed) → advance ticks → snapshot
 * meter → derive measured → evaluate criteria → write verdict JSON.
 *
 * @param {object} args
 * @param {object} args.controller     — FactorioController
 * @param {object} args.targetMetric   — see meter-resolver.js for shapes
 * @param {Map<string, object>} [args.modules]  — module map (lib + staged)
 * @param {object} [args.plan]         — plan.yaml object
 * @param {string} [args.stagedDir]    — candidate's staged-modules dir
 * @param {string} args.rootDir        — repo root (controller.config.rootDir)
 * @param {Array<object>} [args.successCriteria] — epoch.success_criteria
 * @param {string} args.outDir         — directory to write the JSON into
 * @param {string} args.outName        — JSON filename ("verify.json" / "observe.json")
 * @param {Function} [args.onAdvance]  — async (chunkTicks, elapsed, total) => void
 *                                       fires after each chunk. Verify uses
 *                                       it to drive the harness ticker.
 * @param {number} [args.chunkTicks]   — chunk size; omit for single-shot advance
 * @returns {Promise<object>} verdict
 */
export async function runMeterWindow({
  controller, targetMetric, modules, plan, stagedDir, rootDir,
  successCriteria, outDir, outName,
  onAdvance, chunkTicks,
}) {
  const resolved = resolveMeter({
    targetMetric, modules, plan, stagedDir, rootDir,
  });
  const { scriptPath, params, aggregate, metric, item, moduleId, meterId } = resolved;
  const windowTicks = params.window_ticks ?? 3600;

  const criteria = (successCriteria && successCriteria.length > 0)
    ? successCriteria
    : (coerceLegacyCriteria({ targetMetric, defaultMetric: metric }).length > 0
        ? coerceLegacyCriteria({ targetMetric, defaultMetric: metric })
        : [{ kind: "nonzero", metric }]);
  validateCriteria(criteria);

  const meterStart = Date.now();
  let before = null, after;
  if (aggregate === "snapshot_post") {
    await advanceWindow(controller, windowTicks, chunkTicks, onAdvance);
    after = await controller.runLuaScript(scriptPath, params);
    assertSnapshotUsable(after);
  } else {
    before = await controller.runLuaScript(scriptPath, params);
    assertSnapshotUsable(before);
    await advanceWindow(controller, windowTicks, chunkTicks, onAdvance);
    after = await controller.runLuaScript(scriptPath, params);
    assertSnapshotUsable(after);
  }
  const wall_clock_ms = Date.now() - meterStart;
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
    executeOk: true,
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
    meter_script: resolved.scriptRel,
    module_id: moduleId,
    meter_id: meterId,
    timestamp: new Date().toISOString(),
  };
  const outPath = resolve(outDir, outName);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(verdict, null, 2), "utf8");
  return verdict;
}
