// observe.js — deterministic verdict generator (the observe phase). Runs
// the meter window on the clean post-execute world, with no harness, and
// derives a verdict via the shared `runMeterWindow` helper. After the
// meter window, scans entity status within each placement footprint
// (lib/probes/entity-diagnostic.lua) so the Designer / human reviewer
// can root-cause non-trivial `measured` values ("no_ingredients",
// "no_power", "full_output", ...) without re-running the epoch.
//
// Critical invariant: this module never invokes `pi`. Observe must be
// deterministic so the multi-branch and multi-run comparisons are valid.
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { runMeterWindow } from "./meter.js";

const DIAGNOSTIC_PROBE_REL = "lib/probes/entity-diagnostic.lua";

/**
 * @param {object} args
 * @param {object} args.controller     — FactorioController
 * @param {object} args.targetMetric   — see meter-resolver.js for the 3 supported shapes
 * @param {Array<object>} [args.successCriteria] — epoch.success_criteria
 * @param {string} args.outDir         — plans/<run>/ directory; observe.json is written here
 * @param {Map<string, object>} [args.modules]  — module map (lib + staged)
 * @param {object} [args.plan]         — plan.yaml object
 * @param {string} [args.stagedDir]    — candidate's staged-modules/ for in-flight meter lua
 * @returns {Promise<object>}
 */
export async function runObserve({
  controller, targetMetric, outDir, modules, plan, stagedDir, successCriteria,
}) {
  const verdict = await runMeterWindow({
    controller,
    targetMetric,
    modules,
    plan,
    stagedDir,
    rootDir: controller.config.rootDir,
    successCriteria,
    outDir,
    outName: "observe.json",
    phase: "observe",
    // No onAdvance / chunkTicks — observe runs the window in a single
    // advanceTicks call; nothing to drive mid-window.
  });

  // Entity-status scan is non-fatal — a probe failure surfaces as
  // diagnostic.error but does not flip the meter verdict. The verdict's
  // pass/fail stays governed exclusively by success-criteria evaluation.
  let diagnostic;
  try {
    diagnostic = await scanEntityDiagnostic({ controller, plan, modules });
  } catch (err) {
    diagnostic = { ok: false, error: err.message };
  }

  const enriched = { ...verdict, diagnostic };
  await writeFile(resolve(outDir, "observe.json"), JSON.stringify(enriched, null, 2), "utf8");
  return enriched;
}

async function scanEntityDiagnostic({ controller, plan, modules }) {
  const footprints = computeWorldFootprints(plan, modules);
  if (footprints.length === 0) {
    return {
      ok: true,
      footprints: [],
      summary: { total_entities: 0, issue_count: 0, statuses_seen: [] },
    };
  }
  const probePath = resolve(controller.config.rootDir, DIAGNOSTIC_PROBE_REL);
  return controller.runLuaScript(probePath, { footprints });
}

/**
 * Derive world-space bboxes for the diagnostic probe. Module footprints are
 * `{ min: [x,y], max: [x,y] }` in canonical (north) orientation; placements
 * almost always use direction=north per prompts/design.md guidance. The
 * probe inflates each bbox by 1 tile to absorb rotation slop and half-tile
 * entity centers, so a rotated placement's entities still fall in scope.
 *
 * Exported for unit testing.
 */
export function computeWorldFootprints(plan, modules) {
  const out = [];
  for (const placement of (plan?.placements || [])) {
    const mod = modules?.get?.(placement.module);
    if (!mod?.footprint?.min || !mod.footprint.max) continue;
    const [minX, minY] = mod.footprint.min;
    const [maxX, maxY] = mod.footprint.max;
    out.push({
      id: placement.id,
      module: placement.module,
      bbox: {
        min: { x: placement.anchor.x + minX, y: placement.anchor.y + minY },
        max: { x: placement.anchor.x + maxX, y: placement.anchor.y + maxY },
      },
    });
  }
  return out;
}
