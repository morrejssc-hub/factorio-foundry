// verify.js — candidate placement plus harness-gated verification.
//
//   1. dry-validate
//   2. place modules (with auto-clear retry; proposal.json on failure)
//   3. routeConnections                       (proposal.json on failure)
//   4. place item harness + power harness
//   5. meter window via runMeterWindow (drives harness_tick every 600 ticks)
//
// runVerifyGate is the current hot path: it runs on disposable verifier
// instances, so harness pollution is discarded with the clone. runVerify is
// kept as a compatibility wrapper for older callers that still expect
// snapshot -> rollback -> export behavior.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  placeOne,
  runPreparation,
  routeConnections,
} from "./execute.js";
import { runDryValidate } from "./dry-validate.js";
import { runMeterWindow } from "./meter.js";
import {
  buildPlacementProposal,
  buildConnectionProposal,
} from "./executor-proposal.js";

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

async function writeProposal(outDir, proposal) {
  await writeFile(join(outDir, "proposal.json"), JSON.stringify(proposal, null, 2), "utf8");
}

/**
 * @param {object} args
 * @param {object} args.controller     — FactorioController
 * @param {object} args.epoch          — epoch metadata
 * @param {object} args.plan           — plan.yaml object
 * @param {Map<string, object>} args.modules — module map (lib + staged)
 * @param {string} args.outDir         — plans/<run>/candidates/cN/execute/ directory
 * @param {string} [args.savePathOut]  — destination zip for the winner save (pass-only)
 * @returns {Promise<{verdict: object, perPlacement: object[], savePath: ?string}>}
 */
export async function applyCandidate({
  controller, plan, modules, outDir, dryValidate = true,
}) {
  await mkdir(outDir, { recursive: true });

  let dryResult = null;
  if (dryValidate) {
    dryResult = await runDryValidate({ plan, modules, outDir });
    if (!dryResult.ok) {
      throw new Error(`dry-validate: ${dryResult.errors.join("; ")}`);
    }
  }

  // Place modules (reuse execute.js helpers). On failure we write
  // proposal.json so the recovery loop's next design call sees a focused
  // root_cause + suggested_changes record (designer-history.md plumbing).
  await runPreparation({ controller, plan, log: () => {} });
  const perPlacement = [];
  for (const placement of plan.placements) {
    try {
      const result = await placeOne({ controller, placement, modules, log: () => {} });
      perPlacement.push({ placement, ok: true, dry: result.dry, live: result.live });
    } catch (err) {
      perPlacement.push({ placement, ok: false, error: err.message });
      const failedStep = plan.placements.findIndex((p) => p.id === placement.id);
      await writeProposal(outDir, buildPlacementProposal(failedStep, placement, err));
      throw err;
    }
  }

  // Step 3: route connections — same proposal.json shape as placement.
  try {
    await routeConnections({ controller, plan, modules, log: () => {} });
  } catch (connError) {
    // routeConnections throws "connection <from>→<to> failed: <reason>".
    // Parse the from/to back so the proposal can name the offending pair.
    const match = (connError.message || "").match(/^connection (\S+)→(\S+) failed: /);
    const conn = match
      ? (plan.connections || []).find((c) => c.from === match[1] && c.to === match[2])
      : null;
    await writeProposal(outDir, buildConnectionProposal(
      conn ?? (match ? { from: match[1], to: match[2] } : null),
      connError,
    ));
    throw connError;
  }

  return { dryResult, perPlacement };
}

export async function runHarnessGate({
  controller, epoch, plan, modules, outDir, stagedDir,
}) {
  const harnessManifest = deriveHarnessManifest(plan, modules);
  let placedHarnessManifest = [];
  if (harnessManifest.length > 0) {
    console.log(`[verify] harness input: ${JSON.stringify(harnessManifest)}`);
    const placeResult = await controller.action("place_harness", { placements: harnessManifest });
    console.log(`[verify] place_harness result: placed=${placeResult?.placed} manifest=${JSON.stringify(placeResult?.manifest)}`);
    placedHarnessManifest = Array.isArray(placeResult?.manifest) ? placeResult.manifest : [];
  }

  // Step 5b: place power harness (accumulator + pole at power ports).
  const powerHarnessManifest = derivePowerHarnessManifest(plan, modules);
  if (powerHarnessManifest.length > 0) {
    await controller.action("power_harness_setup", { placements: powerHarnessManifest });
  }

  // Step 6: meter window with harness ticker. Chunked at 600 ticks (10s
  // game-time) so the harness can fire mid-window. observe.js calls the
  // same helper without onAdvance/chunkTicks for a single-shot advance.
  const verdict = await runMeterWindow({
    controller,
    targetMetric: epoch.target_metric,
    modules,
    plan,
    stagedDir: stagedDir ?? outDir.replace(/\/execute$/, "") + "/staged-modules",
    rootDir: controller.config.rootDir,
    successCriteria: epoch.success_criteria,
    outDir,
    outName: "verify.json",
    chunkTicks: 600,
    onAdvance: placedHarnessManifest.length > 0
      ? async () => { await controller.action("harness_tick", { manifest: placedHarnessManifest }); }
      : undefined,
  });
  return verdict;
}

export async function runVerifyGate({
  controller, epoch, plan, modules, outDir, stagedDir,
}) {
  const { dryResult, perPlacement } = await applyCandidate({
    controller,
    plan,
    modules,
    outDir,
    dryValidate: true,
  });
  const verdict = await runHarnessGate({
    controller,
    epoch,
    plan,
    modules,
    outDir,
    stagedDir,
  });
  return { dryResult, perPlacement, verdict };
}

export async function runVerify({
  controller, epoch, plan, modules, outDir, savePathOut, stagedDir,
}) {
  const { dryResult, perPlacement } = await applyCandidate({
    controller,
    plan,
    modules,
    outDir,
    dryValidate: true,
  });

  // Snapshot the clean post-placement world. This IS the winner save; if
  // the meter window passes this compatibility path rolls back to it and
  // dumps it to disk at savePathOut.
  await controller.snapshot("pre-harness");

  const verdict = await runHarnessGate({
    controller,
    epoch,
    plan,
    modules,
    outDir,
    stagedDir,
  });

  // Step 7: on pass, rewind to the clean snapshot and export the winner zip.
  // No teardown needed — rollback discards the harness; on fail, the next
  // recovery attempt's loadSave(inputSave) at the top of the loop wipes the
  // dirty world.
  let savePath = null;
  if (verdict.pass && savePathOut) {
    await controller.rollback("pre-harness");
    savePath = await controller.exportZip(savePathOut);
    // Re-emit verify.json with savePath so run-summary's no-meta fallback
    // and any debug tooling can find the winner zip from the verdict alone.
    verdict.savePath = savePath;
    await writeFile(resolve(outDir, "verify.json"), JSON.stringify(verdict, null, 2), "utf8");
  }

  return { dryResult, verdict, perPlacement, savePath };
}
