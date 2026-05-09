import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAudit } from "../src/runner/audit-resolver.js";

const ROOT = "/root";
const STAGED = "/staged";

function makeModules() {
  return new Map([
    ["coal-burner-cell", {
      id: "coal-burner-cell",
      audits: [{
        id: "cbc-throughput",
        script: "lib/audits/throughput-window.lua",
        metric: "coal_per_s",
        aggregate: "rate_from_cumulative",
        params: { item: "coal", window_ticks: 3600 },
      }],
    }],
    ["steam-power-line", {
      id: "steam-power-line",
      _staged: true,
      audits: [{
        id: "spl-power",
        script: "staged-modules/steam-power-line-audit.lua",
        metric: "power_kw",
        aggregate: "snapshot_post",
        params: { window_ticks: 3600 },
      }],
    }],
  ]);
}

test("legacy shape: target_metric.audit + min_rate_per_s threshold", () => {
  const r = resolveAudit({
    targetMetric: {
      audit: "lib/audits/throughput-window.lua",
      params: { item: "coal", min_rate_per_s: 0.1, window_ticks: 3600 },
    },
    rootDir: ROOT,
  });
  assert.equal(r.scriptPath, "/root/lib/audits/throughput-window.lua");
  assert.equal(r.aggregate, "rate_from_cumulative");
  assert.equal(r.threshold, 0.1);
  assert.equal(r.item, "coal");
  assert.equal(r.metric, null);
  assert.equal(r.moduleId, null);
});

test("module shape: pulls audit from module, merges params, uses explicit threshold", () => {
  const r = resolveAudit({
    targetMetric: { module: "coal-burner-cell", threshold: 0.3, params: { window_ticks: 1800 } },
    modules: makeModules(),
    rootDir: ROOT,
  });
  assert.equal(r.scriptPath, "/root/lib/audits/throughput-window.lua");
  assert.equal(r.threshold, 0.3);
  assert.equal(r.params.window_ticks, 1800);
  assert.equal(r.params.item, "coal");
  assert.equal(r.moduleId, "coal-burner-cell");
  assert.equal(r.auditId, "cbc-throughput");
  assert.equal(r.metric, "coal_per_s");
});

test("module shape with audit_id picks named audit", () => {
  const modules = new Map([["m", {
    id: "m",
    audits: [
      { id: "a1", script: "lib/audits/x.lua", metric: "foo" },
      { id: "a2", script: "lib/audits/y.lua", metric: "bar" },
    ],
  }]]);
  const r = resolveAudit({
    targetMetric: { module: "m", audit_id: "a2", threshold: 1 },
    modules,
    rootDir: ROOT,
  });
  assert.equal(r.auditId, "a2");
  assert.equal(r.scriptPath, "/root/lib/audits/y.lua");
});

test("goal-only shape: finds module by metric, resolves staged path", () => {
  const r = resolveAudit({
    targetMetric: { metric: "power_kw", threshold: 100, params: { window_ticks: 3600 } },
    modules: makeModules(),
    plan: { placements: [{ id: "p0", module: "steam-power-line" }] },
    rootDir: ROOT,
    stagedDir: STAGED,
  });
  assert.equal(r.scriptPath, "/staged/steam-power-line-audit.lua");
  assert.equal(r.aggregate, "snapshot_post");
  assert.equal(r.threshold, 100);
  assert.equal(r.metric, "power_kw");
  assert.equal(r.moduleId, "steam-power-line");
});

test("goal-only shape: errors when no placed module matches metric", () => {
  assert.throws(
    () => resolveAudit({
      targetMetric: { metric: "no_such" },
      modules: makeModules(),
      plan: { placements: [{ id: "p0", module: "steam-power-line" }] },
      rootDir: ROOT,
    }),
    /no placed module declares an audit/,
  );
});

test("goal-only shape: errors when multiple placed modules match metric", () => {
  const modules = new Map([
    ["a", { id: "a", audits: [{ id: "ax", script: "lib/audits/x.lua", metric: "shared" }] }],
    ["b", { id: "b", audits: [{ id: "bx", script: "lib/audits/y.lua", metric: "shared" }] }],
  ]);
  assert.throws(
    () => resolveAudit({
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
    () => resolveAudit({
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
  assert.throws(() => resolveAudit({ rootDir: ROOT }), /target_metric/);
});

test("schema validates audits[] in lib-loader", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadAllModules } = await import("../src/lib-loader.js");
  const root = await mkdtemp(join(tmpdir(), "foundry-audits-test-"));
  await mkdir(join(root, "modules"), { recursive: true });
  await writeFile(join(root, "modules", "m.yaml"), `
id: m
version: 1
inputs: []
outputs:
  - { name: out, rel_pos: [1, 0], throughput: 1.0, item: coal, kind: belt }
footprint: { min: [-1, -1], max: [2, 1] }
realization: { blueprint: lib/blueprints/foo.json }
audits:
  - id: a1
    script: lib/audits/x.lua
    metric: power_kw
    aggregate: snapshot_post
    params: { window_ticks: 3600 }
`);
  const mods = await loadAllModules(root);
  assert.equal(mods.get("m").audits[0].metric, "power_kw");
  await rm(root, { recursive: true, force: true });
});

test("schema rejects audits with bad aggregate", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadAllModules } = await import("../src/lib-loader.js");
  const root = await mkdtemp(join(tmpdir(), "foundry-audits-bad-"));
  await mkdir(join(root, "modules"), { recursive: true });
  await writeFile(join(root, "modules", "m.yaml"), `
id: m
version: 1
inputs: []
outputs: []
footprint: { min: [0,0], max: [1,1] }
realization: { blueprint: x }
audits:
  - id: a1
    script: lib/audits/x.lua
    aggregate: bogus_strategy
`);
  await assert.rejects(() => loadAllModules(root), /aggregate invalid/);
  await rm(root, { recursive: true, force: true });
});
