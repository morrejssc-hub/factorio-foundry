// execute.js — Execute phase. Walks plan.placements and POSTs
// execute_blueprint to the Factorio service for each one. After all
// placements, calls save and copies the resulting zip into
// state/saves/<epoch>-v<N>.zip.
//
// pi fallback: if a deterministic placement fails, we spawn a one-shot pi
// with factorio_read + factorio_action tools and a focused repair prompt
// giving it the failed step's context. The fallback is bounded — it gets
// one chance per failed step, then the run is failed.
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { piInvoke } from "../pi-invoke.js";
import { newTrace, addPiCall, writePiTrace } from "./pi-trace.js";
import { DIRECTION_NAMES } from "../geometry/schema.js";
import { buildPlacementProposal, buildConnectionProposal } from "./executor-proposal.js";
import { findPort } from "../lib-loader.js";

async function executeBlueprint({ controller, blueprint, anchor, direction, dryRun }) {
  return controller.action("execute_blueprint", { blueprint, anchor, direction, dryRun });
}

// Pull blocked-tile positions out of an execute_blueprint precondition_failed
// error payload. Returns [] if the error wasn't a placement-collision shape.
function blockedPositionsFromError(error) {
  const blocked = error?.payload?.blockedPlacements;
  if (!Array.isArray(blocked)) return [];
  return blocked
    .map((b) => b?.position)
    .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
}

export async function placeOne({ controller, placement, modules, log }) {
  const module = modules.get(placement.module);
  // Staged modules (newly authored in this run, not yet promoted to lib/)
  // pass the blueprint as an inline JSON object so the factorio service
  // doesn't need a workspace blueprint file. Lib modules continue to use
  // the by-name path so the existing tooling stays untouched.
  let blueprintArg;
  let blueprintLabel;
  if (module._staged && module._stagedBlueprintPath) {
    const json = JSON.parse(await readFile(module._stagedBlueprintPath, "utf8"));
    blueprintArg = json;
    blueprintLabel = `staged:${module.id}`;
  } else {
    const blueprintRel = module.realization.blueprint;
    // Strip the lib/blueprints/ prefix — the factorio service resolves names
    // relative to its workspace's blueprints/ dir, which we symlinked to lib/blueprints.
    const blueprintLabelRaw = blueprintRel.replace(/^lib\/blueprints\//, "").replace(/\.json$/, "");
    blueprintArg = blueprintLabelRaw;
    blueprintLabel = blueprintLabelRaw;
  }
  log(`[execute] placement ${placement.id}: module=${module.id} anchor=(${placement.anchor.x},${placement.anchor.y}) direction=${placement.direction}`);

  const doPlace = async () => {
    log(`[execute]   dryRun ${blueprintLabel}…`);
    const dry = await executeBlueprint({
      controller, blueprint: blueprintArg,
      anchor: placement.anchor, direction: placement.direction, dryRun: true,
    });
    log(`[execute]   dryRun ok=${dry.ok ?? "n/a"} required=${JSON.stringify(dry.requiredItems || dry.required || {})}`);
    log(`[execute]   placing live…`);
    const live = await executeBlueprint({
      controller, blueprint: blueprintArg,
      anchor: placement.anchor, direction: placement.direction, dryRun: false,
    });
    return { dry, live };
  };

  try {
    return await doPlace();
  } catch (error) {
    // Auto-clear: if the failure was canPlace=false at specific tiles, try
    // mining natural debris (trees/rocks/biters/fish) under those tiles
    // and retry once. Avoids burning an LLM-driven repair when the only
    // obstacle is terrain. If clear_obstacles destroys nothing (e.g. tile
    // is water, or a player-placed entity sits there), we let the error
    // propagate to the regular repair path.
    const positions = blockedPositionsFromError(error);
    if (positions.length === 0) throw error;
    log(`[execute]   ${positions.length} tile(s) blocked; trying clear_obstacles before repair`);
    let cleared;
    try {
      cleared = await controller.action("clear_obstacles", { positions, radius: 1.5 });
    } catch (clearError) {
      log(`[execute]   clear_obstacles failed: ${clearError.message}; surfacing original placement error`);
      throw error;
    }
    if (!cleared || !cleared.cleared) {
      log(`[execute]   no natural obstacles at blocked tiles (${JSON.stringify(cleared?.by_type || {})}); not retrying`);
      throw error;
    }
    log(`[execute]   cleared ${cleared.cleared} obstacles ${JSON.stringify(cleared.by_type || {})}; retrying placement`);
    return await doPlace();
  }
}

// plan.preparation runs before placements. Each entry currently supports
// kind=deconstruct {position, entity?}. The verb stays minimal: destroy
// whatever's on the tile (optionally name-filtered) and drop the items.
// Designer prompt forbids this for natural debris (those are auto-cleared
// at placement time) — preparation is reserved for player-placed teardown.
export async function runPreparation({ controller, plan, log }) {
  const ops = Array.isArray(plan.preparation) ? plan.preparation : [];
  if (ops.length === 0) return [];
  const results = [];
  for (const [i, op] of ops.entries()) {
    if (op.kind === "deconstruct") {
      const pos = op.position;
      log(`[execute][prep] ${i}: deconstruct at (${pos?.x},${pos?.y})${op.entity ? ` name=${op.entity}` : ""}`);
      try {
        const r = await controller.action("deconstruct_at", { position: pos, entity: op.entity });
        log(`[execute][prep] ${i}: destroyed ${r.destroyed} (${(r.names || []).join(", ") || "—"})`);
        results.push({ kind: "deconstruct", index: i, ok: true, destroyed: r.destroyed, names: r.names });
      } catch (err) {
        log(`[execute][prep] ${i}: failed: ${err.message}`);
        results.push({ kind: "deconstruct", index: i, ok: false, error: err.message });
        throw new Error(`preparation step ${i} (deconstruct) failed: ${err.message}`);
      }
    } else {
      throw new Error(`preparation[${i}].kind '${op.kind}' is not supported (only 'deconstruct' for now)`);
    }
  }
  return results;
}

async function repairWithPi({ controller, epoch, plan, placement, error, outDir, log, stateYamlPath }) {
  const config = controller.config;
  const repairDir = join(outDir, "repair", placement.id);
  await mkdir(repairDir, { recursive: true });
  await writeFile(join(repairDir, "plan.yaml"), JSON.stringify(plan, null, 2), "utf8");
  await writeFile(join(repairDir, "failed.json"), JSON.stringify({
    placement,
    error: error.message,
    payload: error.payload,
  }, null, 2), "utf8");
  // Surface state.yaml inside the repair cwd so the agent can grep
  // world_inventory without escaping upward through symlinks.
  if (stateYamlPath) {
    try { await copyFile(stateYamlPath, join(repairDir, "state.yaml")); } catch {}
  }
  const factorioServerExt = resolve(config.rootDir, ".pi/extensions/factorio-server/index.ts");
  const message = [
    `A deterministic blueprint placement failed.`,
    `See failed.json for placement and error details.`,
    ``,
    `Use factorio_read and factorio_action to recover, then re-place the`,
    `blueprint via execute_blueprint with the SAME anchor and direction.`,
    `Save no extra entities. Budget: 30 calls.`,
    ``,
    `Common failure modes — playbook in priority order:`,
    ``,
    `1. MISSING ITEM IN WORKER INVENTORY (precondition_failed with`,
    `   missingItems). Resolve in this order, not bottom-up:`,
    `   a. factorio_read inspect_inventory the chests already deployed in`,
    `      the world — every entry in state.yaml's world_inventory section`,
    `      maps to a chest. If a chest holds the missing item,`,
    `      factorio_action transfer_inventory it into the worker.`,
    `   b. If no chest has it, factorio_read craft_catalog to see what`,
    `      hand-craft can produce; if the missing item is listed and you`,
    `      hold the ingredients (or can craft them transitively), call`,
    `      factorio_action craft. craft_catalog is authoritative — the`,
    `      in-game recipe set is a superset and the craft action will`,
    `      reject anything not in the catalog.`,
    `   c. Only if (a) and (b) both fail: factorio_action mine_resource`,
    `      or place a new mining setup yourself.`,
    ``,
    `2. BLOCKED TILE / wrong anchor: factorio_read inspect_position to`,
    `   see what's there; mine_entity_to_inventory if a stray entity is`,
    `   blocking; or accept that the anchor is wrong and report failure`,
    `   (do not silently move to a different anchor).`,
    ``,
    `3. After resolving the cause, call execute_blueprint with the`,
    `   original anchor + direction. If it still fails, exit with the`,
    `   error rather than improvising further.`,
  ].join("\n");
  log(`[execute][repair] invoking pi for ${placement.id}…`);
  const result = await piInvoke({
    prompt: message,
    tools: ["read", "factorio_read", "factorio_action"],
    extensions: [factorioServerExt],
    cwd: repairDir,
    serviceUrl: config.serviceUrl,
    timeoutMs: 600_000,
    onStdout: (line) => log(`[repair pi] ${line}`),
    onStderr: (line) => process.stderr.write(`[repair pi err] ${line}\n`),
  });
  // Persist the repair trace alongside failed.json so cost/timing of the
  // repair pi call is preserved on disk. Not yet rolled up into run-meta;
  // operators can sum repairDir/*/pi-trace.json manually for now.
  const trace = newTrace("execute_repair", { placement_id: placement.id });
  addPiCall(trace, result);
  await writePiTrace(repairDir, trace);
  return result;
}

// Rotate a canonical (north-orientation) rel_pos by the placement direction.
// Screen coordinates: x right = east, y down = south.
//   North: identity
//   East  (90° CW): (dx, dy) → (-dy,  dx)
//   South (180°):   (dx, dy) → (-dx, -dy)
//   West  (270° CW): (dx, dy) → ( dy, -dx)
export function rotateRelPos(dx, dy, direction) {
  switch ((direction || "north").toLowerCase()) {
    case "east":  return { x: -dy,  y:  dx };
    case "south": return { x: -dx,  y: -dy };
    case "west":  return { x:  dy,  y: -dx };
    default:      return { x:  dx,  y:  dy }; // north
  }
}

// Resolve a port's world position for a given placement.
// Returns null if the port name is not found in the module.
export function resolvePortWorldPos(placement, module, portName) {
  const port = [...(module.inputs || []), ...(module.outputs || [])].find((p) => p.name === portName);
  if (!port) return null;
  const [dx, dy] = port.rel_pos;
  const rotated = rotateRelPos(dx, dy, placement.direction);
  return { x: placement.anchor.x + rotated.x, y: placement.anchor.y + rotated.y };
}

// 2x2 entity types whose center is integer (tile covers center-1 to center).
const TWO_BY_TWO_ENTITIES = new Set(["burner-mining-drill", "stone-furnace"]);

// Build a list of occupied tiles from actual blueprint entity positions.
// Using entity tiles (not the broad footprint bbox) lets the A* router find
// exit paths through gaps between entities, e.g. south of a belt stub.
// routeBelt automatically removes start/goal from the set, so port tiles
// are safe to include here.
export async function buildOccupiedTiles(plan, modules, rootDir) {
  const tiles = [];
  for (const p of (plan.placements || [])) {
    const mod = modules.get(p.module);
    if (!mod) continue;
    let bpPath;
    try {
      bpPath = mod._staged && mod._stagedBlueprintPath
        ? mod._stagedBlueprintPath
        : resolve(rootDir, mod.realization.blueprint);
      const bp = JSON.parse(await readFile(bpPath, "utf8"));
      for (const entity of (bp.entities || [])) {
        const wx = p.anchor.x + entity.dx;
        const wy = p.anchor.y + entity.dy;
        if (TWO_BY_TWO_ENTITIES.has(entity.item)) {
          const cx = Math.round(wx), cy = Math.round(wy);
          tiles.push({ x: cx - 1, y: cy - 1 }, { x: cx, y: cy - 1 },
                     { x: cx - 1, y: cy   }, { x: cx, y: cy   });
        } else {
          tiles.push({ x: Math.floor(wx), y: Math.floor(wy) });
        }
      }
    } catch { /* skip unreadable blueprints */ }
  }
  return tiles;
}

// Wire inter-module connections declared in plan.connections.
// Each connection uses "placementId.portName" references:
//   { from: "p0.coal_belt", to: "p1.coal_in", required_throughput: 0.18 }
// Connections without a dot (e.g. {from: "p0", to: "p1"}) are skipped —
// they are informational-only annotations.
export async function routeConnections({ controller, plan, modules, log }) {
  const placementById = new Map(plan.placements.map((p) => [p.id, p]));
  const occupied = await buildOccupiedTiles(plan, modules, controller.config.rootDir);
  const connections = [];

  for (const conn of (plan.connections || [])) {
    const fromStr = conn.from || "";
    const toStr   = conn.to   || "";
    if (!fromStr.includes(".") || !toStr.includes(".")) continue;

    const [fromId, fromPort] = fromStr.split(".", 2);
    const [toId,   toPort]   = toStr.split(".", 2);

    const fromPlacement = placementById.get(fromId);
    const toPlacement   = placementById.get(toId);
    if (!fromPlacement || !toPlacement) {
      log(`[execute][connect] skipping ${fromStr}→${toStr}: unknown placement id`);
      continue;
    }

    const fromModule = modules.get(fromPlacement.module);
    const toModule   = modules.get(toPlacement.module);
    if (!fromModule || !toModule) {
      log(`[execute][connect] skipping ${fromStr}→${toStr}: module not found`);
      continue;
    }

    const fromPos = resolvePortWorldPos(fromPlacement, fromModule, fromPort);
    const toPos   = resolvePortWorldPos(toPlacement,   toModule,   toPort);
    if (!fromPos || !toPos) {
      log(`[execute][connect] skipping ${fromStr}→${toStr}: port not found (from=${!!fromPos} to=${!!toPos})`);
      continue;
    }

    // Auto-routing is belt-only in V1. Pipe/power connections must live
    // inside a single module, so skip cross-module pairs whose ports are
    // not both kind: belt rather than emitting belts where they don't
    // belong.
    const fromKind = findPort(fromModule, fromPort)?.kind;
    const toKind = findPort(toModule, toPort)?.kind;
    if (fromKind !== "belt" || toKind !== "belt") {
      log(`[execute][connect] skipping ${fromStr}→${toStr}: only belt-to-belt auto-routing supported in V1 (from=${fromKind} to=${toKind})`);
      continue;
    }

    log(`[execute][connect] ${fromStr} (${fromPos.x},${fromPos.y}) → ${toStr} (${toPos.x},${toPos.y})`);
    try {
      const routeResult = await controller.action("route_belt", {
        from: fromPos,
        to:   toPos,
        occupied,
      });

      if (!routeResult.ok) {
        throw new Error(`route_belt failed: ${routeResult.reason || routeResult.code || "unknown"}`);
      }

      log(`[execute][connect] route ok, ${routeResult.length} belts`);

      // Exclude entities whose tile is already occupied by a module blueprint
      // entity (e.g. belt stubs at port positions). Module belts already serve
      // as connectors; placing a second belt on the same tile would fail.
      const occupiedSet = new Set(occupied.map(t => `${t.x},${t.y}`));
      const routeEntities = routeResult.entities.filter(
        (e) => !occupiedSet.has(`${Math.floor(e.pose.center.x)},${Math.floor(e.pose.center.y)}`),
      );
      log(`[execute][connect] placing ${routeEntities.length} new belts (${routeResult.length - routeEntities.length} skipped, already placed)`);

      const bpEntities = routeEntities.map((e, i) => ({
        key: `belt_${i}`,
        item: e.prototype,
        dx:   e.pose.center.x,
        dy:   e.pose.center.y,
        direction: DIRECTION_NAMES[e.pose.direction] || "north",
      }));

      if (bpEntities.length === 0) {
        log(`[execute][connect] ${fromStr}→${toStr}: all route tiles occupied, no new belts to place`);
        connections.push({ from: fromStr, to: toStr, ok: true, length: 0 });
        continue;
      }

      const inlineBp = { version: 1, name: `conn_${fromStr}_${toStr}`, entities: bpEntities };
      const placeResult = await executeBlueprint({
        controller,
        blueprint: inlineBp,
        anchor: { x: 0, y: 0 },
        direction: "north",
        dryRun: false,
      });

      const ok = placeResult?.ok ?? true;
      log(`[execute][connect] placed ${fromStr}→${toStr}: ok=${ok}`);
      connections.push({ from: fromStr, to: toStr, ok, length: routeResult.length });
    } catch (error) {
      log(`[execute][connect] ${fromStr}→${toStr} FAILED: ${error.message}`);
      connections.push({ from: fromStr, to: toStr, ok: false, error: error.message });
      throw new Error(`connection ${fromStr}→${toStr} failed: ${error.message}`);
    }
  }

  return connections;
}

/**
 * @param {object} args
 * @param {object} args.controller
 * @param {object} args.epoch
 * @param {object} args.plan
 * @param {Map<string, object>} args.modules
 * @param {string} args.outDir       — plans/<run>/execute/
 * @param {string} args.savePathOut  — destination for the produced save zip
 * @returns {Promise<{savePath: string, perPlacement: object[]}>}
 */
export async function runExecute({ controller, epoch, plan, modules, outDir, savePathOut, stateYamlPath }) {
  await mkdir(outDir, { recursive: true });
  const log = (msg) => {
    console.log(msg);
  };
  let preparationResults = [];
  try {
    preparationResults = await runPreparation({ controller, plan, log });
  } catch (prepError) {
    await writeFile(join(outDir, "execute.json"), JSON.stringify({
      ok: false, preparation: preparationResults, perPlacement: [],
      error: prepError.message,
    }, null, 2), "utf8");
    throw prepError;
  }
  const perPlacement = [];
  for (const placement of plan.placements) {
    try {
      const r = await placeOne({ controller, placement, modules, log });
      perPlacement.push({ placement: placement.id, ok: true, dry: r.dry, live: r.live });
    } catch (error) {
      log(`[execute] placement ${placement.id} failed: ${error.message}`);
      try {
        await repairWithPi({ controller, epoch, plan, placement, error, outDir, log, stateYamlPath });
        perPlacement.push({ placement: placement.id, ok: true, repaired: true });
      } catch (repairError) {
        perPlacement.push({ placement: placement.id, ok: false, error: error.message, repairError: repairError.message });
        await writeFile(join(outDir, "execute.json"), JSON.stringify({ ok: false, perPlacement }, null, 2), "utf8");
        // Structured proposal for design retry feedback. Placement here is
        // the one that failed; classifyRootCause inspects the error message
        // to bucket common failure shapes (collision / missing resource /
        // blueprint geometry / etc.) into a small enum the LLM can reason
        // about. The raw error is preserved in extra.raw_error.
        const failedStep = plan.placements.findIndex((p) => p.id === placement.id);
        const proposal = buildPlacementProposal(failedStep, placement, error);
        await writeFile(join(outDir, "proposal.json"), JSON.stringify(proposal, null, 2), "utf8");
        throw new Error(`execute failed at placement ${placement.id}: ${error.message}`);
      }
    }
  }

  let connectionResults;
  try {
    connectionResults = await routeConnections({ controller, plan, modules, log });
  } catch (connError) {
    // routeConnections throws "connection <from>→<to> failed: <reason>".
    // Parse the from/to back out so the proposal can name the offending pair.
    const match = (connError.message || "").match(/^connection (\S+)→(\S+) failed: /);
    const conn = match
      ? (plan.connections || []).find((c) => c.from === match[1] && c.to === match[2])
      : null;
    const proposal = buildConnectionProposal(conn ?? (match ? { from: match[1], to: match[2] } : null), connError);
    await writeFile(join(outDir, "proposal.json"), JSON.stringify(proposal, null, 2), "utf8");
    await writeFile(join(outDir, "execute.json"), JSON.stringify({ ok: false, perPlacement, connections: [], save: null }, null, 2), "utf8");
    throw connError;
  }

  log(`[execute] saving game…`);
  await controller.exportZip(savePathOut);
  await writeFile(join(outDir, "execute.json"), JSON.stringify({
    ok: true,
    preparation: preparationResults,
    perPlacement,
    connections: connectionResults,
    save: savePathOut,
  }, null, 2), "utf8");
  return { savePath: savePathOut, perPlacement, preparation: preparationResults };
}
