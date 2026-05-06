// Geometry Layer v1 — static validators.
// Pure functions that validate a set of resolved entities without engine calls.

import { rotateBBox, translateBBox } from "./transform.js";

const EPSILON = 1e-9;

/**
 * List affordances not consumed by any snap in the chain.
 * @param {Array<object>} entitiesResolved — array of resolveEntity results
 * @param {Array<{entity_index:number,affordance_id:string}>} consumedRefs
 * @returns {Array<{entity_index:number, id:string, kind:string, role:string, world:object}>}
 */
export function findExposedAffordances(entitiesResolved, consumedRefs = []) {
  const consumedSet = new Set(consumedRefs.map((r) => `${r.entity_index}:${r.affordance_id}`));
  const exposed = [];
  for (let i = 0; i < entitiesResolved.length; i++) {
    for (const aff of entitiesResolved[i].affordances) {
      if (!consumedSet.has(`${i}:${aff.id}`)) {
        exposed.push({
          entity_index: i,
          id: aff.id,
          kind: aff.kind,
          role: aff.role,
          world: aff.worldGeometry,
        });
      }
    }
  }
  return exposed;
}

/**
 * Pairwise collision-box overlap in world space.
 * Returns an array of conflict records for each overlapping pair.
 * @param {Array<object>} entitiesResolved
 * @returns {Array<{entity_a:number, entity_b:number, bbox_a:object, bbox_b:object}>}
 */
export function checkBBoxOverlap(entitiesResolved) {
  const conflicts = [];
  for (let i = 0; i < entitiesResolved.length; i++) {
    const aBox = translateBBox(
      rotateBBox(entitiesResolved[i].collisionBox, entitiesResolved[i].pose.direction),
      entitiesResolved[i].pose.center,
    );
    for (let j = i + 1; j < entitiesResolved.length; j++) {
      const bBox = translateBBox(
        rotateBBox(entitiesResolved[j].collisionBox, entitiesResolved[j].pose.direction),
        entitiesResolved[j].pose.center,
      );
      if (bboxesOverlap(aBox, bBox)) {
        conflicts.push({ entity_a: i, entity_b: j, bbox_a: aBox, bbox_b: bBox });
      }
    }
  }
  return conflicts;
}

function bboxesOverlap(a, b) {
  return a.rightBottom.x > b.leftTop.x + EPSILON
      && b.rightBottom.x > a.leftTop.x + EPSILON
      && a.rightBottom.y > b.leftTop.y + EPSILON
      && b.rightBottom.y > a.leftTop.y + EPSILON;
}
