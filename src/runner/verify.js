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
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  buildPowerProposal,
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
      if (port.kind === "belt") {
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

const POLE_ITEMS = new Set([
  "small-electric-pole", "medium-electric-pole", "big-electric-pole", "substation",
]);

// Post-placement diagnostic: for every placement with a kind=power input, verify
// (1) the port_pole at the actual placed world position is on an energized network
// and (2) every blueprint entity that has an electric_network_id shares that
// network. Failures write proposal.json with a structured root_cause + the
// raw diagnostic so the next design attempt sees concrete distances.
//
// Position source: perPlacement[i].live.placed[] is the array of entities the
// Lua executor actually created, with their post-snap world positions. We use
// those directly to avoid having to replicate Factorio's tile-alignment rules
// (1x1 snaps to half-integer, 3x3 to integer, etc).
async function checkPowerCoverage({ controller, plan, modules, perPlacement, outDir }) {
  const probePath = resolve(controller.config.rootDir, "lib/probes/port-power-check.lua");
  for (let i = 0; i < (plan.placements || []).length; i++) {
    const placement = plan.placements[i];
    const module = modules.get(placement.module);
    if (!module) continue;
    const powerInputs = (module.inputs || []).filter((p) => p.kind === "power");
    if (powerInputs.length === 0) continue;

    const placed = perPlacement[i]?.live?.placed;
    if (!Array.isArray(placed) || placed.length === 0) {
      throw new Error(`power-check ${placement.id}: missing live.placed result from executor`);
    }

    // Read the blueprint just to look up which entity key maps to the port.
    const bpPath = module._staged && module._stagedBlueprintPath
      ? module._stagedBlueprintPath
      : resolve(controller.config.rootDir, module.realization.blueprint);
    let blueprint;
    try {
      blueprint = JSON.parse(await readFile(bpPath, "utf8"));
    } catch (err) {
      throw new Error(`power-check ${placement.id}: cannot read blueprint ${bpPath}: ${err.message}`);
    }
    const portEntityKey = blueprint.ports?.[powerInputs[0].name]?.entity;

    const placedByKey = new Map(placed.map((p) => [p.key, p]));
    const portPlaced = portEntityKey ? placedByKey.get(portEntityKey) : null;
    if (!portPlaced) {
      throw new Error(`power-check ${placement.id}.${powerInputs[0].name}: port entity '${portEntityKey}' not found in live.placed (keys=${[...placedByKey.keys()].join(",")})`);
    }

    const entitiesAbs = placed
      .filter((e) => e.key !== portEntityKey && !POLE_ITEMS.has(e.item))
      .map((e) => ({
        id: `${placement.id}:${e.key || e.item}`,
        position: { x: e.position.x, y: e.position.y },
      }));

    for (const port of powerInputs) {
      let diagnostic;
      try {
        diagnostic = await controller.runLuaScript(probePath, {
          port_pole_position: { x: portPlaced.position.x, y: portPlaced.position.y },
          entities: entitiesAbs,
          scan_radius: 12,
        });
      } catch (err) {
        throw new Error(`power-check ${placement.id}.${port.name}: lua call failed: ${err.message}`);
      }

      if (!diagnostic.ok) {
        await writeProposal(outDir, buildPowerProposal({
          placement,
          portName: port.name,
          diagnostic: {
            ...diagnostic,
            summary: { port_has_upstream_power: false, all_on_port_network: false, uncovered_count: 0 },
          },
        }));
        throw new Error(`power-check ${placement.id}.${port.name}: ${diagnostic.error || "no port_pole at expected position"}`);
      }

      const s = diagnostic.summary || {};
      if (!s.port_has_upstream_power || !s.all_on_port_network) {
        await writeProposal(outDir, buildPowerProposal({ placement, portName: port.name, diagnostic }));
        const reason = !s.port_has_upstream_power
          ? `port_pole's electric network has no generator (max_kw=${diagnostic.port_pole?.max_kw ?? 0})`
          : `${s.uncovered_count} powered entit${s.uncovered_count === 1 ? "y" : "ies"} not on port_pole's network`;
        throw new Error(`power-check ${placement.id}.${port.name}: ${reason}`);
      }
    }
  }
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
  controller, plan, modules, outDir, dryValidate = true, worldPlacements,
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
    const connections = await routeConnections({ controller, plan, modules, log: () => {}, worldPlacements });
    await writeFile(join(outDir, "connections.json"), JSON.stringify(connections, null, 2), "utf8");
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

  // Step 3.5: post-placement power-coverage diagnostic. Confirms each
  // module's power_in port is on an energized network and every electric
  // entity in its blueprint shares that network. Throws with proposal.json
  // if not — recovery loop sees concrete "add a pole at X" guidance.
  await checkPowerCoverage({ controller, plan, modules, perPlacement, outDir });

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
    phase: "verify",
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
