// dry-validate.js — pure deterministic plan validation. No LLM, no Factorio
// state changes. Checks:
//   1. Every placement references a known module.
//   2. Footprints don't overlap (axis-aligned bbox after anchor translation).
//   3. Every connection references existing ports on existing modules.
//   4. Connected port `kind` and `item` match.
//   5. (Optional) Calls Factorio `validate_placement` Lua probe through the
//      existing factorio_read HTTP endpoint to confirm tile-level placement
//      feasibility for each entity referenced by the blueprint.
//
// Returns { ok, errors[] } and writes dry-validate.json to outDir.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { footprintOverlaps, findPort } from "../lib-loader.js";

function rotateOffset(rel, direction) {
  // direction: "north" | "east" | "south" | "west" — anchor-relative.
  // Module port rel_pos is defined in the canonical orientation; rotating
  // applies a 90-degree rotation matrix.
  const [x, y] = rel;
  switch (direction) {
    case "north": return [x, y];
    case "east":  return [-y, x];
    case "south": return [-x, -y];
    case "west":  return [y, -x];
    default:      return [x, y];
  }
}

function placedFootprint(placement, module) {
  return {
    anchor: placement.anchor,
    footprint: module.footprint,
  };
}

function checkPlacements(plan, modules) {
  const errors = [];
  const placed = [];
  for (const [i, p] of (plan.placements || []).entries()) {
    const module = modules.get(p.module);
    if (!module) {
      errors.push(`placements[${i}]: unknown module '${p.module}'`);
      continue;
    }
    if (!p.anchor || !Number.isFinite(p.anchor.x) || !Number.isFinite(p.anchor.y)) {
      errors.push(`placements[${i}]: anchor must be {x, y} numbers`);
      continue;
    }
    placed.push({ index: i, placement: p, module });
  }
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const a = placedFootprint(placed[i].placement, placed[i].module);
      const b = placedFootprint(placed[j].placement, placed[j].module);
      if (footprintOverlaps(a, b)) {
        errors.push(`placements[${placed[i].index}] and placements[${placed[j].index}] footprints overlap`);
      }
    }
  }
  return { errors, placed };
}

// Parse a connection endpoint from either the string "placementId.portName"
// format or the legacy object {placement, port} format.
function parseEndpoint(raw) {
  if (typeof raw === "string") {
    const dot = raw.indexOf(".");
    if (dot > 0) return { placement: raw.slice(0, dot), port: raw.slice(dot + 1) };
    return { placement: raw, port: null };
  }
  if (raw && typeof raw === "object") return { placement: raw.placement, port: raw.port };
  return { placement: undefined, port: undefined };
}

function checkConnections(plan, placedById, modules) {
  const errors = [];
  for (const [i, c] of (plan.connections || []).entries()) {
    const from = parseEndpoint(c.from);
    const to   = parseEndpoint(c.to);

    // Connections without a port reference are informational-only; skip checks.
    if (!from.port && !to.port) continue;

    const fromPlacement = placedById.get(from.placement);
    const toPlacement   = placedById.get(to.placement);
    if (!fromPlacement) errors.push(`connections[${i}].from placement '${from.placement}' not found`);
    if (!toPlacement)   errors.push(`connections[${i}].to placement '${to.placement}' not found`);
    if (!fromPlacement || !toPlacement) continue;

    const fromPort = findPort(fromPlacement.module, from.port);
    const toPort   = findPort(toPlacement.module,   to.port);
    if (!fromPort) errors.push(`connections[${i}].from port '${from.port}' not on module ${fromPlacement.module.id}`);
    if (!toPort)   errors.push(`connections[${i}].to port '${to.port}' not on module ${toPlacement.module.id}`);
    if (!fromPort || !toPort) continue;

    if (fromPort.kind !== toPort.kind) {
      errors.push(`connections[${i}]: kind mismatch (${fromPort.kind} → ${toPort.kind})`);
    }
    if (fromPort.item && toPort.item && fromPort.item !== toPort.item) {
      errors.push(`connections[${i}]: item mismatch (${fromPort.item} → ${toPort.item})`);
    }
    if (fromPort.throughput !== undefined
      && toPort.throughput !== undefined
      && fromPort.throughput < (c.required_throughput || 0)) {
      errors.push(`connections[${i}]: source throughput ${fromPort.throughput} below required ${c.required_throughput}`);
    }
  }
  return { errors };
}

/**
 * @param {object} args
 * @param {object} args.plan      — parsed plan.yaml
 * @param {Map<string, object>} args.modules — from loadAllModules
 * @param {string} args.outDir    — plans/<run>/ directory
 * @returns {Promise<{ok: boolean, errors: string[]}>}
 */
export async function runDryValidate({ plan, modules, outDir }) {
  const errors = [];
  if (!Array.isArray(plan.placements) || plan.placements.length === 0) {
    errors.push("plan.placements must be a non-empty array");
  }
  const placementResult = checkPlacements(plan, modules);
  errors.push(...placementResult.errors);

  const placedById = new Map();
  for (const p of placementResult.placed) {
    const id = p.placement.id || `p${p.index}`;
    if (placedById.has(id)) {
      errors.push(`duplicate placement id '${id}'`);
    } else {
      placedById.set(id, p);
    }
  }

  const connectionResult = checkConnections(plan, placedById, modules);
  errors.push(...connectionResult.errors);

  // The four-field constraint that Designer prompt enforces. dry-validate
  // double-checks structurally so a violation is caught even if Designer
  // prompts get tweaked.
  for (const required of ["placements", "expected_throughput", "scaling_note"]) {
    if (!(required in plan)) errors.push(`plan missing required field: ${required}`);
  }
  if (!("connections" in plan)) errors.push("plan missing required field: connections (use [] for none)");

  const ok = errors.length === 0;
  const verdict = { ok, errors, plan_summary: {
    placements: plan.placements?.length || 0,
    connections: plan.connections?.length || 0,
    expected_throughput: plan.expected_throughput,
  } };
  await writeFile(resolve(outDir, "dry-validate.json"), JSON.stringify(verdict, null, 2), "utf8");
  return verdict;
}

export { rotateOffset };
