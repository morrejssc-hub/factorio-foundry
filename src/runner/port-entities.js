// port-entities.js — single source of truth for which Factorio entities
// can serve a module port of a given kind.
//
// Two parallel mappings:
//
//   PORT_CONNECTORS    — entities that move flow through a port. The
//                        port_meter attaches to one of these to read
//                        throughput (a belt-tile, a pipe-tile, an
//                        electric pole on the network).
//
//   PORT_CONTAINERS    — entities that store flow at a port (chests,
//                        tanks, accumulators). The port-meter does not
//                        currently attach to these — they're declared
//                        for kind: inventory ports and reserved for the
//                        future fluid/electric storage variants.
//
// `kind` is the discriminator that travels through the module schema:
//   { name, side, rel_pos, throughput, item, kind } in lib/modules/*.yaml
//   { entity, kind, item }                          in lib/blueprints/*.json
//
// lib-loader.validateModule cross-checks: for kind ∈ {belt, pipe, power}
// the blueprint port's entity-key must resolve to a prototype in
// PORT_CONNECTORS[kind]. Catches drift like kind=belt + entity=pipe.

export const PORT_CONNECTORS = {
  belt:  ["transport-belt", "fast-transport-belt", "express-transport-belt"],
  pipe:  ["pipe"],
  power: ["small-electric-pole", "medium-electric-pole", "big-electric-pole", "substation"],
};

export const PORT_CONTAINERS = {
  inventory: ["wooden-chest", "iron-chest", "steel-chest"],
  // future: fluid -> ["storage-tank"], electric -> ["accumulator"]
};

// Kinds that carry flow and have a port-meter implementation.
export const METERED_KINDS = new Set(Object.keys(PORT_CONNECTORS));

// All valid kind values the schema accepts. Inventory ports are valid
// (a chest IS the port — items move via inserter, not a connector) but
// not metered by port-meter.lua in V1.
export const ALL_KINDS = new Set([
  ...Object.keys(PORT_CONNECTORS),
  ...Object.keys(PORT_CONTAINERS),
]);

/**
 * @param {string} kind        — module port kind from yaml/blueprint
 * @param {string} entityName  — Factorio prototype id (e.g. "transport-belt")
 * @returns {boolean}
 */
export function isAllowedPortEntity(kind, entityName) {
  const connectorList = PORT_CONNECTORS[kind];
  if (connectorList && connectorList.includes(entityName)) return true;
  const containerList = PORT_CONTAINERS[kind];
  if (containerList && containerList.includes(entityName)) return true;
  return false;
}

/**
 * Look up which entity in a blueprint serves a named port.
 *
 * The blueprint shape is:
 *   { entities: [ { key, item, dx, dy, ... } ],
 *     ports: { <portName>: { entity: <entityKey>, kind, item } } }
 *
 * @param {object} blueprint  — parsed blueprint JSON
 * @param {string} portName   — name from module yaml inputs[]/outputs[]
 * @returns {{ entityKey, entityName, dx, dy, kind } | null}
 */
export function resolvePortEntityFromBlueprint(blueprint, portName) {
  if (!blueprint || typeof blueprint !== "object") return null;
  const portRecord = blueprint.ports?.[portName];
  if (!portRecord) return null;
  const entityKey = portRecord.entity;
  if (!entityKey) return null;
  const entity = (blueprint.entities || []).find((e) => e.key === entityKey);
  if (!entity) return null;
  return {
    entityKey,
    entityName: entity.item,
    dx: entity.dx,
    dy: entity.dy,
    kind: portRecord.kind ?? null,
  };
}

/**
 * Build the human-readable registry summary used in the designer prompt.
 * @returns {string}
 */
export function registrySummary() {
  const lines = [];
  for (const [kind, list] of Object.entries(PORT_CONNECTORS)) {
    lines.push(`  ${kind}: ${list.join(", ")}`);
  }
  for (const [kind, list] of Object.entries(PORT_CONTAINERS)) {
    lines.push(`  ${kind}: ${list.join(", ")}`);
  }
  return lines.join("\n");
}
