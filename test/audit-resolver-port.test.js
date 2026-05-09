import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { resolveAudit } from "../src/runner/audit-resolver.js";

const ROOT = "/root";

function makePortModule({ kind, item }) {
  return new Map([
    ["my-mod", {
      id: "my-mod",
      inputs: [],
      outputs: [
        { name: "out", side: "south", rel_pos: [0.5, 2.5], item, kind, throughput: 1 },
      ],
      audits: [{
        id: "my-mod-meter",
        port: "out",
        metric: `${kind}_metric`,
        aggregate: "rate_from_cumulative",
        params: { window_ticks: 3600 },
      }],
    }],
  ]);
}

function planWithPlacement({ x, y, direction = "north" }) {
  return {
    placements: [
      { id: "p0", module: "my-mod", anchor: { x, y }, direction },
    ],
  };
}

test("audit.port: belt → port-meter scriptPath, port_kind+item in params", () => {
  const r = resolveAudit({
    targetMetric: { module: "my-mod" },
    modules: makePortModule({ kind: "belt", item: "coal" }),
    plan: planWithPlacement({ x: 10, y: 20 }),
    rootDir: ROOT,
  });
  assert.equal(r.scriptRel, "lib/meters/port-meter.lua");
  assert.equal(r.scriptPath, resolve(ROOT, "lib/meters/port-meter.lua"));
  assert.equal(r.params.port_kind, "belt");
  assert.equal(r.params.item, "coal");
  assert.deepEqual(r.params.port_position, { x: 10.5, y: 22.5 });
  assert.equal(r.params.window_ticks, 3600);
  assert.equal(r.metric, "belt_metric");
  assert.equal(r.moduleId, "my-mod");
  assert.equal(r.auditId, "my-mod-meter");
});

test("audit.port: pipe → fluid in params (not item)", () => {
  const r = resolveAudit({
    targetMetric: { module: "my-mod" },
    modules: makePortModule({ kind: "pipe", item: "water" }),
    plan: planWithPlacement({ x: 0, y: 0 }),
    rootDir: ROOT,
  });
  assert.equal(r.params.port_kind, "pipe");
  assert.equal(r.params.fluid, "water");
  assert.equal(r.params.item, undefined);
});

test("audit.port: power → no item/fluid in params, just port_kind+position", () => {
  const r = resolveAudit({
    targetMetric: { module: "my-mod" },
    modules: makePortModule({ kind: "power", item: "electricity" }),
    plan: planWithPlacement({ x: -9, y: -47 }),
    rootDir: ROOT,
  });
  assert.equal(r.params.port_kind, "power");
  assert.equal(r.params.item, undefined);
  assert.equal(r.params.fluid, undefined);
  assert.deepEqual(r.params.port_position, { x: -8.5, y: -44.5 });
});

test("audit.port: rotation applied for east-facing placement", () => {
  // rel_pos [0.5, 2.5] under east rotation: (x, y) → (-y, x) = (-2.5, 0.5)
  const r = resolveAudit({
    targetMetric: { module: "my-mod" },
    modules: makePortModule({ kind: "belt", item: "coal" }),
    plan: planWithPlacement({ x: 10, y: 20, direction: "east" }),
    rootDir: ROOT,
  });
  assert.deepEqual(r.params.port_position, { x: 7.5, y: 20.5 });
});

test("audit.port: throws when no placement uses the audited module", () => {
  assert.throws(() => resolveAudit({
    targetMetric: { module: "my-mod" },
    modules: makePortModule({ kind: "belt", item: "coal" }),
    plan: { placements: [] },
    rootDir: ROOT,
  }), /needs a placement of module 'my-mod'/);
});

test("audit.port: throws on multiple placements (V1 ambiguity guard)", () => {
  assert.throws(() => resolveAudit({
    targetMetric: { module: "my-mod" },
    modules: makePortModule({ kind: "belt", item: "coal" }),
    plan: {
      placements: [
        { id: "p0", module: "my-mod", anchor: { x: 0, y: 0 }, direction: "north" },
        { id: "p1", module: "my-mod", anchor: { x: 5, y: 5 }, direction: "north" },
      ],
    },
    rootDir: ROOT,
  }), /ambiguous/);
});

test("audit.port: throws when port name doesn't match module ports", () => {
  const modules = new Map([
    ["my-mod", {
      id: "my-mod",
      inputs: [],
      outputs: [
        { name: "out", side: "south", rel_pos: [0, 0], item: "coal", kind: "belt", throughput: 1 },
      ],
      audits: [{ id: "bad", port: "nope", metric: "x", aggregate: "rate_from_cumulative" }],
    }],
  ]);
  assert.throws(() => resolveAudit({
    targetMetric: { module: "my-mod" },
    modules,
    plan: planWithPlacement({ x: 0, y: 0 }),
    rootDir: ROOT,
  }), /no port named 'nope'/);
});

test("legacy script: audit unaffected by port-branch (regression check)", () => {
  const modules = new Map([
    ["legacy", {
      id: "legacy",
      audits: [{
        id: "leg",
        script: "lib/audits/throughput-window.lua",
        metric: "coal_per_s",
        aggregate: "rate_from_cumulative",
        params: { item: "coal", window_ticks: 3600 },
      }],
    }],
  ]);
  const r = resolveAudit({
    targetMetric: { module: "legacy" },
    modules,
    rootDir: ROOT,
  });
  assert.equal(r.scriptRel, "lib/audits/throughput-window.lua");
  assert.equal(r.params.item, "coal");
  assert.equal(r.params.port_kind, undefined);
});
