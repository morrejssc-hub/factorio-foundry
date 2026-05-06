// Geometry Layer v1 — tile occupancy.
// An OccupancySet stores the tile coordinates an entity (or group of entities)
// covers, keyed as "x,y" strings for O(1) collision tests. World tile coords
// are integers; floats are rejected.

import { rotatedTileSize, centerToTopLeft } from "./transform.js";

const KEY_SEP = ",";

function key(x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw new Error(`tile coords must be integers, got ${x},${y}`);
  }
  return `${x}${KEY_SEP}${y}`;
}

function parseKey(k) {
  const [x, y] = k.split(KEY_SEP);
  return { x: Number(x), y: Number(y) };
}

/**
 * World tiles covered by an entity at the given pose. Center may be
 * half-integer for odd-sided entities — the footprint is anchored from the
 * top-left tile (always integer).
 */
export function entityFootprintTiles(width, height, pose) {
  const { width: w, height: h } = rotatedTileSize(width, height, pose.direction);
  const tl = centerToTopLeft(pose.center, width, height, pose.direction);
  const tiles = [];
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      tiles.push({ x: tl.x + dx, y: tl.y + dy });
    }
  }
  return tiles;
}

export class OccupancySet {
  constructor() {
    this._set = new Set();
  }

  size() { return this._set.size; }

  has(x, y) { return this._set.has(key(x, y)); }

  add(x, y) {
    const k = key(x, y);
    if (this._set.has(k)) return false;
    this._set.add(k);
    return true;
  }

  delete(x, y) { return this._set.delete(key(x, y)); }

  /**
   * Try to add all tiles atomically. Returns { ok, conflicts } — on conflict,
   * no tile is added.
   */
  addAll(tiles) {
    const conflicts = [];
    for (const t of tiles) {
      if (this._set.has(key(t.x, t.y))) conflicts.push({ x: t.x, y: t.y });
    }
    if (conflicts.length > 0) return { ok: false, conflicts };
    for (const t of tiles) this._set.add(key(t.x, t.y));
    return { ok: true, conflicts: [] };
  }

  /** Test whether `tiles` would conflict, without mutating. */
  wouldConflict(tiles) {
    const conflicts = [];
    for (const t of tiles) {
      if (this._set.has(key(t.x, t.y))) conflicts.push({ x: t.x, y: t.y });
    }
    return conflicts;
  }

  removeAll(tiles) {
    let n = 0;
    for (const t of tiles) if (this._set.delete(key(t.x, t.y))) n++;
    return n;
  }

  list() {
    return [...this._set].map(parseKey);
  }
}
