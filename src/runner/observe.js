// observe.js — deterministic verdict generator (the observe phase). Runs
// the meter window on the clean post-execute world, with no harness, and
// derives a verdict via the shared `runMeterWindow` helper.
//
// Critical invariant: this module never invokes `pi`. Observe must be
// deterministic so the multi-branch and multi-run comparisons are valid.
import { runMeterWindow } from "./meter.js";

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
  return runMeterWindow({
    controller,
    targetMetric,
    modules,
    plan,
    stagedDir,
    rootDir: controller.config.rootDir,
    successCriteria,
    outDir,
    outName: "observe.json",
    // No onAdvance / chunkTicks — observe runs the window in a single
    // advanceTicks call; nothing to drive mid-window.
  });
}
