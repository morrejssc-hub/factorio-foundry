// Geometry Layer v1 — coordinate transforms.
// All rotations are around (0,0) in the entity-center frame (north canonical).
// Translation to world is the caller's job (add pose.center afterward).
//
// Direction encoding (Factorio 2.0): N=0, E=4, S=8, W=12. East = clockwise 90°.
// In screen coords (y grows down), a CW 90° rotation maps (x,y) → (-y, x).

import { DIRECTION, isOrthogonalDirection } from "./schema.js";

/** @typedef {import("./schema.js").Vec2} Vec2 */
/** @typedef {import("./schema.js").BBox} BBox */
/** @typedef {import("./schema.js").Direction} Direction */
/** @typedef {{ center: Vec2, direction: Direction }} Pose */

function quartersFor(direction) {
  switch (direction) {
    case DIRECTION.NORTH: return 0;
    case DIRECTION.EAST:  return 1;
    case DIRECTION.SOUTH: return 2;
    case DIRECTION.WEST:  return 3;
    default: throw new Error(`non-orthogonal direction: ${direction}`);
  }
}

export function rotateVec2(v, direction) {
  let { x, y } = v;
  const q = quartersFor(direction);
  for (let i = 0; i < q; i++) {
    const nx = -y, ny = x;
    x = nx; y = ny;
  }
  return { x: x === 0 ? 0 : x, y: y === 0 ? 0 : y };
}

export function rotateBBox(box, direction) {
  const a = rotateVec2(box.leftTop, direction);
  const b = rotateVec2(box.rightBottom, direction);
  return {
    leftTop:     { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
    rightBottom: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
  };
}

export function translateVec2(v, by) {
  return { x: v.x + by.x, y: v.y + by.y };
}

export function translateBBox(box, by) {
  return {
    leftTop:     translateVec2(box.leftTop, by),
    rightBottom: translateVec2(box.rightBottom, by),
  };
}

/**
 * Rotated tile dimensions for an entity at the given direction.
 * For east/west, width and height swap.
 */
export function rotatedTileSize(width, height, direction) {
  const q = quartersFor(direction);
  return q % 2 === 0 ? { width, height } : { width: height, height: width };
}

/**
 * Convert top-left tile of an entity's footprint to entity-center world coords.
 * Uses rotated dimensions for the given direction.
 *   center = topLeft + (w/2, h/2)
 */
export function topLeftToCenter(topLeft, width, height, direction) {
  const { width: w, height: h } = rotatedTileSize(width, height, direction);
  return { x: topLeft.x + w / 2, y: topLeft.y + h / 2 };
}

/**
 * Convert entity-center to top-left tile coords. Center may be half-integer
 * (odd-side entities) or integer (even-side); the resulting tile is the
 * integer floor of the bounding box's upper-left corner.
 */
export function centerToTopLeft(center, width, height, direction) {
  const { width: w, height: h } = rotatedTileSize(width, height, direction);
  return {
    x: Math.floor(center.x - w / 2),
    y: Math.floor(center.y - h / 2),
  };
}

export function isPose(pose) {
  return pose
    && pose.center && Number.isFinite(pose.center.x) && Number.isFinite(pose.center.y)
    && isOrthogonalDirection(pose.direction);
}
