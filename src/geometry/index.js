// Geometry Layer v1 — module entry.
export {
  DIRECTION,
  DIRECTION_NAMES,
  ORTHOGONAL_DIRECTIONS,
  AFFORDANCE_KINDS,
  PORT_KINDS,
  isOrthogonalDirection,
  directionName,
  directionFromName,
  validateEntityGeometry,
  validateRawPrototype,
} from "./schema.js";

export {
  SUPPORTED_ENTITIES,
  buildFromRaw,
  buildFromRawMap,
  loadEntityGeometries,
} from "./entity_adapters.js";

export {
  rotateVec2,
  rotateBBox,
  translateVec2,
  translateBBox,
  rotatedTileSize,
  topLeftToCenter,
  centerToTopLeft,
  isPose,
} from "./transform.js";

export {
  OccupancySet,
  entityFootprintTiles,
} from "./occupancy.js";

export {
  resolvePorts,
  resolveAffordances,
  resolveEntity,
} from "./affordance_resolve.js";

export {
  checkSnapCompatibility,
  solveSnapPose,
} from "./snap_rules.js";

export {
  solveLayout,
} from "./solve_layout.js";

export {
  findExposedAffordances,
  checkBBoxOverlap,
} from "./static_validator.js";

export {
  routeBelt,
} from "./belt_routing.js";
