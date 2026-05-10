// execute.js — placement primitives shared by verify.js.
//
// After the snapshot/rollback flip in verify, the runner no longer needs
// a separate execute pass to produce the winner save (verify owns the
// whole pipeline now). What remains here is the lower-level vocabulary
// that verify composes: place a single blueprint, run plan.preparation
// teardowns, route belt connections between placements, plus the small
// geometry helpers used by both verify and meter-resolver.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DIRECTION_NAMES } from "../geometry/schema.js";
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
