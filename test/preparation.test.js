import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePlan } from "../src/runner/design.js";

const basePlan = {
  epoch: "e_test",
  placements: [
    { id: "p0", module: "coal-burner-cell", anchor: { x: 0, y: 0 }, direction: "north" },
  ],
  connections: [],
  expected_throughput: 0.18,
  scaling_note: "x",
};

test("plan without preparation validates clean (defaults to [])", () => {
  const r = validatePlan({ ...basePlan }, ["coal-burner-cell"]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.effective.preparation, []);
});

test("plan with empty preparation validates clean", () => {
  const r = validatePlan({ ...basePlan, preparation: [] }, ["coal-burner-cell"]);
  assert.deepEqual(r.errors, []);
});

test("preparation deconstruct passes", () => {
  const r = validatePlan({
    ...basePlan,
    preparation: [
      { kind: "deconstruct", position: { x: -50, y: -85 }, entity: "burner-mining-drill" },
      { kind: "deconstruct", position: { x: -49, y: -85 } },
    ],
  }, ["coal-burner-cell"]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.effective.preparation.length, 2);
});

test("preparation rejects unknown kind", () => {
  const r = validatePlan({
    ...basePlan,
    preparation: [{ kind: "upgrade", position: { x: 0, y: 0 } }],
  }, ["coal-burner-cell"]);
  assert.match(r.errors.join(";"), /unsupported/);
});

test("preparation rejects bad position", () => {
  const r = validatePlan({
    ...basePlan,
    preparation: [{ kind: "deconstruct", position: { x: "five", y: 0 } }],
  }, ["coal-burner-cell"]);
  assert.match(r.errors.join(";"), /position/);
});

test("preparation rejects empty entity filter when present", () => {
  const r = validatePlan({
    ...basePlan,
    preparation: [{ kind: "deconstruct", position: { x: 0, y: 0 }, entity: "" }],
  }, ["coal-burner-cell"]);
  assert.match(r.errors.join(";"), /entity must be a non-empty string/);
});

test("preparation rejects non-array", () => {
  const r = validatePlan({
    ...basePlan,
    preparation: { kind: "deconstruct", position: { x: 0, y: 0 } },
  }, ["coal-burner-cell"]);
  assert.match(r.errors.join(";"), /must be an array/);
});
