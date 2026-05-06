// Geometry Layer v1 — resolve EntityGeometry + Pose to world-space ports and
// affordances. North-canonical local data is rotated by pose.direction (only
// when the affordance is `directional`, or it is a port — ports are always
// directional) and then translated by pose.center.

import {
  rotateVec2,
  rotateBBox,
  translateVec2,
  translateBBox,
  isPose,
} from "./transform.js";
import { entityFootprintTiles } from "./occupancy.js";

/** @typedef {import("./schema.js").EntityGeometry} EntityGeometry */
/** @typedef {import("./schema.js").Vec2} Vec2 */
/** @typedef {import("./transform.js").Pose} Pose */

const DIRECTION_DELTA = 16; // Factorio 2.0 16-direction mod

function rotateDirection(dir, by) {
  return ((dir + by) % DIRECTION_DELTA + DIRECTION_DELTA) % DIRECTION_DELTA;
}

function resolveLocalGeometry(local, pose, directional) {
  const rotate = directional ? pose.direction : 0;
  if (local.type === "point") {
    const r = rotate ? rotateVec2(local.at, rotate) : local.at;
    return { type: "point", at: translateVec2(r, pose.center) };
  }
  if (local.type === "bbox") {
    const r = rotate ? rotateBBox(local.box, rotate) : local.box;
    return { type: "bbox", box: translateBBox(r, pose.center) };
  }
  if (local.type === "tiles") {
    const tiles = local.tiles.map((t) => {
      const r = rotate ? rotateVec2(t, rotate) : t;
      const w = translateVec2(r, pose.center);
      return { x: Math.floor(w.x), y: Math.floor(w.y) };
    });
    return { type: "tiles", tiles };
  }
  throw new Error(`unknown localGeometry.type: ${local.type}`);
}

/**
 * Resolve all ports of an EntityGeometry under the given pose.
 * Ports are always directional; their direction is rotated alongside position.
 */
export function resolvePorts(geo, pose) {
  if (!isPose(pose)) throw new Error("invalid pose");
  return geo.ports.map((p) => ({
    kind: p.kind,
    id: p.id,
    accepts: p.accepts,
    worldPosition: translateVec2(rotateVec2(p.localPosition, pose.direction), pose.center),
    direction: rotateDirection(p.direction, pose.direction),
  }));
}

/**
 * Resolve all affordances of an EntityGeometry under the given pose. Returns
 * world-space localGeometry; affordances marked `directional: false` are not
 * rotated (they describe symmetric or center-anchored areas).
 */
export function resolveAffordances(geo, pose) {
  if (!isPose(pose)) throw new Error("invalid pose");
  return geo.affordances.map((a) => ({
    kind: a.kind,
    id: a.id,
    role: a.role,
    accepts: a.accepts,
    directional: !!a.directional,
    notes: a.notes,
    worldGeometry: resolveLocalGeometry(a.localGeometry, pose, !!a.directional),
  }));
}

/**
 * One-shot resolver: returns body tiles, ports, and affordances under a pose.
 */
export function resolveEntity(geo, pose) {
  if (!isPose(pose)) throw new Error("invalid pose");
  return {
    prototype: geo.prototype,
    pose,
    // collisionBox in local (north-canonical) frame; checkBBoxOverlap rotates+translates it
    collisionBox: geo.collisionBox,
    bodyTiles: entityFootprintTiles(geo.tileWidth, geo.tileHeight, pose),
    ports: resolvePorts(geo, pose),
    affordances: resolveAffordances(geo, pose),
  };
}
