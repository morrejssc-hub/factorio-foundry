import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMeter } from "../src/runner/meter-resolver.js";

const ROOT = "/root";
const STAGED = "/staged";

function makeModules() {
  return new Map([
    ["coal-burner-cell", {
      id: "coal-burner-cell",
      meters: [{
        id: "cbc-throughput",
        script: "lib/meters/throughput-window.lua",
        metric: "coal_per_s",
        aggregate: "rate_from_cumulative",
        params: { item: "coal", window_ticks: 3600 },
      }],
    }],
    ["steam-power-line", {
      id: "steam-power-line",
      _staged: true,
      meters: [{
        id: "spl-power",
        script: "staged-modules/steam-power-line-meter.lua",
        metric: "power_kw",
        aggregate: "snapshot_post",
        params: { window_ticks: 3600 },
      }],
    }],
  ]);
}

test("legacy shape: target_metric.meter + min_rate_per_s threshold", () => {
  const r = resolveMeter({
    targetMetric: {
      meter: "lib/meters/throughput-window.lua",
      params: { item: "coal", min_rate_per_s: 0.1, window_ticks: 3600 },
    },
    rootDir: ROOT,
  });
  assert.equal(r.scriptPath, "/root/lib/meters/throughput-window.lua");
  assert.equal(r.aggregate, "rate_from_cumulative");
  assert.equal(r.threshold, 0.1);
  assert.equal(r.item, "coal");
  assert.equal(r.metric, null);
  assert.equal(r.moduleId, null);
});

test("module shape: pulls meter from module, merges params, uses explicit threshold", () => {
  const r = resolveMeter({
    targetMetric: { module: "coal-burner-cell", threshold: 0.3, params: { window_ticks: 1800 } },
    modules: makeModules(),
    rootDir: ROOT,
  });
  assert.equal(r.scriptPath, "/root/lib/meters/throughput-window.lua");
  assert.equal(r.threshold, 0.3);
  assert.equal(r.params.window_ticks, 1800);
  assert.equal(r.params.item, "coal");
  assert.equal(r.moduleId, "coal-burner-cell");
  assert.equal(r.meterId, "cbc-throughput");
  assert.equal(r.metric, "coal_per_s");
});

test("module shape with meter_id picks named meter", () => {
  const modules = new Map([["m", {
    id: "m",
    meters: [
      { id: "a1", script: "lib/meters/x.lua", metric: "foo" },
      { id: "a2", script: "lib/meters/y.lua", metric: "bar" },
    ],
  }]]);
  const r = resolveMeter({
    targetMetric: { module: "m", meter_id: "a2", threshold: 1 },
    modules,
    rootDir: ROOT,
  });
  assert.equal(r.meterId, "a2");
  assert.equal(r.scriptPath, "/root/lib/meters/y.lua");
});

test("goal-only shape: finds module by metric, resolves staged path", () => {
  const r = resolveMeter({
    targetMetric: { metric: "power_kw", threshold: 100, params: { window_ticks: 3600 } },
    modules: makeModules(),
    plan: { placements: [{ id: "p0", module: "steam-power-line" }] },
    rootDir: ROOT,
    stagedDir: STAGED,
  });
  assert.equal(r.scriptPath, "/staged/steam-power-line-meter.lua");
  assert.equal(r.aggregate, "snapshot_post");
  assert.equal(r.threshold, 100);
  assert.equal(r.metric, "power_kw");
  assert.equal(r.moduleId, "steam-power-line");
});

test("goal-only shape: errors when no placed module matches metric", () => {
  assert.throws(
    () => resolveMeter({
      targetMetric: { metric: "no_such" },
      modules: makeModules(),
      plan: { placements: [{ id: "p0", module: "steam-power-line" }] },
      rootDir: ROOT,
    }),
    /no placed module declares a meter/,
  );
});

test("goal-only shape: errors when multiple placed modules match metric", () => {
  const modules = new Map([
    ["a", { id: "a", meters: [{ id: "ax", script: "lib/meters/x.lua", metric: "shared" }] }],
    ["b", { id: "b", meters: [{ id: "bx", script: "lib/meters/y.lua", metric: "shared" }] }],
  ]);
  assert.throws(
    () => resolveMeter({
      targetMetric: { metric: "shared" },
      modules,
      plan: { placements: [{ id: "p0", module: "a" }, { id: "p1", module: "b" }] },
      rootDir: ROOT,
    }),
    /2 placed modules/,
  );
});

test("staged path requires stagedDir", () => {
  assert.throws(
    () => resolveMeter({
      targetMetric: { metric: "power_kw" },
      modules: makeModules(),
      plan: { placements: [{ id: "p0", module: "steam-power-line" }] },
      rootDir: ROOT,
      // stagedDir omitted
    }),
    /staged-modules\//,
  );
});

test("missing target_metric throws", () => {
  assert.throws(() => resolveMeter({ rootDir: ROOT }), /target_metric/);
});

test("schema validates meters[] in lib-loader", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadAllModules } = await import("../src/lib-loader.js");
  const root = await mkdtemp(join(tmpdir(), "foundry-meters-test-"));
  await mkdir(join(root, "modules"), { recursive: true });
  await writeFile(join(root, "modules", "m.yaml"), `
id: m
version: 1
inputs: []
outputs:
  - { name: out, rel_pos: [1, 0], throughput: 1.0, item: coal, kind: belt }
footprint: { min: [-1, -1], max: [2, 1] }
realization: { blueprint: lib/blueprints/foo.json }
meters:
  - id: a1
    script: lib/meters/x.lua
    metric: power_kw
    aggregate: snapshot_post
    params: { window_ticks: 3600 }
`);
  const mods = await loadAllModules(root);
  assert.equal(mods.get("m").meters[0].metric, "power_kw");
  await rm(root, { recursive: true, force: true });
});

test("schema rejects meters with bad aggregate", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadAllModules } = await import("../src/lib-loader.js");
  const root = await mkdtemp(join(tmpdir(), "foundry-meters-bad-"));
  await mkdir(join(root, "modules"), { recursive: true });
  await writeFile(join(root, "modules", "m.yaml"), `
id: m
version: 1
inputs: []
outputs: []
footprint: { min: [0,0], max: [1,1] }
realization: { blueprint: x }
meters:
  - id: a1
    script: lib/meters/x.lua
    aggregate: bogus_strategy
`);
  await assert.rejects(() => loadAllModules(root), /aggregate invalid/);
  await rm(root, { recursive: true, force: true });
});
