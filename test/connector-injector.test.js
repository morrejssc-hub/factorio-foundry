import { test } from "node:test";
import assert from "node:assert/strict";
import { injectConnectors } from "../src/runner/connector-injector.js";
import { loadAllModules } from "../src/lib-loader.js";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const LIB = resolve(ROOT, "lib");

// A working two-region decomposition (coal feeds iron smelting). Real lib
// modules; the routeBelt feasibility check exercises the full geometry path.
function buildSampleDecomposition() {
  return {
    mode: "decompose",
    epoch: "test-decomp",
    subs: [
      {
        id: "coal-region",
        region: { x_min: -50, x_max: -30, y_min: 0, y_max: 30 },
        contract: {
          inputs: [],
          outputs: [
            { id: "coal_out", item: "coal", rate: 0.18, paired_with: "iron-region.coal_in" },
          ],
        },
        allowed_modules: ["coal-burner-cell"],
      },
      {
        id: "iron-region",
        region: { x_min: 30, x_max: 60, y_min: 0, y_max: 30 },
        contract: {
          inputs: [
            { id: "coal_in", item: "coal", rate: 0.18, paired_with: "coal-region.coal_out" },
          ],
          outputs: [],
        },
        allowed_modules: ["iron-smelt-line"],
      },
    ],
  };
}

function buildSampleSubResults(decomposition) {
  return [
    {
      sub_id: "coal-region",
      sub: decomposition.subs[0],
      fragment: {
        mode: "fragment",
        sub_id: "coal-region",
        placements: [
          { id: "c0", module: "coal-burner-cell", anchor: { x: -45, y: 15 }, direction: "north" },
        ],
        ports: { coal_out: "c0.coal_belt" },
        connections: [],
        expected_local_throughput: { coal: 0.18 },
      },
      errors: [],
      raw: {},
    },
    {
      sub_id: "iron-region",
      sub: decomposition.subs[1],
      fragment: {
        mode: "fragment",
        sub_id: "iron-region",
        placements: [
          { id: "i0", module: "iron-smelt-line", anchor: { x: 35, y: 15 }, direction: "north" },
        ],
        ports: { coal_in: "i0.coal_in" },
        connections: [],
        expected_local_throughput: { "iron-plate": 0.20 },
      },
      errors: [],
      raw: {},
    },
  ];
}

test("connector-injector synthesises a plan from a happy-path decomposition", async () => {
  const modules = await loadAllModules(LIB);
  const decomposition = buildSampleDecomposition();
  const subResults = buildSampleSubResults(decomposition);
  const { plan, errors } = await injectConnectors({
    decomposition,
    subResults,
    modules,
    rootDir: ROOT,
  });

  assert.equal(errors.length, 0, "errors: " + errors.join("\n"));
  assert.ok(plan, "plan should be returned");
  assert.equal(plan.epoch, "test-decomp");
  assert.equal(plan.placements.length, 2);
  assert.equal(plan.placements[0].id, "coal-region__c0");
  assert.equal(plan.placements[1].id, "iron-region__i0");
  assert.equal(plan.connections.length, 1);
  assert.equal(plan.connections[0].from, "coal-region__c0.coal_belt");
  assert.equal(plan.connections[0].to, "iron-region__i0.coal_in");
  assert.equal(plan.connections[0].required_throughput, 0.18);
  assert.ok(plan.expected_throughput > 0);
  assert.ok(plan.scaling_note.includes("2 sub-designers"));
  assert.equal(plan.extra.synthesized_from, "decomposition");
});

test("connector-injector rejects placement that escapes its region", async () => {
  const modules = await loadAllModules(LIB);
  const decomposition = buildSampleDecomposition();
  const subResults = buildSampleSubResults(decomposition);
  // Move coal-region's placement outside its bbox (region max x = -30; -25 escapes east).
  subResults[0].fragment.placements[0].anchor = { x: -25, y: 15 };
  const { plan, errors } = await injectConnectors({
    decomposition, subResults, modules, rootDir: ROOT,
  });
  assert.equal(plan, null);
  assert.ok(errors.some((e) => e.includes("extends outside region")), "errors: " + errors.join("\n"));
});

test("connector-injector rejects when paired_with references unknown sub", async () => {
  const modules = await loadAllModules(LIB);
  const decomposition = buildSampleDecomposition();
  decomposition.subs[0].contract.outputs[0].paired_with = "ghost-region.coal_in";
  const subResults = buildSampleSubResults(decomposition);
  const { plan, errors } = await injectConnectors({
    decomposition, subResults, modules, rootDir: ROOT,
  });
  assert.equal(plan, null);
  assert.ok(errors.some((e) => e.includes("unknown sub")), "errors: " + errors.join("\n"));
});

test("connector-injector rejects when fragment binds output to a non-belt port", async () => {
  const modules = await loadAllModules(LIB);
  const decomposition = buildSampleDecomposition();
  const subResults = buildSampleSubResults(decomposition);
  // gear-production has a `power_in` input port (kind: power). Pointing a
  // contract output at a non-belt port must fail the kind check that
  // connector-injector enforces on inter-region transport-belt connectors.
  decomposition.subs[0].allowed_modules = ["gear-production"];
  subResults[0].fragment.placements = [
    { id: "c0", module: "gear-production", anchor: { x: -45, y: 15 }, direction: "north" },
  ];
  subResults[0].fragment.ports.coal_out = "c0.power_in";
  const { plan, errors } = await injectConnectors({
    decomposition, subResults, modules, rootDir: ROOT,
  });
  assert.equal(plan, null);
  assert.ok(
    errors.some((e) => e.includes("port kinds must both be \"belt\"")),
    "errors: " + errors.join("\n"),
  );
});

test("connector-injector reports missing fragment if a sub failed", async () => {
  const modules = await loadAllModules(LIB);
  const decomposition = buildSampleDecomposition();
  const subResults = buildSampleSubResults(decomposition);
  subResults[1].fragment = null;
  subResults[1].errors = ["pi process timed out"];
  const { plan, errors } = await injectConnectors({
    decomposition, subResults, modules, rootDir: ROOT,
  });
  assert.equal(plan, null);
  assert.ok(errors.some((e) => e.includes("no plan-fragment.yaml produced")), "errors: " + errors.join("\n"));
  assert.ok(errors.some((e) => e.includes("pi process timed out")), "errors: " + errors.join("\n"));
});
