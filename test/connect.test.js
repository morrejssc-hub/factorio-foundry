// connect.test.js — unit tests for src/runner/connect.js
//
// The synthesizer is pure JS; no Factorio. Test cases cover the seven
// decision kinds plus the routing arithmetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { synthesizeConnections } from "../src/runner/connect.js";

// Modules used across tests. rel_pos and footprint are realistic for the
// migrated lib modules so resolvePortWorldPos yields sane Manhattan
// distances.
function ironSmeltLine() {
  return {
    id: "iron-smelt-line",
    version: 3,
    inputs: [
      { name: "coal_in", side: "south", rel_pos: [-0.5, 2.5], throughput: 0.36, item: "coal", kind: "belt" },
    ],
    outputs: [
      { name: "iron_plate_belt", side: "east", rel_pos: [6.5, 0.5], throughput: 0.20, item: "iron-plate", kind: "belt" },
    ],
    footprint: { min: [-1, -1], max: [7, 3] },
    realization: { blueprint: "lib/blueprints/iron-smelt-line.json" },
  };
}

function gearProduction() {
  return {
    id: "gear-production",
    version: 2,
    inputs: [
      { name: "iron_plate_in", side: "west", rel_pos: [-3, 0], throughput: 0.5, item: "iron-plate", kind: "belt" },
      { name: "power_in",      side: "north", rel_pos: [0, -2], throughput: 75, item: "electricity", kind: "power" },
    ],
    outputs: [
      { name: "gear_belt", side: "east", rel_pos: [4, 0], throughput: 0.5, item: "iron-gear-wheel", kind: "belt" },
    ],
    footprint: { min: [-3.5, -2.5], max: [4.5, 1.5] },
    realization: { blueprint: "lib/blueprints/gear-production.json" },
  };
}

function modulesMap(...mods) {
  return new Map(mods.map((m) => [m.id, m]));
}

// ============================================================
// Basic cases
// ============================================================

test("no unbound inputs → empty added/decisions", () => {
  const plan = {
    placements: [
      { id: "p0", module: "iron-smelt-line", anchor: { x: 0, y: 0 }, direction: "north" },
    ],
    // coal_in is bound explicitly
    connections: [
      { from: "src.coal_belt", to: "p0.coal_in", required_throughput: 0.36 },
    ],
  };
  const r = synthesizeConnections({
    plan,
    modules: modulesMap(ironSmeltLine()),
    worldEntries: [],
  });
  assert.equal(r.added.length, 0);
  // decisions still record the "already_bound" status
  assert.equal(r.decisions.filter((d) => d.kind === "already_bound").length, 1);
});

test("one matching upstream → adds one synthesized connection", () => {
  const plan = {
    placements: [
      { id: "p0", module: "gear-production", anchor: { x: 50, y: 0 }, direction: "north" },
    ],
    connections: [],
  };
  const worldEntries = [
    { id: "e2-first-iron:p0", module: "iron-smelt-line", anchor: { x: 0, y: 0 }, direction: "north", epoch: "e2-first-iron" },
  ];
  const r = synthesizeConnections({
    plan,
    modules: modulesMap(ironSmeltLine(), gearProduction()),
    worldEntries,
  });
  assert.equal(r.added.length, 1);
  const conn = r.added[0];
  assert.equal(conn.from, "e2-first-iron:p0.iron_plate_belt");
  assert.equal(conn.to, "p0.iron_plate_in");
  assert.equal(conn._synthesized, true);
  assert.equal(conn.required_throughput, 0.5);
  assert.ok(r.worldPlacements.has("e2-first-iron:p0"));
});

test("nearest match wins when multiple upstreams produce the same item", () => {
  const plan = {
    placements: [
      { id: "p0", module: "gear-production", anchor: { x: 50, y: 0 }, direction: "north" },
    ],
    connections: [],
  };
  // Two iron-smelt-lines: one near (anchor x=40), one far (anchor x=0).
  // gear-production input is at (50 + -3, 0) = (47, 0). Iron output for
  // near is at (40 + 6.5, 0.5) = (46.5, 0.5); for far at (0 + 6.5, 0.5).
  const worldEntries = [
    { id: "e2-far:p0",  module: "iron-smelt-line", anchor: { x: 0,  y: 0 }, direction: "north", epoch: "e2-far"  },
    { id: "e2-near:p0", module: "iron-smelt-line", anchor: { x: 40, y: 0 }, direction: "north", epoch: "e2-near" },
  ];
  const r = synthesizeConnections({
    plan,
    modules: modulesMap(ironSmeltLine(), gearProduction()),
    worldEntries,
  });
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0].from, "e2-near:p0.iron_plate_belt");
});

test("no matching upstream → needs_upstream decision, no entry added", () => {
  const plan = {
    placements: [
      { id: "p0", module: "gear-production", anchor: { x: 0, y: 0 }, direction: "north" },
    ],
    connections: [],
  };
  const r = synthesizeConnections({
    plan,
    modules: modulesMap(gearProduction()),
    worldEntries: [],          // no deployed modules
  });
  assert.equal(r.added.length, 0);
  const need = r.decisions.find((d) => d.kind === "needs_upstream");
  assert.ok(need, "expected needs_upstream decision");
  assert.equal(need.input, "p0.iron_plate_in");
  assert.equal(need.item, "iron-plate");
});

test("explicit connection takes precedence over auto-route", () => {
  const plan = {
    placements: [
      { id: "p0", module: "gear-production", anchor: { x: 50, y: 0 }, direction: "north" },
    ],
    connections: [
      { from: "manual.iron_plate_belt", to: "p0.iron_plate_in", required_throughput: 0.5 },
    ],
  };
  const worldEntries = [
    { id: "e2-iron:p0", module: "iron-smelt-line", anchor: { x: 0, y: 0 }, direction: "north", epoch: "e2" },
  ];
  const r = synthesizeConnections({
    plan,
    modules: modulesMap(ironSmeltLine(), gearProduction()),
    worldEntries,
  });
  assert.equal(r.added.length, 0, "explicit binding should suppress auto-route");
  assert.equal(r.decisions.find((d) => d.kind === "already_bound").input, "p0.iron_plate_in");
});

test("power inputs are not handled (left for execute.js auto-power loop)", () => {
  const plan = {
    placements: [
      { id: "p0", module: "gear-production", anchor: { x: 0, y: 0 }, direction: "north" },
    ],
    connections: [],
  };
  const r = synthesizeConnections({
    plan,
    modules: modulesMap(gearProduction()),
    worldEntries: [],
  });
  // power_in should NOT appear in decisions at all; it's intentionally skipped.
  assert.equal(r.decisions.find((d) => d.input === "p0.power_in"), undefined);
});

test("unknown deployed module is skipped gracefully", () => {
  const plan = {
    placements: [
      { id: "p0", module: "gear-production", anchor: { x: 0, y: 0 }, direction: "north" },
    ],
    connections: [],
  };
  const worldEntries = [
    { id: "stale:p0", module: "removed-module", anchor: { x: 0, y: 0 }, direction: "north", epoch: "removed" },
  ];
  const r = synthesizeConnections({
    plan,
    modules: modulesMap(gearProduction()),  // does NOT include 'removed-module'
    worldEntries,
  });
  // Stale entry just doesn't match; iron_plate_in falls through to needs_upstream.
  const need = r.decisions.find((d) => d.kind === "needs_upstream");
  assert.ok(need);
  assert.equal(r.added.length, 0);
});

test("plan with module not in map → module_not_found decision", () => {
  const plan = {
    placements: [
      { id: "p0", module: "missing-module", anchor: { x: 0, y: 0 }, direction: "north" },
    ],
    connections: [],
  };
  const r = synthesizeConnections({
    plan,
    modules: new Map(),
    worldEntries: [],
  });
  assert.equal(r.added.length, 0);
  const d = r.decisions.find((x) => x.kind === "module_not_found");
  assert.ok(d);
  assert.equal(d.placement, "p0");
});

test("empty plan tolerated", () => {
  const r = synthesizeConnections({
    plan: { placements: [], connections: [] },
    modules: new Map(),
    worldEntries: [],
  });
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.decisions, []);
});
