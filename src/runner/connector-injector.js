// connector-injector.js — algorithmically merges N sub-designer plan
// fragments into a single plan.yaml satisfying PLAN_SCHEMA. Validates
// region containment, cross-fragment occupancy, port bindings, and
// pre-checks routeBelt feasibility for each contract pairing.
//
// No LLM is involved — all merge logic is deterministic. The actual
// belt placement still happens at execute time via the existing
// routeConnections path in execute.js; this module's pre-check uses the
// same routeBelt JS function to fail fast at design time when no path
// exists.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { OccupancySet } from "../geometry/occupancy.js";
import { routeBelt } from "../geometry/belt_routing.js";
import { findPort } from "../lib-loader.js";
import { DIRECTION } from "../geometry/schema.js";

// Mirrors execute.js's whitelist for tile expansion of integer-center entities.
const TWO_BY_TWO_ENTITIES = new Set(["burner-mining-drill", "stone-furnace"]);

function rotateRelPos(dx, dy, direction) {
  switch ((direction || "north").toLowerCase()) {
    case "east":  return { x: -dy,  y:  dx };
    case "south": return { x: -dx,  y: -dy };
    case "west":  return { x:  dy,  y: -dx };
    default:      return { x:  dx,  y:  dy }; // north
  }
}

function placementInRegion(placement, module, region) {
  const x0 = placement.anchor.x + module.footprint.min[0];
  const y0 = placement.anchor.y + module.footprint.min[1];
  const x1 = placement.anchor.x + module.footprint.max[0];
  const y1 = placement.anchor.y + module.footprint.max[1];
  if (x0 < region.x_min || x1 > region.x_max) return false;
  if (y0 < region.y_min || y1 > region.y_max) return false;
  return true;
}

function entityWorldTiles(entity, anchor) {
  const wx = anchor.x + entity.dx;
  const wy = anchor.y + entity.dy;
  if (TWO_BY_TWO_ENTITIES.has(entity.item)) {
    const cx = Math.round(wx), cy = Math.round(wy);
    return [
      { x: cx - 1, y: cy - 1 },
      { x: cx,     y: cy - 1 },
      { x: cx - 1, y: cy     },
      { x: cx,     y: cy     },
    ];
  }
  return [{ x: Math.floor(wx), y: Math.floor(wy) }];
}

async function placementEntityTiles(placement, module, rootDir) {
  const bpPath = module._staged && module._stagedBlueprintPath
    ? module._stagedBlueprintPath
    : resolve(rootDir, module.realization.blueprint);
  const bp = JSON.parse(await readFile(bpPath, "utf8"));
  const tiles = [];
  for (const entity of (bp.entities || [])) {
    tiles.push(...entityWorldTiles(entity, placement.anchor));
  }
  return tiles;
}

function resolvePortWorldPos(placement, module, portName) {
  const port = findPort(module, portName);
  if (!port) return null;
  const [dx, dy] = port.rel_pos;
  const rotated = rotateRelPos(dx, dy, placement.direction);
  return {
    x: placement.anchor.x + rotated.x,
    y: placement.anchor.y + rotated.y,
    side: port.side,
    kind: port.kind,
  };
}

/**
 * Inject inter-region transport-belt connectors and synthesise a final
 * plan.yaml from sub-designer fragments. Pure-function: no Factorio
 * involvement. routeBelt is used as a feasibility pre-check; actual
 * placement happens at execute time via the existing connections
 * pipeline.
 *
 * @param {object} args
 * @param {object} args.decomposition
 * @param {Array<{sub_id, sub, fragment, errors}>} args.subResults
 * @param {Map<string, object>} args.modules — lib + parent staged
 * @param {string} args.rootDir
 * @returns {Promise<{plan: object|null, errors: string[]}>}
 */
export async function injectConnectors({ decomposition, subResults, modules, rootDir }) {
  const errors = [];

  for (const r of subResults) {
    for (const e of (r.errors || [])) errors.push(`sub ${r.sub_id}: ${e}`);
  }

  const subsById = new Map(decomposition.subs.map((s) => [s.id, s]));
  const fragmentsBySubId = new Map();
  for (const r of subResults) {
    if (r.fragment) fragmentsBySubId.set(r.sub_id, r.fragment);
  }
  for (const sub of decomposition.subs) {
    if (!fragmentsBySubId.has(sub.id)) {
      errors.push(`sub ${sub.id}: no plan-fragment.yaml produced`);
    }
  }

  if (errors.length) return { plan: null, errors };

  // Region containment + cross-fragment occupancy
  const namespacedPlacements = []; // {namespaced_id, original_id, sub_id, placement, module}
  const occupancy = new OccupancySet();

  for (const sub of decomposition.subs) {
    const fragment = fragmentsBySubId.get(sub.id);
    for (const p of (fragment.placements || [])) {
      const module = modules.get(p.module);
      if (!module) {
        errors.push(`sub ${sub.id}: placement ${p.id} references unknown module "${p.module}"`);
        continue;
      }
      if (!placementInRegion(p, module, sub.region)) {
        errors.push(
          `sub ${sub.id}: placement ${p.id} (${p.module}) at anchor (${p.anchor.x},${p.anchor.y}) ` +
          `extends outside region x:${sub.region.x_min}..${sub.region.x_max} y:${sub.region.y_min}..${sub.region.y_max}`,
        );
        continue;
      }
      let tiles;
      try {
        tiles = await placementEntityTiles(p, module, rootDir);
      } catch (e) {
        errors.push(`sub ${sub.id}: placement ${p.id} blueprint read failed: ${e.message}`);
        continue;
      }
      const result = occupancy.addAll(tiles);
      if (!result.ok) {
        const sample = result.conflicts.slice(0, 3).map((c) => `(${c.x},${c.y})`).join(",");
        const more = result.conflicts.length > 3 ? `…+${result.conflicts.length - 3} more` : ``;
        errors.push(
          `sub ${sub.id}: placement ${p.id} (${p.module}) tiles overlap previously placed entities at ${sample}${more}`,
        );
        continue;
      }
      namespacedPlacements.push({
        original_id: p.id,
        sub_id: sub.id,
        namespaced_id: `${sub.id}__${p.id}`,
        placement: { ...p, id: `${sub.id}__${p.id}` },
        module,
      });
    }
  }

  if (errors.length) return { plan: null, errors };

  // Resolve port pairings → plan-level connections
  const connections = [];

  for (const sub of decomposition.subs) {
    const fragment = fragmentsBySubId.get(sub.id);
    const ports = fragment.ports || {};

    for (const portSpec of (sub.contract?.outputs || [])) {
      const binding = ports[portSpec.id];
      if (!binding) {
        errors.push(`sub ${sub.id}: ports.${portSpec.id} not declared in fragment`);
        continue;
      }
      const pw = portSpec.paired_with;
      if (!pw || typeof pw !== "string" || !pw.includes(".")) {
        errors.push(`sub ${sub.id}: contract.outputs.${portSpec.id}.paired_with must be "<sub>.<port>" (got ${JSON.stringify(pw)})`);
        continue;
      }
      const [otherSubId, otherPortId] = pw.split(".", 2);
      const otherSub = subsById.get(otherSubId);
      const otherFragment = fragmentsBySubId.get(otherSubId);
      if (!otherSub || !otherFragment) {
        errors.push(`sub ${sub.id}: paired_with references unknown sub "${otherSubId}"`);
        continue;
      }
      const otherBinding = (otherFragment.ports || {})[otherPortId];
      if (!otherBinding || typeof otherBinding !== "string" || !otherBinding.includes(".")) {
        errors.push(`sub ${sub.id}: paired sub ${otherSubId} did not declare port ${otherPortId} (or its binding is malformed)`);
        continue;
      }

      const [fromPlacementId, fromModulePort] = binding.split(".", 2);
      const [toPlacementId, toModulePort] = otherBinding.split(".", 2);

      const fromNS = namespacedPlacements.find((n) => n.sub_id === sub.id && n.original_id === fromPlacementId);
      const toNS   = namespacedPlacements.find((n) => n.sub_id === otherSubId && n.original_id === toPlacementId);
      if (!fromNS) {
        errors.push(`sub ${sub.id}: ports.${portSpec.id} → unknown placement "${fromPlacementId}"`);
        continue;
      }
      if (!toNS) {
        errors.push(`sub ${otherSubId}: ports.${otherPortId} → unknown placement "${toPlacementId}"`);
        continue;
      }
      const fromPort = findPort(fromNS.module, fromModulePort);
      const toPort   = findPort(toNS.module,   toModulePort);
      if (!fromPort) {
        errors.push(`sub ${sub.id}: module ${fromNS.module.id} has no port "${fromModulePort}"`);
        continue;
      }
      if (!toPort) {
        errors.push(`sub ${otherSubId}: module ${toNS.module.id} has no port "${toModulePort}"`);
        continue;
      }
      if (fromPort.kind !== "belt" || toPort.kind !== "belt") {
        errors.push(
          `connector ${sub.id}.${portSpec.id} → ${otherSubId}.${otherPortId}: ` +
          `port kinds must both be "belt" (from=${fromPort.kind}, to=${toPort.kind})`,
        );
        continue;
      }

      connections.push({
        from: `${fromNS.namespaced_id}.${fromModulePort}`,
        to: `${toNS.namespaced_id}.${toModulePort}`,
        required_throughput: portSpec.rate ?? 0,
      });
    }
  }

  if (errors.length) return { plan: null, errors };

  // Pre-check routeBelt feasibility for each connection.
  const occupiedTiles = occupancy.list();
  for (const conn of connections) {
    const [fromIdNS, fromPortName] = conn.from.split(".", 2);
    const [toIdNS, toPortName] = conn.to.split(".", 2);
    const fromNS = namespacedPlacements.find((n) => n.namespaced_id === fromIdNS);
    const toNS   = namespacedPlacements.find((n) => n.namespaced_id === toIdNS);
    const fromPos = resolvePortWorldPos(fromNS.placement, fromNS.module, fromPortName);
    const toPos   = resolvePortWorldPos(toNS.placement,   toNS.module,   toPortName);
    if (!fromPos || !toPos) {
      errors.push(`connector ${conn.from} → ${conn.to}: port world position resolution failed`);
      continue;
    }

    const result = routeBelt(
      { x: fromPos.x, y: fromPos.y, direction: DIRECTION.EAST },
      { x: toPos.x,   y: toPos.y,   direction: DIRECTION.EAST },
      occupiedTiles,
      { allowUnderground: true, undergroundMaxDistance: 6 },
    );
    if (!result.ok) {
      errors.push(
        `connector ${conn.from} → ${conn.to}: routeBelt pre-check failed: ` +
        `${result.reason || result.code || "no path"} ` +
        `(from ${fromPos.x},${fromPos.y} to ${toPos.x},${toPos.y})`,
      );
    }
  }

  if (errors.length) return { plan: null, errors };

  // Synthesise plan.
  let expectedThroughput = 0;
  for (const sub of decomposition.subs) {
    const fragment = fragmentsBySubId.get(sub.id);
    const local = fragment.expected_local_throughput;
    if (local && typeof local === "object" && !Array.isArray(local)) {
      for (const v of Object.values(local)) {
        if (Number.isFinite(v)) expectedThroughput += v;
      }
    }
  }

  const scalingNote =
    `Composed from ${decomposition.subs.length} sub-designers (` +
    decomposition.subs.map((s) => s.id).join(", ") +
    `) with ${connections.length} inter-region belt connector${connections.length === 1 ? "" : "s"}.`;

  const plan = {
    epoch: decomposition.epoch,
    placements: namespacedPlacements.map((n) => n.placement),
    connections,
    expected_throughput: expectedThroughput,
    scaling_note: scalingNote,
    extra: {
      synthesized_from: "decomposition",
      subs: decomposition.subs.map((s) => s.id),
      sub_fragments: subResults.map((r) => ({
        sub_id: r.sub_id,
        placements: r.fragment ? r.fragment.placements.length : 0,
        ports: r.fragment ? Object.keys(r.fragment.ports || {}).length : 0,
      })),
    },
  };

  return { plan, errors: [] };
}
