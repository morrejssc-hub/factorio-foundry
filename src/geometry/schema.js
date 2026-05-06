// Geometry Layer v1 — schema, constants, validators.
//
// Canonical frame: Factorio entity-center world coordinates.
//   - 2x2 / even-side entities have integer center (e.g. {x:10, y:10}).
//   - 1x1 / odd-side entities have half-tile center (e.g. {x:10.5, y:10.5}).
// Anchor sugar (top-left tile) lives at the DSL boundary, not in this schema.
//
// Direction encoding (Factorio 2.0 runtime, 16-direction):
//   N=0, E=4, S=8, W=12. MVP enumerates only these four orthogonal values.
//
// See agent-workspace/plans/geometry_layer_v1.md for design rationale.

/**
 * @typedef {{ x: number, y: number }} Vec2
 * @typedef {{ leftTop: Vec2, rightBottom: Vec2 }} BBox
 *
 * @typedef {0 | 4 | 8 | 12} Direction
 *
 * @typedef {"fluid" | "circuit" | "heat"} PortKind
 *
 * @typedef {"item_drop_point"
 *   | "item_pickup_point"
 *   | "inventory_area"
 *   | "belt_carry"
 *   | "resource_search_area"
 *   | "fuel_input"
 *   | "recipe_io"} AffordanceKind
 *
 * @typedef {{
 *   kind: PortKind,
 *   id: string,
 *   localPosition: Vec2,
 *   direction: Direction,
 *   accepts?: string[]
 * }} Port
 *
 * @typedef {{
 *   kind: AffordanceKind,
 *   id: string,
 *   role: "source" | "sink" | "both",
 *   localGeometry: { type: "point", at: Vec2 } | { type: "tiles", tiles: Vec2[] } | { type: "bbox", box: BBox },
 *   accepts?: string[],
 *   directional?: boolean,
 *   notes?: string
 * }} Affordance
 *
 * @typedef {{
 *   prototype: string,
 *   factorioType: string,
 *   placement: { origin: "entity_center", legalDirections: Direction[] },
 *   tileWidth: number,
 *   tileHeight: number,
 *   collisionBox: BBox,
 *   selectionBox: BBox,
 *   ports: Port[],
 *   affordances: Affordance[],
 *   provenance: { source: "runtime_prototype" | "manual" | "synthetic", dumpedAt?: string }
 * }} EntityGeometry
 *
 * @typedef {{
 *   prototype: string,
 *   factorioType?: string,
 *   tileWidth?: number,
 *   tileHeight?: number,
 *   collisionBox?: BBox | null,
 *   selectionBox?: BBox | null,
 *   vectorToPlaceResult?: Vec2 | null,
 *   inserterPickupPosition?: Vec2 | null,
 *   inserterDropPosition?: Vec2 | null,
 *   maxUndergroundDistance?: number | null,
 *   flags?: string[]
 * }} RawPrototype
 */

export const DIRECTION = Object.freeze({
  NORTH: 0,
  EAST: 4,
  SOUTH: 8,
  WEST: 12,
});

export const DIRECTION_NAMES = Object.freeze({
  0: "north",
  4: "east",
  8: "south",
  12: "west",
});

export const ORTHOGONAL_DIRECTIONS = Object.freeze([
  DIRECTION.NORTH,
  DIRECTION.EAST,
  DIRECTION.SOUTH,
  DIRECTION.WEST,
]);

export const AFFORDANCE_KINDS = Object.freeze([
  "item_drop_point",
  "item_pickup_point",
  "inventory_area",
  "belt_carry",
  "resource_search_area",
  "fuel_input",
  "recipe_io",
]);

export const PORT_KINDS = Object.freeze(["fluid", "circuit", "heat"]);

export function isOrthogonalDirection(value) {
  return value === 0 || value === 4 || value === 8 || value === 12;
}

export function directionName(value) {
  return DIRECTION_NAMES[value] || `unknown(${value})`;
}

export function directionFromName(name) {
  switch (String(name).toLowerCase()) {
    case "north": case "n": return DIRECTION.NORTH;
    case "east":  case "e": return DIRECTION.EAST;
    case "south": case "s": return DIRECTION.SOUTH;
    case "west":  case "w": return DIRECTION.WEST;
    default: return null;
  }
}

function isVec2(v) {
  return v && typeof v === "object" && Number.isFinite(v.x) && Number.isFinite(v.y);
}

function isBBox(v) {
  return v && typeof v === "object" && isVec2(v.leftTop) && isVec2(v.rightBottom);
}

function isLocalGeometry(g) {
  if (!g || typeof g !== "object") return false;
  if (g.type === "point") return isVec2(g.at);
  if (g.type === "tiles") return Array.isArray(g.tiles) && g.tiles.every(isVec2);
  if (g.type === "bbox") return isBBox(g.box);
  return false;
}

/**
 * Validate an EntityGeometry record. Returns { ok, errors }.
 * @param {EntityGeometry} geo
 */
export function validateEntityGeometry(geo) {
  const errors = [];
  if (!geo || typeof geo !== "object") return { ok: false, errors: ["not_object"] };

  if (typeof geo.prototype !== "string" || !geo.prototype) errors.push("prototype_missing");
  if (typeof geo.factorioType !== "string") errors.push("factorioType_missing");

  if (!geo.placement || geo.placement.origin !== "entity_center") errors.push("placement_origin_must_be_entity_center");
  if (!geo.placement || !Array.isArray(geo.placement.legalDirections) || geo.placement.legalDirections.length === 0) {
    errors.push("placement_legalDirections_missing");
  } else if (!geo.placement.legalDirections.every(isOrthogonalDirection)) {
    errors.push("placement_legalDirections_non_orthogonal");
  }

  if (!Number.isInteger(geo.tileWidth) || geo.tileWidth <= 0) errors.push("tileWidth_invalid");
  if (!Number.isInteger(geo.tileHeight) || geo.tileHeight <= 0) errors.push("tileHeight_invalid");

  if (!isBBox(geo.collisionBox)) errors.push("collisionBox_invalid");
  if (!isBBox(geo.selectionBox)) errors.push("selectionBox_invalid");

  if (!Array.isArray(geo.ports)) errors.push("ports_not_array");
  else for (const [i, p] of geo.ports.entries()) {
    if (!PORT_KINDS.includes(p.kind)) errors.push(`ports[${i}].kind_invalid`);
    if (typeof p.id !== "string" || !p.id) errors.push(`ports[${i}].id_missing`);
    if (!isVec2(p.localPosition)) errors.push(`ports[${i}].localPosition_invalid`);
    if (!isOrthogonalDirection(p.direction)) errors.push(`ports[${i}].direction_invalid`);
  }

  if (!Array.isArray(geo.affordances)) errors.push("affordances_not_array");
  else for (const [i, a] of geo.affordances.entries()) {
    if (!AFFORDANCE_KINDS.includes(a.kind)) errors.push(`affordances[${i}].kind_invalid`);
    if (typeof a.id !== "string" || !a.id) errors.push(`affordances[${i}].id_missing`);
    if (!["source", "sink", "both"].includes(a.role)) errors.push(`affordances[${i}].role_invalid`);
    if (!isLocalGeometry(a.localGeometry)) errors.push(`affordances[${i}].localGeometry_invalid`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate a RawPrototype dump record (looser than EntityGeometry).
 * @param {RawPrototype} raw
 */
export function validateRawPrototype(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["not_object"] };
  if (typeof raw.prototype !== "string" || !raw.prototype) errors.push("prototype_missing");
  if (raw.collisionBox != null && !isBBox(raw.collisionBox)) errors.push("collisionBox_invalid");
  if (raw.selectionBox != null && !isBBox(raw.selectionBox)) errors.push("selectionBox_invalid");
  if (raw.vectorToPlaceResult != null && !isVec2(raw.vectorToPlaceResult)) errors.push("vectorToPlaceResult_invalid");
  if (raw.inserterPickupPosition != null && !isVec2(raw.inserterPickupPosition)) errors.push("inserterPickupPosition_invalid");
  if (raw.inserterDropPosition != null && !isVec2(raw.inserterDropPosition)) errors.push("inserterDropPosition_invalid");
  return { ok: errors.length === 0, errors };
}
