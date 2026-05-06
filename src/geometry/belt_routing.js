// Phase 7.1 — A* Belt Routing
// 目标: route_belt(from, to, occupied, allow_underground) → belt path entities

import { DIRECTION } from "./schema.js";

/**
 * @typedef {object} BeltPathNode
 * @property {{x: number, y: number}} tile
 * @property {number} direction - DIRECTION constant
 * @property {boolean} [underground]
 * @property {number} [undergroundSpan]
 * @property {number} cost
 */

/**
 * @typedef {object} BeltEntity
 * @property {"transport-belt"|"underground-belt"} prototype
 * @property {{center: {x: number, y: number}, direction: number}} pose
 * @property {"input"|"output"} [type] - for underground belt
 */

/**
 * @typedef {object} BeltRouteResult
 * @property {boolean} ok
 * @property {BeltPathNode[]} [path]
 * @property {BeltEntity[]} [entities]
 * @property {number} [length]
 * @property {string} [code]
 * @property {string} [reason]
 */

/**
 * @typedef {object} RouteConfig
 * @property {number} maxIterations
 * @property {boolean} allowUnderground
 * @property {number} undergroundMaxDistance
 * @property {number} undergroundCostMultiplier
 */

const DEFAULT_CONFIG = {
  maxIterations: 1000,
  allowUnderground: false,
  undergroundMaxDistance: 4,
  undergroundCostMultiplier: 2,
};

// Direction unit vectors
const DIR_VECTOR = {
  [DIRECTION.NORTH]: { x: 0, y: -1 },
  [DIRECTION.EAST]: { x: 1, y: 0 },
  [DIRECTION.SOUTH]: { x: 0, y: 1 },
  [DIRECTION.WEST]: { x: -1, y: 0 },
};

/**
 * Manhattan distance heuristic
 * @param {{x: number, y: number}} a
 * @param {{x: number, y: number}} b
 * @returns {number}
 */
function manhattanDistance(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Check if tile is occupied
 * @param {{x: number, y: number}} tile
 * @param {Set<string>} occupied
 * @returns {boolean}
 */
function isOccupied(tile, occupied) {
  return occupied.has(`${tile.x},${tile.y}`);
}

/**
 * Get neighbor tiles for A* expansion
 * @param {BeltPathNode} current
 * @param {{x: number, y: number}} goal
 * @param {Set<string>} occupied
 * @param {RouteConfig} config
 * @returns {BeltPathNode[]}
 */
function getNeighbors(current, goal, occupied, config) {
  const neighbors = [];
  const currentTile = current.tile;

  // Standard 4-direction expansion
  for (const dirValue of [DIRECTION.NORTH, DIRECTION.EAST, DIRECTION.SOUTH, DIRECTION.WEST]) {
    const vec = DIR_VECTOR[dirValue];
    const nextTile = { x: currentTile.x + vec.x, y: currentTile.y + vec.y };

    if (!isOccupied(nextTile, occupied)) {
      neighbors.push({
        tile: nextTile,
        direction: dirValue,
        cost: current.cost + 1,
      });
    }
  }

  // Underground belt expansion (if allowed)
  if (config.allowUnderground && !current.underground) {
    for (const dirValue of [DIRECTION.NORTH, DIRECTION.EAST, DIRECTION.SOUTH, DIRECTION.WEST]) {
      const vec = DIR_VECTOR[dirValue];

      for (let span = 2; span <= config.undergroundMaxDistance; span++) {
        const exitTile = {
          x: currentTile.x + vec.x * (span + 1),
          y: currentTile.y + vec.y * (span + 1),
        };

        if (!isOccupied(exitTile, occupied)) {
          const currentDist = manhattanDistance(currentTile, goal);
          const exitDist = manhattanDistance(exitTile, goal);

          if (exitDist < currentDist) {
            // Check intermediate tiles are blocked
            let blocked = false;
            for (let i = 1; i <= span; i++) {
              const midTile = {
                x: currentTile.x + vec.x * i,
                y: currentTile.y + vec.y * i,
              };
              if (isOccupied(midTile, occupied)) {
                blocked = true;
                break;
              }
            }

            if (blocked) {
              neighbors.push({
                tile: exitTile,
                direction: dirValue,
                underground: true,
                undergroundSpan: span,
                cost: current.cost + span * config.undergroundCostMultiplier,
              });
            }
          }
        }
      }
    }
  }

  return neighbors;
}

/**
 * Generate belt entities from path
 * Handles underground belt pairs when path has jumps > 1 tile
 * @param {BeltPathNode[]} path
 * @param {number} [finalDirection]
 * @returns {BeltEntity[]}
 */
function generateBeltEntities(path, finalDirection) {
  const entities = [];

  for (let i = 0; i < path.length; i++) {
    const node = path[i];
    const prevNode = i > 0 ? path[i - 1] : null;

    // Check if there's a jump from previous tile (indicates underground)
    if (prevNode) {
      const dx = node.tile.x - prevNode.tile.x;
      const dy = node.tile.y - prevNode.tile.y;
      const jumpDistance = Math.abs(dx) + Math.abs(dy);

      if (jumpDistance > 1 && !prevNode.underground) {
        // This is an underground span entry point
        // prevNode is input, node is output
        let entryDir = prevNode.direction;
        // Determine direction based on movement
        if (dx > 0) entryDir = DIRECTION.EAST;
        else if (dx < 0) entryDir = DIRECTION.WEST;
        else if (dy > 0) entryDir = DIRECTION.SOUTH;
        else if (dy < 0) entryDir = DIRECTION.NORTH;

        // Add input underground belt at previous tile
        entities.push({
          prototype: "underground-belt",
          pose: {
            center: { x: prevNode.tile.x + 0.5, y: prevNode.tile.y + 0.5 },
            direction: entryDir,
          },
          type: "input",
        });

        // Add output underground belt at current tile
        entities.push({
          prototype: "underground-belt",
          pose: {
            center: { x: node.tile.x + 0.5, y: node.tile.y + 0.5 },
            direction: entryDir,
          },
          type: "output",
        });
        continue;
      }
    }

    // Normal transport belt
    let beltDirection = node.direction;
    if (i < path.length - 1) {
      const next = path[i + 1];
      const dx = next.tile.x - node.tile.x;
      const dy = next.tile.y - node.tile.y;

      // If jump > 1, direction is toward the exit
      if (Math.abs(dx) + Math.abs(dy) > 1) {
        if (dx > 0) beltDirection = DIRECTION.EAST;
        else if (dx < 0) beltDirection = DIRECTION.WEST;
        else if (dy > 0) beltDirection = DIRECTION.SOUTH;
        else if (dy < 0) beltDirection = DIRECTION.NORTH;
      } else {
        if (dx > 0) beltDirection = DIRECTION.EAST;
        else if (dx < 0) beltDirection = DIRECTION.WEST;
        else if (dy > 0) beltDirection = DIRECTION.SOUTH;
        else if (dy < 0) beltDirection = DIRECTION.NORTH;
      }
    } else if (finalDirection !== undefined) {
      beltDirection = finalDirection;
    }

    // Skip if this node was already handled as underground output
    if (prevNode && Math.abs(node.tile.x - prevNode.tile.x) + Math.abs(node.tile.y - prevNode.tile.y) > 1) {
      continue;
    }

    const center = { x: node.tile.x + 0.5, y: node.tile.y + 0.5 };
    entities.push({
      prototype: "transport-belt",
      pose: { center, direction: beltDirection },
    });
  }

  return entities;
}

/**
 * A* belt routing - find path from one tile to another
 *
 * @param {{x: number, y: number, direction?: number}} from - start position
 * @param {{x: number, y: number, direction?: number}} to - goal position
 * @param {Array<{x: number, y: number}>|Set<string>} occupiedTiles - blocked tiles
 * @param {Partial<RouteConfig>} [config] - routing options
 * @returns {BeltRouteResult}
 */
export function routeBelt(from, to, occupiedTiles, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Convert occupied to Set
  const occupied = occupiedTiles instanceof Set
    ? occupiedTiles
    : new Set(occupiedTiles.map(t => `${Math.floor(t.x)},${Math.floor(t.y)}`));

  // Start and goal (tile coordinates)
  const start = { x: Math.floor(from.x), y: Math.floor(from.y) };
  const goal = { x: Math.floor(to.x), y: Math.floor(to.y) };

  // Remove endpoints from occupied
  occupied.delete(`${start.x},${start.y}`);
  occupied.delete(`${goal.x},${goal.y}`);

  // A* search
  const openSet = [{
    tile: start,
    direction: from.direction ?? DIRECTION.EAST,
    cost: 0,
  }];
  const closedSet = new Set();
  const cameFrom = new Map();
  const gScore = new Map();
  gScore.set(`${start.x},${start.y}`, 0);

  let iterations = 0;

  while (openSet.length > 0 && iterations < cfg.maxIterations) {
    iterations++;

    // Sort by f = g + h
    openSet.sort((a, b) =>
      (a.cost + manhattanDistance(a.tile, goal)) -
      (b.cost + manhattanDistance(b.tile, goal))
    );
    const current = openSet.shift();
    const currentKey = `${current.tile.x},${current.tile.y}`;

    // Reached goal?
    if (current.tile.x === goal.x && current.tile.y === goal.y) {
      // Reconstruct path
      const path = [];
      let node = current;

      while (node) {
        path.unshift(node);
        const key = `${node.tile.x},${node.tile.y}`;
        node = cameFrom.get(key);
      }

      const entities = generateBeltEntities(path, to.direction);

      return { ok: true, path, entities, length: path.length };
    }

    closedSet.add(currentKey);

    // Expand neighbors
    const neighbors = getNeighbors(current, goal, occupied, cfg);

    for (const neighbor of neighbors) {
      const key = `${neighbor.tile.x},${neighbor.tile.y}`;

      if (closedSet.has(key)) continue;

      const stepCost = neighbor.underground
        ? (neighbor.undergroundSpan ?? 2) * cfg.undergroundCostMultiplier
        : 1;
      const tentativeG = current.cost + stepCost;

      const existingG = gScore.get(key);
      if (existingG === undefined || tentativeG < existingG) {
        cameFrom.set(key, current);
        gScore.set(key, tentativeG);
        neighbor.cost = tentativeG;

        const inOpen = openSet.findIndex(n =>
          n.tile.x === neighbor.tile.x && n.tile.y === neighbor.tile.y
        );
        if (inOpen === -1) {
          openSet.push(neighbor);
        } else {
          openSet[inOpen] = neighbor; // update with better cost
        }
      }
    }
  }

  // No path found
  return {
    ok: false,
    code: "no_path",
    reason: `No path found from (${start.x},${start.y}) to (${goal.x},${goal.y}) after ${iterations} iterations`,
  };
}