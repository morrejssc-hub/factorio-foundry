// Geometry Layer v1 — chain DSL layout solver.
// Accepts a chain specification and produces a fully resolved placement plan
// by iteratively solving snap rules and checking occupancy / bbox overlap.

import { DIRECTION, directionName } from "./schema.js";
import { resolveEntity } from "./affordance_resolve.js";
import { OccupancySet, entityFootprintTiles } from "./occupancy.js";
import { checkSnapCompatibility, solveSnapPose } from "./snap_rules.js";
import { findExposedAffordances, checkBBoxOverlap } from "./static_validator.js";

/**
 * Solve a chain DSL into a placement plan.
 * @param {object} chain — DSL input with { origin, steps[] }
 * @param {Record<string, object>} geometries — prototype → EntityGeometry
 * @param {function|null} oracle — optional async (entities) => { results[] } callback
 * @returns {object} — success or structured error
 */
export async function solveLayout(chain, geometries, oracle = null) {
  // --- validate origin ---
  if (!chain?.origin) {
    return { ok: false, code: "origin_missing", reason: "chain.origin required" };
  }
  if (!chain.origin.pose) {
    return { ok: false, code: "origin_missing", reason: "origin.pose required" };
  }

  const originGeo = geometries[chain.origin.prototype];
  if (!originGeo) {
    return { ok: false, code: "unknown_prototype", reason: `unknown prototype: ${chain.origin.prototype}` };
  }

  const originResolved = resolveEntity(originGeo, chain.origin.pose);
  const resolvedEntities = [originResolved];
  const occupancy = new OccupancySet();
  occupancy.addAll(originResolved.bodyTiles);

  // Track which affordances are consumed by snaps: { entity_index, affordance_id }
  const consumedRefs = [];

  // --- iterate steps ---
  for (let i = 0; i < chain.steps.length; i++) {
    const step = chain.steps[i];
    const stepNum = i + 1; // 1-indexed ref

    // resolve upstream ref
    const upIdx = resolveRefIndex(step.from.ref, stepNum);
    if (upIdx < 0) {
      return { ok: false, code: "unknown_ref", step: i, reason: `ref '${step.from.ref}' not found` };
    }
    const upResolved = resolvedEntities[upIdx];
    const upAff = upResolved.affordances.find((a) => a.id === step.from.affordance);
    if (!upAff) {
      return { ok: false, code: "unknown_affordance", step: i, reason: `upstream affordance '${step.from.affordance}'` };
    }

    // get downstream EntityGeometry
    const downGeo = geometries[step.to.prototype];
    if (!downGeo) {
      return { ok: false, code: "unknown_prototype", step: i, reason: `unknown prototype: ${step.to.prototype}` };
    }

    const downAff = downGeo.affordances.find((a) => a.id === step.to.affordance);
    if (!downAff) {
      return { ok: false, code: "unknown_affordance", step: i, reason: `downstream affordance '${step.to.affordance}'` };
    }

    // compatibility check
    const compat = checkSnapCompatibility(upAff, downAff, step.rule);
    if (!compat.ok) {
      return { ok: false, code: compat.code, step: i, reason: compat.reason, suggestions: [] };
    }

    // solve snap pose
    const snapOpts = {};
    if (step.to.direction !== undefined) snapOpts.pinDirection = step.to.direction;
    if (step.to.tile) snapOpts.resourceTile = step.to.tile;

    const snapResult = solveSnapPose(upResolved, step.from.affordance, downGeo, step.to.affordance, step.rule, snapOpts);
    if (!snapResult.ok) {
      return {
        ok: false, code: snapResult.code, step: i,
        candidate_pose: snapResult.candidates?.[0],
        reason: snapResult.reason,
        suggestions: generateSuggestions(downGeo, snapResult.candidates || [], upResolved),
      };
    }

    // filter candidates by occupancy
    const candidatesWithTiles = snapResult.candidates.map((c) => ({
      ...c,
      tiles: entityFootprintTiles(downGeo.tileWidth, downGeo.tileHeight, c),
    }));

    const validCandidates = candidatesWithTiles.filter((c) =>
      occupancy.wouldConflict(c.tiles).length === 0,
    );

    if (validCandidates.length === 0) {
      const hasPin = snapOpts.pinDirection !== undefined;
      const blocking = findBlockingEntities(candidatesWithTiles, resolvedEntities);
      return {
        ok: false,
        code: hasPin ? "incompatible_snap" : "occupied",
        step: i,
        candidate_pose: candidatesWithTiles[0],
        reason: hasPin
          ? `pinned direction ${directionName(snapOpts.pinDirection)} produces only overlapping candidates`
          : "all candidates overlap existing entities",
        blocking_entities: blocking,
        suggestions: generateSuggestions(downGeo, candidatesWithTiles, upResolved),
      };
    }

    // bbox overlap check on valid candidates
    let chosen = null;
    for (const cand of validCandidates) {
      const tempResolved = resolveEntity(downGeo, cand);
      const allResolved = [...resolvedEntities, tempResolved];
      const bboxConflicts = checkBBoxOverlap(allResolved);
      if (bboxConflicts.length === 0) {
        chosen = cand;
        break;
      }
    }

    if (!chosen) {
      return {
        ok: false, code: "bbox_overlap", step: i,
        reason: "all candidates have collision box overlap",
        suggestions: generateSuggestions(downGeo, validCandidates, upResolved),
      };
    }

    // commit (strip the internal `tiles` field — it must not leak into the pose)
    const chosenPose = { center: chosen.center, direction: chosen.direction };
    occupancy.addAll(chosen.tiles);
    const resolved = resolveEntity(downGeo, chosenPose);
    consumedRefs.push(
      { entity_index: upIdx, affordance_id: step.from.affordance },
      { entity_index: resolvedEntities.length, affordance_id: step.to.affordance },
    );
    resolvedEntities.push(resolved);
  }

  // --- build result ---
  const footprint = occupancy.list();
  const exposedAffordances = findExposedAffordances(resolvedEntities, consumedRefs);
  const entities = resolvedEntities.map((e, i) => ({
    prototype: e.prototype,
    pose: e.pose,
    ref: i === 0 ? "origin" : `$${i}`,
  }));

  // --- optional engine oracle ---
  if (oracle) {
    const oracleInput = resolvedEntities.map((e) => ({
      name: e.prototype,
      position: e.pose.center,
      direction: e.pose.direction,
    }));
    const oracleResult = await oracle(oracleInput);
    const failed = (oracleResult.results || []).filter((r) => !r.canPlace);
    if (failed.length > 0) {
      return {
        ok: false,
        code: "engine_rejected",
        step: -1,
        reason: `engine oracle rejected ${failed.length} placement(s)`,
        blocking_entities: failed.map((r) => r.blockingEntities || []).flat(),
        oracle_results: oracleResult.results,
        suggestions: failed.flatMap((r) =>
          (r.blockingEntities || []).map((b) => ({
            kind: "blocked_by",
            entity: b.name,
            at: b.position,
          })),
        ),
      };
    }
  }

  return {
    ok: true,
    entities,
    footprint,
    exposed_affordances: exposedAffordances,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Convert a ref string to an index in resolvedEntities. Returns -1 on failure. */
function resolveRefIndex(ref, currentStepNum) {
  if (ref === "origin") return 0;
  const m = String(ref).match(/^\$(\d+)$/);
  if (m) {
    const idx = parseInt(m[1], 10);
    if (idx >= 1 && idx < currentStepNum) return idx;
  }
  return -1;
}

function directionUnitVec(dir) {
  switch (dir) {
    case DIRECTION.NORTH: return { x: 0, y: -1 };
    case DIRECTION.EAST:  return { x: 1, y: 0 };
    case DIRECTION.SOUTH: return { x: 0, y: 1 };
    case DIRECTION.WEST:  return { x: -1, y: 0 };
    default: return { x: 0, y: 0 };
  }
}

function generateSuggestions(downGeo, attemptedCandidates, upstreamResolved) {
  const suggestions = [];
  const attemptedDirs = new Set(attemptedCandidates.map((c) => c.direction));
  for (const dir of downGeo.placement.legalDirections) {
    if (!attemptedDirs.has(dir)) {
      suggestions.push({ kind: "try_direction", direction: dir });
    }
  }
  if (upstreamResolved?.pose) {
    const delta = directionUnitVec(upstreamResolved.pose.direction);
    suggestions.push({ kind: "translate_chain", delta });
  }
  return suggestions;
}

function findBlockingEntities(candidatesWithTiles, resolvedEntities) {
  const blockingSet = new Set();
  for (const cand of candidatesWithTiles) {
    for (const tile of cand.tiles) {
      for (let i = 0; i < resolvedEntities.length; i++) {
        if (resolvedEntities[i].bodyTiles.some(
          (t) => t.x === tile.x && t.y === tile.y,
        )) {
          blockingSet.add(i);
        }
      }
    }
  }
  return [...blockingSet].sort((a, b) => a - b);
}
