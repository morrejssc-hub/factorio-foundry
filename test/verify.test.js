// verify.test.js — unit tests for the verify harness logic.
// Only the JS-pure parts are testable here (coord computation, manifest
// derivation, ticker logic). Live Factorio tests happen via the e1 chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rotateRelPos, resolvePortWorldPos } from "../src/runner/execute.js";
import { runVerifyGate } from "../src/runner/verify.js";

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
    meters: opts.meters || [],
    footprint: opts.footprint || { min: [-1, -1], max: [1, 1] },
    realization: { blueprint: `lib/blueprints/${name}.json` },
    _staged: opts._staged,
    _stagedBlueprintPath: opts._stagedBlueprintPath,
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

test("runVerifyGate places candidate and harness without rollback/export", async () => {
  const calls = [];
  const outDir = await mkdtemp(join(tmpdir(), "foundry-verify-gate-"));
  const blueprintPath = join(outDir, "m.json");
  await writeFile(blueprintPath, JSON.stringify({ entities: [] }), "utf8");
  const controller = {
    config: { rootDir: process.cwd() },
    action: async (name, params = {}) => {
      calls.push(["action", name]);
      if (name === "execute_blueprint") return { ok: true, requiredItems: {} };
      if (name === "place_harness") {
        return { placed: 1, manifest: [{ role: "input", item: "coal", chest_pos: { x: 1, y: 1 } }] };
      }
      if (name === "harness_tick") return { ticked: 1 };
      throw new Error(`unexpected action ${name}`);
    },
    advanceTicks: async (ticks) => calls.push(["advanceTicks", ticks]),
    runLuaScript: async () => {
      calls.push(["runLuaScript"]);
      return { ok: true, tick: calls.filter((c) => c[0] === "runLuaScript").length * 60, measured: 1 };
    },
    countEntities: async () => 3,
    countEntitiesByName: async () => 0,
    snapshot: async () => calls.push(["snapshot"]),
    rollback: async () => calls.push(["rollback"]),
    exportZip: async () => calls.push(["exportZip"]),
  };

  const plan = {
    placements: [{ id: "p0", module: "m", anchor: { x: 0, y: 0 }, direction: "north" }],
    connections: [],
    expected_throughput: 1,
    scaling_note: "test",
  };
  const modules = new Map([["m", fakeModule("m", {
    _staged: true,
    _stagedBlueprintPath: blueprintPath,
    inputs: [{ name: "coal_in", kind: "belt", side: "north", rel_pos: [0, -1], item: "coal" }],
    outputs: [{ name: "coal_out", kind: "belt", side: "south", rel_pos: [0, 1], item: "coal" }],
    meters: [{
      id: "coal",
      script: "lib/meters/throughput-window.lua",
      aggregate: "rate_from_cumulative",
      item: "coal",
      params: { item: "coal", window_ticks: 60 },
    }],
  })]]);

  const result = await runVerifyGate({
    controller,
    epoch: { target_metric: { module: "m", meter_id: "coal", threshold: 0 } },
    plan,
    modules,
    outDir,
  });

  assert.equal(result.verdict.pass, true);
  assert.equal(calls.some((c) => c[0] === "rollback"), false);
  assert.equal(calls.some((c) => c[0] === "exportZip"), false);
  assert.equal(calls.some((c) => c[0] === "snapshot"), false);
  assert.equal(calls.some((c) => c[0] === "action" && c[1] === "place_harness"), true);
});
