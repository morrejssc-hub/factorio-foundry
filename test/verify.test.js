// verify.test.js — unit tests for the verify harness logic.
// Only the JS-pure parts are testable here (coord computation, manifest
// derivation, ticker logic). Live Factorio tests happen via the e1 chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rotateRelPos, resolvePortWorldPos } from "../src/runner/execute.js";

// ============================================================
// rotateRelPos — port rotation by direction
// ============================================================

test("rotateRelPos: north is identity", () => {
  const r = rotateRelPos(3, 5, "north");
  assert.deepEqual(r, { x: 3, y: 5 });
});

test("rotateRelPos: east = 90° CW", () => {
  const r = rotateRelPos(3, 5, "east");
  assert.deepEqual(r, { x: -5, y: 3 });
});

test("rotateRelPos: south = 180°", () => {
  const r = rotateRelPos(3, 5, "south");
  assert.deepEqual(r, { x: -3, y: -5 });
});

test("rotateRelPos: west = 270° CW", () => {
  const r = rotateRelPos(3, 5, "west");
  assert.deepEqual(r, { x: 5, y: -3 });
});

test("rotateRelPos: defaults to north", () => {
  const r = rotateRelPos(1, 2);
  assert.deepEqual(r, { x: 1, y: 2 });
});

test("rotateRelPos: fractional coords preserved", () => {
  const r = rotateRelPos(2.5, 0.5, "east");
  assert.deepEqual(r, { x: -0.5, y: 2.5 });
});

// ============================================================
// resolvePortWorldPos — world position computation
// ============================================================

function fakeModule(name, opts = {}) {
  return {
    id: name,
    version: 1,
    inputs: opts.inputs || [],
    outputs: opts.outputs || [],
    footprint: opts.footprint || { min: [-1, -1], max: [1, 1] },
    realization: { blueprint: `lib/blueprints/${name}.json` },
  };
}

test("resolvePortWorldPos: north-facing module, output port", () => {
  const mod = fakeModule("m", {
    outputs: [{ name: "coal_belt", side: "south", rel_pos: [2.5, 0.5], item: "coal", kind: "belt" }],
  });
  const placement = { module: "m", anchor: { x: 0, y: 0 }, direction: "north" };
  const pos = resolvePortWorldPos(placement, mod, "coal_belt");
  assert.deepEqual(pos, { x: 2.5, y: 0.5 });
});

test("resolvePortWorldPos: east-facing module, output port", () => {
  const mod = fakeModule("m", {
    outputs: [{ name: "coal_belt", side: "south", rel_pos: [2.5, 0.5], item: "coal", kind: "belt" }],
  });
  const placement = { module: "m", anchor: { x: 10, y: 10 }, direction: "east" };
  const pos = resolvePortWorldPos(placement, mod, "coal_belt");
  // rotated: (-0.5, 2.5), anchor: (10, 10) → (9.5, 12.5)
  assert.deepEqual(pos, { x: 9.5, y: 12.5 });
});

test("resolvePortWorldPos: unknown port returns null", () => {
  const mod = fakeModule("m", {
    outputs: [{ name: "coal_belt", side: "south", rel_pos: [1, 0], item: "coal", kind: "belt" }],
  });
  const placement = { module: "m", anchor: { x: 0, y: 0 }, direction: "north" };
  assert.strictEqual(resolvePortWorldPos(placement, mod, "nonexistent"), null);
});

test("resolvePortWorldPos: input port resolved", () => {
  const mod = fakeModule("m", {
    inputs: [{ name: "ore_in", side: "north", rel_pos: [0, -1], item: "iron-ore", kind: "belt" }],
  });
  const placement = { module: "m", anchor: { x: 5, y: 5 }, direction: "north" };
  const pos = resolvePortWorldPos(placement, mod, "ore_in");
  assert.deepEqual(pos, { x: 5, y: 4 });
});
