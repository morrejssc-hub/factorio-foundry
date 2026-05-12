// observe-diagnostic.test.js — unit tests for the entity-diagnostic
// extension to the observe phase. The lua probe itself needs Factorio
// and is exercised via live epoch runs; here we cover:
//   1. computeWorldFootprints math (anchor + module.footprint → world bbox)
//   2. runObserve merges the diagnostic into observe.json
//   3. runObserve survives a probe failure (non-fatal, surfaces as
//      diagnostic.error without affecting the meter verdict)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runObserve, computeWorldFootprints } from "../src/runner/observe.js";

function fakeModule(id, opts = {}) {
  return {
    id,
    version: 1,
    footprint: opts.footprint ?? { min: [-2, -2], max: [2, 2] },
    inputs: opts.inputs ?? [],
    outputs: opts.outputs ?? [],
    meters: opts.meters ?? [],
    realization: { blueprint: `lib/blueprints/${id}.json` },
  };
}

// ============================================================
// computeWorldFootprints
// ============================================================

test("computeWorldFootprints: anchor + footprint math", () => {
  const plan = {
    placements: [
      { id: "p0", module: "m", anchor: { x: 10, y: 10 }, direction: "north" },
      { id: "p1", module: "m", anchor: { x: 50, y: 50 }, direction: "north" },
    ],
  };
  const modules = new Map([["m", fakeModule("m")]]);

  const fps = computeWorldFootprints(plan, modules);
  assert.equal(fps.length, 2);
  assert.deepEqual(fps[0], {
    id: "p0", module: "m",
    bbox: { min: { x: 8, y: 8 }, max: { x: 12, y: 12 } },
  });
  assert.deepEqual(fps[1], {
    id: "p1", module: "m",
    bbox: { min: { x: 48, y: 48 }, max: { x: 52, y: 52 } },
  });
});

test("computeWorldFootprints: skips placements with no matching module", () => {
  const plan = {
    placements: [
      { id: "p0", module: "known", anchor: { x: 0, y: 0 }, direction: "north" },
      { id: "p1", module: "missing", anchor: { x: 0, y: 0 }, direction: "north" },
    ],
  };
  const modules = new Map([["known", fakeModule("known")]]);

  const fps = computeWorldFootprints(plan, modules);
  assert.equal(fps.length, 1);
  assert.equal(fps[0].id, "p0");
});

test("computeWorldFootprints: skips modules without footprint", () => {
  const plan = { placements: [{ id: "p0", module: "m", anchor: { x: 0, y: 0 } }] };
  const modules = new Map([["m", { id: "m" }]]);
  assert.deepEqual(computeWorldFootprints(plan, modules), []);
});

test("computeWorldFootprints: empty / missing plan tolerated", () => {
  assert.deepEqual(computeWorldFootprints(null, new Map()), []);
  assert.deepEqual(computeWorldFootprints({}, new Map()), []);
  assert.deepEqual(computeWorldFootprints({ placements: [] }, new Map()), []);
});

// ============================================================
// runObserve — diagnostic merge + non-fatal probe failure
// ============================================================

function fakeController({ diagnosticFn }) {
  let meterCalls = 0;
  return {
    config: { rootDir: process.cwd() },
    runLuaScript: async (scriptPath /*, params */) => {
      if (scriptPath.endsWith("entity-diagnostic.lua")) {
        return diagnosticFn();
      }
      // Meter snapshot (throughput-window). Cumulative_produced grows so
      // measured = (after - before) / seconds is positive.
      meterCalls++;
      return {
        ok: true,
        item: "coal",
        tick: meterCalls * 3600,
        cumulative_produced: meterCalls * 15,
      };
    },
    advanceTicks: async () => {},
    countEntities: async () => 1,
    countEntitiesByName: async () => 0,
  };
}

const planFixture = {
  placements: [
    { id: "p0", module: "m", anchor: { x: 0, y: 0 }, direction: "north" },
  ],
};
const modulesFixture = new Map([["m", fakeModule("m")]]);

const diagnosticPayload = {
  ok: true,
  footprints: [
    {
      id: "p0", module: "m",
      bbox: { min: { x: -2, y: -2 }, max: { x: 2, y: 2 } },
      entities: [
        {
          unit_number: 1,
          name: "burner-mining-drill",
          type: "mining-drill",
          position: { x: 0, y: 0 },
          status: "working",
          status_code: 1,
        },
      ],
      by_status: { working: 1 },
      issues: [],
    },
  ],
  summary: { total_entities: 1, issue_count: 0, statuses_seen: ["working"] },
};

test("runObserve: merges diagnostic into observe.json", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "observe-diag-"));
  const controller = fakeController({ diagnosticFn: () => diagnosticPayload });

  const verdict = await runObserve({
    controller,
    targetMetric: { meter: "lib/meters/throughput-window.lua", params: { item: "coal", min_rate_per_s: 0 } },
    outDir,
    modules: modulesFixture,
    plan: planFixture,
  });

  assert.equal(verdict.pass, true);
  assert.equal(verdict.diagnostic.ok, true);
  assert.equal(verdict.diagnostic.summary.total_entities, 1);
  assert.equal(verdict.diagnostic.footprints[0].entities[0].status, "working");

  const onDisk = JSON.parse(await readFile(join(outDir, "observe.json"), "utf8"));
  assert.equal(onDisk.diagnostic.ok, true);
  assert.equal(onDisk.diagnostic.summary.issue_count, 0);
  assert.equal(onDisk.pass, true);
});

test("runObserve: diagnostic probe failure is non-fatal", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "observe-diag-fail-"));
  const controller = fakeController({
    diagnosticFn: () => { throw new Error("rcon timeout"); },
  });

  const verdict = await runObserve({
    controller,
    targetMetric: { meter: "lib/meters/throughput-window.lua", params: { item: "coal", min_rate_per_s: 0 } },
    outDir,
    modules: modulesFixture,
    plan: planFixture,
  });

  assert.equal(verdict.pass, true, "meter verdict unaffected by probe failure");
  assert.equal(verdict.diagnostic.ok, false);
  assert.match(verdict.diagnostic.error, /rcon timeout/);

  const onDisk = JSON.parse(await readFile(join(outDir, "observe.json"), "utf8"));
  assert.equal(onDisk.diagnostic.ok, false);
  assert.match(onDisk.diagnostic.error, /rcon timeout/);
});

test("runObserve: empty plan returns synthetic ok diagnostic without lua call", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "observe-diag-empty-"));
  let probeCalls = 0;
  const controller = fakeController({
    diagnosticFn: () => { probeCalls++; return diagnosticPayload; },
  });

  const verdict = await runObserve({
    controller,
    targetMetric: { meter: "lib/meters/throughput-window.lua", params: { item: "coal", min_rate_per_s: 0 } },
    outDir,
    modules: new Map(),
    plan: { placements: [] },
  });

  assert.equal(probeCalls, 0, "no footprints → probe is skipped");
  assert.equal(verdict.diagnostic.ok, true);
  assert.equal(verdict.diagnostic.summary.total_entities, 0);
  assert.deepEqual(verdict.diagnostic.footprints, []);
});
