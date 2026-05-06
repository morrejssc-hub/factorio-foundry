// Geometry Layer v1 — entity adapters.
// Lift raw runtime prototype data into EntityGeometry by overlaying manual
// affordance/port semantics. Per the plan (§1):
//   - port = real socket-like connection (fluid/circuit/heat). MVP entities
//     have none.
//   - affordance = action point or area (drop, pickup, inventory, belt carry,
//     resource search, fuel input, recipe IO).
// All local positions are in entity-center frame, north-facing canonical.
// Rotation is handled by Layer 1 transform.js; do not write rotated data here.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DIRECTION,
  ORTHOGONAL_DIRECTIONS,
  validateEntityGeometry,
  validateRawPrototype,
} from "./schema.js";

/** @typedef {import("./schema.js").EntityGeometry} EntityGeometry */
/** @typedef {import("./schema.js").RawPrototype} RawPrototype */

const NON_ROTATABLE_FLAG = "not-rotatable";

function bboxFromHalfExtent(width, height) {
  const w = width / 2, h = height / 2;
  return { leftTop: { x: -w, y: -h }, rightBottom: { x: w, y: h } };
}

function normalizeRaw(name, raw) {
  if (!raw) return null;
  const out = { prototype: name };
  if (raw.type) out.factorioType = raw.type;
  if (raw.tile_width) out.tileWidth = raw.tile_width;
  if (raw.tile_height) out.tileHeight = raw.tile_height;
  if (raw.collision_box) out.collisionBox = raw.collision_box;
  if (raw.selection_box) out.selectionBox = raw.selection_box;
  if (raw.collisionBox) out.collisionBox = raw.collisionBox;
  if (raw.selectionBox) out.selectionBox = raw.selectionBox;
  if (raw.vector_to_place_result) out.vectorToPlaceResult = raw.vector_to_place_result;
  if (raw.inserter_pickup_position) out.inserterPickupPosition = raw.inserter_pickup_position;
  if (raw.inserter_drop_position) out.inserterDropPosition = raw.inserter_drop_position;
  if (typeof raw.max_underground_distance === "number") out.maxUndergroundDistance = raw.max_underground_distance;
  if (Array.isArray(raw.flags)) out.flags = raw.flags;
  return out;
}

function legalDirectionsFor(raw) {
  if (Array.isArray(raw.flags) && raw.flags.includes(NON_ROTATABLE_FLAG)) {
    return [DIRECTION.NORTH];
  }
  return [...ORTHOGONAL_DIRECTIONS];
}

function bodyTilesFootprint(width, height) {
  // Tiles enumerated relative to entity center. Even-side entities have
  // integer center; odd-side entities have half-tile center. Caller resolves
  // tile coordinates only after a pose is chosen.
  const tiles = [];
  const xStart = -Math.floor(width / 2);
  const yStart = -Math.floor(height / 2);
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      tiles.push({ x: xStart + dx, y: yStart + dy });
    }
  }
  return tiles;
}

// ---------- per-entity adapters ----------

function adaptBurnerMiningDrill(raw) {
  const drop = raw.vectorToPlaceResult || { x: 0, y: -1 };
  const w = raw.tileWidth || 2, h = raw.tileHeight || 2;
  return {
    ports: [],
    affordances: [
      {
        kind: "item_drop_point",
        id: "mined_output",
        role: "source",
        localGeometry: { type: "point", at: drop },
        accepts: ["item"],
        directional: true,
        notes: "north-frame; rotates with entity direction",
      },
      {
        kind: "resource_search_area",
        id: "ore_coverage",
        role: "source",
        localGeometry: { type: "bbox", box: bboxFromHalfExtent(w, h) },
        accepts: ["resource"],
      },
      {
        kind: "fuel_input",
        id: "burner_fuel",
        role: "sink",
        localGeometry: { type: "tiles", tiles: bodyTilesFootprint(w, h) },
        accepts: ["chemical_fuel"],
      },
    ],
  };
}

function adaptElectricMiningDrill(raw) {
  const drop = raw.vectorToPlaceResult || { x: 0, y: -2 };
  const w = raw.tileWidth || 3, h = raw.tileHeight || 3;
  return {
    ports: [],
    affordances: [
      {
        kind: "item_drop_point",
        id: "mined_output",
        role: "source",
        localGeometry: { type: "point", at: drop },
        accepts: ["item"],
        directional: true,
      },
      {
        kind: "resource_search_area",
        id: "ore_coverage",
        role: "source",
        localGeometry: { type: "bbox", box: bboxFromHalfExtent(w, h) },
        accepts: ["resource"],
      },
    ],
  };
}

function adaptStoneFurnace(raw) {
  // Stone furnace has no directional ports (it is non-rotatable). Inserters
  // resolve direction; furnace exposes a single inventory_area covering its
  // body for both source (output) and sink (input).
  const w = raw.tileWidth || 2, h = raw.tileHeight || 2;
  return {
    ports: [],
    affordances: [
      {
        kind: "inventory_area",
        id: "recipe_io",
        role: "both",
        localGeometry: { type: "tiles", tiles: bodyTilesFootprint(w, h) },
        accepts: ["item"],
      },
      {
        kind: "fuel_input",
        id: "burner_fuel",
        role: "sink",
        localGeometry: { type: "tiles", tiles: bodyTilesFootprint(w, h) },
        accepts: ["chemical_fuel"],
      },
    ],
  };
}

function adaptBurnerInserter(raw) {
  const pickup = raw.inserterPickupPosition || { x: 0, y: -1 };
  const drop = raw.inserterDropPosition || { x: 0, y: 1.2 };
  return {
    ports: [],
    affordances: [
      {
        kind: "item_pickup_point",
        id: "pickup",
        role: "sink",
        localGeometry: { type: "point", at: pickup },
        accepts: ["item"],
        directional: true,
        notes: "consumes from this world point",
      },
      {
        kind: "item_drop_point",
        id: "drop",
        role: "source",
        localGeometry: { type: "point", at: drop },
        accepts: ["item"],
        directional: true,
        notes: "deposits at this world point",
      },
      {
        kind: "fuel_input",
        id: "burner_fuel",
        role: "sink",
        localGeometry: { type: "point", at: { x: 0, y: 0 } },
        accepts: ["chemical_fuel"],
      },
    ],
  };
}

function adaptTransportBelt(_raw) {
  return {
    ports: [],
    affordances: [
      {
        kind: "belt_carry",
        id: "lane",
        role: "both",
        localGeometry: { type: "point", at: { x: 0, y: 0 } },
        accepts: ["item"],
        directional: true,
        notes: "items enter at body tile and flow toward direction face",
      },
    ],
  };
}

function adaptUndergroundBelt(raw) {
  // MVP: model the body as a belt-like single tile. Underground pairing is
  // Phase 7+ via underground_pair snap rule. Capture max distance for later.
  return {
    ports: [],
    affordances: [
      {
        kind: "belt_carry",
        id: "lane",
        role: "both",
        localGeometry: { type: "point", at: { x: 0, y: 0 } },
        accepts: ["item"],
        directional: true,
        notes: `underground_max_distance=${raw.maxUndergroundDistance ?? "unknown"}; pairing rule deferred`,
      },
    ],
  };
}

const ADAPTERS = Object.freeze({
  "burner-mining-drill":   adaptBurnerMiningDrill,
  "electric-mining-drill": adaptElectricMiningDrill,
  "stone-furnace":         adaptStoneFurnace,
  "burner-inserter":       adaptBurnerInserter,
  "transport-belt":        adaptTransportBelt,
  "underground-belt":      adaptUndergroundBelt,
});

export const SUPPORTED_ENTITIES = Object.freeze(Object.keys(ADAPTERS));

function buildEntityGeometry(raw, dumpedAt) {
  const adapter = ADAPTERS[raw.prototype];
  if (!adapter) throw new Error(`no adapter registered for ${raw.prototype}`);
  const overlay = adapter(raw);
  return {
    prototype: raw.prototype,
    factorioType: raw.factorioType || "unknown",
    placement: { origin: "entity_center", legalDirections: legalDirectionsFor(raw) },
    tileWidth: raw.tileWidth || 1,
    tileHeight: raw.tileHeight || 1,
    collisionBox: raw.collisionBox,
    selectionBox: raw.selectionBox,
    ports: overlay.ports,
    affordances: overlay.affordances,
    provenance: { source: "runtime_prototype", dumpedAt },
  };
}

/**
 * Build an EntityGeometry from a raw prototype object (for tests/fixtures).
 * @param {RawPrototype} raw
 */
export function buildFromRaw(raw, dumpedAt) {
  const rawCheck = validateRawPrototype(raw);
  if (!rawCheck.ok) throw new Error(`invalid raw for ${raw?.prototype}: ${rawCheck.errors.join(",")}`);
  const geo = buildEntityGeometry(raw, dumpedAt || null);
  const geoCheck = validateEntityGeometry(geo);
  if (!geoCheck.ok) throw new Error(`adapter produced invalid EntityGeometry for ${raw.prototype}: ${geoCheck.errors.join(",")}`);
  return geo;
}

/**
 * Load all supported EntityGeometries from the persisted raw dump.
 * @param {string} agentWorkspace
 * @returns {Promise<{ geometries: Record<string, EntityGeometry>, missing: string[], dumpedAt: string|null }>}
 */
export async function loadEntityGeometries(agentWorkspace) {
  const path = join(agentWorkspace, "data", "entity_geometry_raw.json");
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { geometries: {}, missing: [...SUPPORTED_ENTITIES], dumpedAt: null, source: null };
    }
    throw error;
  }
  const dump = JSON.parse(text);
  const geometries = {};
  const missing = [];
  for (const name of SUPPORTED_ENTITIES) {
    const raw = normalizeRaw(name, dump.prototypes?.[name]);
    if (!raw || !raw.collisionBox || !raw.selectionBox || !raw.tileWidth || !raw.tileHeight) {
      missing.push(name);
      continue;
    }
    geometries[name] = buildFromRaw(raw, dump.dumpedAt || null);
  }
  return { geometries, missing, dumpedAt: dump.dumpedAt || null, source: path };
}

/**
 * Synchronous helper for unit-test fixtures: feed a raw map directly.
 * @param {Record<string, object>} rawMap
 */
export function buildFromRawMap(rawMap, dumpedAt) {
  const geometries = {};
  const missing = [];
  for (const name of SUPPORTED_ENTITIES) {
    const raw = normalizeRaw(name, rawMap[name]);
    if (!raw || !raw.collisionBox || !raw.selectionBox) {
      missing.push(name);
      continue;
    }
    geometries[name] = buildFromRaw(raw, dumpedAt || null);
  }
  return { geometries, missing };
}
