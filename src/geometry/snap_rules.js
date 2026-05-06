// Geometry Layer v1 — snap rules.
// Computes compatibility between affordance pairs and solves candidate poses
// for a downstream entity given an upstream resolved entity and a named rule.

import { DIRECTION } from "./schema.js";
import { rotateVec2, rotatedTileSize } from "./transform.js";
import { entityFootprintTiles } from "./occupancy.js";

const EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function directionUnitVec(dir) {
  switch (dir) {
    case DIRECTION.NORTH: return { x: 0, y: -1 };
    case DIRECTION.EAST:  return { x: 1, y: 0 };
    case DIRECTION.SOUTH: return { x: 0, y: 1 };
    case DIRECTION.WEST:  return { x: -1, y: 0 };
    default: throw new Error(`invalid direction: ${dir}`);
  }
}

/**
 * Round a raw centre to the parity required by tile dimensions + direction.
 * Even side → integer; odd side → half-integer (x.5).
 */
function roundCenterToParity(raw, tileW, tileH, direction) {
  const { width: w, height: h } = rotatedTileSize(tileW, tileH, direction);
  const roundX = w % 2 === 0
    ? Math.round(raw.x)
    : Math.round(raw.x - 0.5) + 0.5;
  const roundY = h % 2 === 0
    ? Math.round(raw.y)
    : Math.round(raw.y - 0.5) + 0.5;
  return { x: roundX, y: roundY };
}

function findAffById(resolvedOrGeo, id) {
  return resolvedOrGeo.affordances?.find((a) => a.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// checkSnapCompatibility
// ---------------------------------------------------------------------------

/**
 * Check whether two affordances are compatible for a given snap rule.
 * @param {object} producerAff — affordance descriptor from EntityGeometry or resolved entity
 * @param {object} consumerAff — affordance descriptor from EntityGeometry or resolved entity
 * @param {string} ruleName
 * @returns {{ ok: true, rule: string } | { ok: false, code: string, rule: string, reason: string }}
 */
export function checkSnapCompatibility(producerAff, consumerAff, ruleName) {
  switch (ruleName) {
    case "drop_into_pickup": {
      if (producerAff.kind !== "item_drop_point") {
        return { ok: false, code: "incompatible_kinds", rule: ruleName, reason: `producer kind ${producerAff.kind} ≠ item_drop_point` };
      }
      if (!["item_pickup_point", "inventory_area", "belt_carry"].includes(consumerAff.kind)) {
        return { ok: false, code: "incompatible_kinds", rule: ruleName, reason: `consumer kind ${consumerAff.kind} not compatible` };
      }
      return { ok: true, rule: ruleName };
    }
    case "pickup_from_inventory": {
      if (consumerAff.kind !== "item_pickup_point") {
        return { ok: false, code: "incompatible_kinds", rule: ruleName, reason: `consumer kind ${consumerAff.kind} ≠ item_pickup_point` };
      }
      if (!["inventory_area", "belt_carry"].includes(producerAff.kind)) {
        return { ok: false, code: "incompatible_kinds", rule: ruleName, reason: `producer kind ${producerAff.kind} not inventory/belt` };
      }
      return { ok: true, rule: ruleName };
    }
    case "belt_chain": {
      if (producerAff.kind !== "belt_carry") {
        return { ok: false, code: "incompatible_kinds", rule: ruleName, reason: `producer kind ${producerAff.kind} ≠ belt_carry` };
      }
      if (consumerAff.kind !== "belt_carry") {
        return { ok: false, code: "incompatible_kinds", rule: ruleName, reason: `consumer kind ${consumerAff.kind} ≠ belt_carry` };
      }
      return { ok: true, rule: ruleName };
    }
    case "area_covers_resource": {
      if (producerAff.kind !== "resource_search_area") {
        return { ok: false, code: "incompatible_kinds", rule: ruleName, reason: `producer kind ${producerAff.kind} ≠ resource_search_area` };
      }
      return { ok: true, rule: ruleName };
    }
    default:
      return { ok: false, code: "unknown_rule", rule: ruleName, reason: `unknown rule: ${ruleName}` };
  }
}

// ---------------------------------------------------------------------------
// solveSnapPose — dispatcher
// ---------------------------------------------------------------------------

/**
 * Given a fixed upstream resolved entity and an unplaced downstream EntityGeometry,
 * compute candidate poses for the downstream entity that satisfy the snap rule.
 *
 * @param {object} upstreamResolved — result of resolveEntity(geo, pose)
 * @param {string} upstreamAffId
 * @param {object} downstreamGeo — EntityGeometry (no pose)
 * @param {string} downstreamAffId
 * @param {string} ruleName
 * @param {{ pinDirection?: number, resourceTile?: {x:number,y:number} }} [opts]
 * @returns {{ ok: true, rule: string, candidates: Array<{center:{x:number,y:number}, direction:number}> }
 *          | { ok: false, code: string, rule?: string, reason: string }}
 */
export function solveSnapPose(upstreamResolved, upstreamAffId, downstreamGeo,
                              downstreamAffId, ruleName, opts = {}) {
  const upAff = findAffById(upstreamResolved, upstreamAffId);
  if (!upAff) {
    return { ok: false, code: "unknown_affordance", reason: `upstream affordance '${upstreamAffId}' not found` };
  }

  if (ruleName === "area_covers_resource") {
    return solveAreaCoversResource(upstreamResolved, upAff, opts);
  }

  const downAff = downstreamGeo?.affordances?.find((a) => a.id === downstreamAffId) ?? null;
  if (!downAff) {
    return { ok: false, code: "unknown_affordance", reason: `downstream affordance '${downstreamAffId}' not found` };
  }

  const compat = checkSnapCompatibility(upAff, downAff, ruleName);
  if (!compat.ok) return compat;

  switch (ruleName) {
    case "drop_into_pickup":
      return solveDropIntoPickup(upstreamResolved, upAff, downstreamGeo, downAff, opts);
    case "pickup_from_inventory":
      return solvePickupFromInventory(upstreamResolved, upAff, downstreamGeo, downAff, opts);
    case "belt_chain":
      return solveBeltChain(upstreamResolved, upAff, downstreamGeo, downAff, opts);
    default:
      return { ok: false, code: "unknown_rule", rule: ruleName, reason: ruleName };
  }
}

// ---------------------------------------------------------------------------
// drop_into_pickup
// ---------------------------------------------------------------------------

function solveDropIntoPickup(up, upAff, downGeo, downAff, opts) {
  const dropPt = upAff.worldGeometry?.at;
  if (!dropPt) {
    return { ok: false, code: "invalid_world_geometry", rule: "drop_into_pickup", reason: "upstream affordance has no world point" };
  }

  const dirs = opts.pinDirection !== undefined
    ? [opts.pinDirection]
    : downGeo.placement.legalDirections;

  if (dirs.length === 0) {
    return { ok: false, code: "no_legal_direction", rule: "drop_into_pickup", reason: "downstream has no legal directions" };
  }

  const candidates = [];
  const seen = new Set();

  for (const dir of dirs) {
    if (downAff.kind === "item_pickup_point" || downAff.kind === "belt_carry") {
      // point-to-point: align consumer local point with upstream drop point
      const localPt = downAff.localGeometry.at;
      const rotated = rotateVec2(localPt, dir);
      const raw = { x: dropPt.x - rotated.x, y: dropPt.y - rotated.y };
      const centre = roundCenterToParity(raw, downGeo.tileWidth, downGeo.tileHeight, dir);
      const key = `${centre.x},${centre.y},${dir}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push({ center: centre, direction: dir });
      }
    } else if (downAff.kind === "inventory_area") {
      // tile-based: place consumer so the drop falls within one of its inventory tiles
      const dropTile = { x: Math.floor(dropPt.x), y: Math.floor(dropPt.y) };
      const localTiles = downAff.localGeometry.tiles;
      for (const tile of localTiles) {
        const rotated = rotateVec2(tile, dir);
        const raw = { x: dropTile.x - rotated.x, y: dropTile.y - rotated.y };
        const centre = roundCenterToParity(raw, downGeo.tileWidth, downGeo.tileHeight, dir);
        const key = `${centre.x},${centre.y},${dir}`;
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push({ center: centre, direction: dir });
        }
      }
    }
  }

  if (candidates.length === 0) {
    return { ok: false, code: "no_candidate", rule: "drop_into_pickup", reason: "no valid pose found" };
  }
  return { ok: true, rule: "drop_into_pickup", candidates };
}

// ---------------------------------------------------------------------------
// pickup_from_inventory
// ---------------------------------------------------------------------------

function solvePickupFromInventory(up, upAff, downGeo, downAff, opts) {
  const pickupLocal = downAff.localGeometry.at; // item_pickup_point local
  if (!pickupLocal) {
    return { ok: false, code: "invalid_local_geometry", rule: "pickup_from_inventory", reason: "consumer has no pickup point" };
  }

  // Collect upstream tiles (inventory_area or belt_carry)
  let upTiles;
  if (upAff.worldGeometry?.type === "tiles") {
    upTiles = upAff.worldGeometry.tiles;
  } else if (upAff.worldGeometry?.type === "point") {
    upTiles = [{ x: Math.floor(upAff.worldGeometry.at.x), y: Math.floor(upAff.worldGeometry.at.y) }];
  } else {
    return { ok: false, code: "invalid_world_geometry", rule: "pickup_from_inventory", reason: "upstream has no tile/point geometry" };
  }

  const dirs = opts.pinDirection !== undefined
    ? [opts.pinDirection]
    : downGeo.placement.legalDirections;

  if (dirs.length === 0) {
    return { ok: false, code: "no_legal_direction", rule: "pickup_from_inventory", reason: "downstream has no legal directions" };
  }

  const candidates = [];
  const seen = new Set();

  for (const dir of dirs) {
    const rotated = rotateVec2(pickupLocal, dir);
    for (const tile of upTiles) {
      // tile_center = (tile.x + 0.5, tile.y + 0.5)
      // world_pickup = centre + rotated = tile_center
      // centre = tile_center - rotated
      const tileCentre = { x: tile.x + 0.5, y: tile.y + 0.5 };
      const raw = { x: tileCentre.x - rotated.x, y: tileCentre.y - rotated.y };
      const centre = roundCenterToParity(raw, downGeo.tileWidth, downGeo.tileHeight, dir);
      const key = `${centre.x},${centre.y},${dir}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push({ center: centre, direction: dir });
      }
    }
  }

  if (candidates.length === 0) {
    return { ok: false, code: "no_candidate", rule: "pickup_from_inventory", reason: "no valid pose found" };
  }
  return { ok: true, rule: "pickup_from_inventory", candidates };
}

// ---------------------------------------------------------------------------
// belt_chain
// ---------------------------------------------------------------------------

function solveBeltChain(up, upAff, downGeo, downAff, opts) {
  const flowDir = up.pose.direction;

  if (opts.pinDirection !== undefined && opts.pinDirection !== flowDir) {
    return { ok: false, code: "incompatible_direction", rule: "belt_chain", reason: `pinned ${opts.pinDirection} ≠ flow ${flowDir}` };
  }

  const upTile = {
    x: Math.floor(up.pose.center.x),
    y: Math.floor(up.pose.center.y),
  };
  const delta = directionUnitVec(flowDir);
  const adj = { x: upTile.x + delta.x, y: upTile.y + delta.y };

  const raw = { x: adj.x + 0.5, y: adj.y + 0.5 };
  const centre = roundCenterToParity(raw, downGeo.tileWidth, downGeo.tileHeight, flowDir);

  return { ok: true, rule: "belt_chain", candidates: [{ center: centre, direction: flowDir }] };
}

// ---------------------------------------------------------------------------
// area_covers_resource
// ---------------------------------------------------------------------------

function solveAreaCoversResource(up, upAff, opts) {
  const bbox = upAff.worldGeometry?.box;
  if (!bbox) {
    return { ok: false, code: "invalid_world_geometry", rule: "area_covers_resource", reason: "upstream affordance has no bbox" };
  }
  const rt = opts?.resourceTile;
  if (!rt) {
    return { ok: false, code: "missing_resource_tile", rule: "area_covers_resource", reason: "opts.resourceTile required" };
  }

  const tc = { x: rt.x + 0.5, y: rt.y + 0.5 }; // tile centre
  const covered = tc.x >= bbox.leftTop.x - EPSILON
               && tc.x <= bbox.rightBottom.x + EPSILON
               && tc.y >= bbox.leftTop.y - EPSILON
               && tc.y <= bbox.rightBottom.y + EPSILON;

  if (covered) {
    return { ok: true, rule: "area_covers_resource", candidates: [up.pose] };
  }
  return { ok: false, code: "not_covered", rule: "area_covers_resource", reason: `tile (${rt.x},${rt.y}) outside bbox` };
}
