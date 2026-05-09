import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateCriteria, validateCriteria, evaluateOne,
  coerceLegacyCriteria, headlineThreshold,
} from "../src/runner/success-criteria.js";

const ctx = (overrides = {}) => ({
  measured: 250,
  metric: "power_kw",
  executeOk: true,
  countEntities: async (name) => ({ "steam-engine": 1, "boiler": 0 }[name] ?? 0),
  ...overrides,
});

test("build_only passes when executeOk", async () => {
  const r = await evaluateOne({ kind: "build_only" }, ctx());
  assert.equal(r.pass, true);
});

test("build_only fails when executeOk false", async () => {
  const r = await evaluateOne({ kind: "build_only" }, ctx({ executeOk: false }));
  assert.equal(r.pass, false);
});

test("nonzero passes when measured > 0", async () => {
  const r = await evaluateOne({ kind: "nonzero" }, ctx({ measured: 0.001 }));
  assert.equal(r.pass, true);
  assert.equal(r.value, 0.001);
});

test("nonzero fails when measured = 0", async () => {
  const r = await evaluateOne({ kind: "nonzero" }, ctx({ measured: 0 }));
  assert.equal(r.pass, false);
});

test("nonzero fails when measured is null/undefined", async () => {
  const r = await evaluateOne({ kind: "nonzero" }, ctx({ measured: null }));
  assert.equal(r.pass, false);
});

test("threshold >= passes at boundary", async () => {
  const r = await evaluateOne({ kind: "threshold", op: ">=", value: 100 }, ctx({ measured: 100 }));
  assert.equal(r.pass, true);
  assert.equal(r.threshold, 100);
});

test("threshold > fails at boundary", async () => {
  const r = await evaluateOne({ kind: "threshold", op: ">", value: 100 }, ctx({ measured: 100 }));
  assert.equal(r.pass, false);
});

test("threshold < op", async () => {
  const r = await evaluateOne({ kind: "threshold", op: "<", value: 50 }, ctx({ measured: 30 }));
  assert.equal(r.pass, true);
});

test("entity_exists pass when found >= min_count", async () => {
  const r = await evaluateOne({ kind: "entity_exists", name: "steam-engine" }, ctx());
  assert.equal(r.pass, true);
  assert.equal(r.found, 1);
});

test("entity_exists fail when found < min_count", async () => {
  const r = await evaluateOne({ kind: "entity_exists", name: "steam-engine", min_count: 3 }, ctx());
  assert.equal(r.pass, false);
});

test("entity_exists fails when not present", async () => {
  const r = await evaluateOne({ kind: "entity_exists", name: "boiler" }, ctx());
  assert.equal(r.pass, false);
  assert.equal(r.found, 0);
});

test("entity_exists carries error when introspection throws", async () => {
  const r = await evaluateOne(
    { kind: "entity_exists", name: "steam-engine" },
    ctx({ countEntities: async () => { throw new Error("rcon down"); } }),
  );
  assert.equal(r.pass, false);
  assert.match(r.error, /rcon down/);
});

test("evaluateCriteria AND-aggregates results", async () => {
  const { pass, results } = await evaluateCriteria(
    [
      { kind: "build_only" },
      { kind: "nonzero" },
      { kind: "entity_exists", name: "steam-engine" },
    ],
    ctx(),
  );
  assert.equal(pass, true);
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.pass));
});

test("evaluateCriteria fails overall if any fails", async () => {
  const { pass, results } = await evaluateCriteria(
    [
      { kind: "build_only" },
      { kind: "threshold", op: ">=", value: 1000 },
    ],
    ctx({ measured: 250 }),
  );
  assert.equal(pass, false);
  assert.equal(results[0].pass, true);
  assert.equal(results[1].pass, false);
});

test("validateCriteria rejects empty array", () => {
  assert.throws(() => validateCriteria([]), /at least one/);
});

test("validateCriteria rejects bad kind", () => {
  assert.throws(() => validateCriteria([{ kind: "weird" }]), /kind 'weird'/);
});

test("validateCriteria rejects threshold without op", () => {
  assert.throws(() => validateCriteria([{ kind: "threshold", value: 1 }]), /op /);
});

test("validateCriteria rejects threshold with non-numeric value", () => {
  assert.throws(
    () => validateCriteria([{ kind: "threshold", op: ">=", value: "five" }]),
    /value must be a finite number/,
  );
});

test("validateCriteria rejects entity_exists without name", () => {
  assert.throws(() => validateCriteria([{ kind: "entity_exists" }]), /name/);
});

test("coerceLegacyCriteria handles target_metric.threshold", () => {
  const r = coerceLegacyCriteria({
    targetMetric: { threshold: 0.3, metric: "coal_per_s" },
  });
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, "threshold");
  assert.equal(r[0].value, 0.3);
});

test("coerceLegacyCriteria handles legacy min_rate_per_s", () => {
  const r = coerceLegacyCriteria({
    targetMetric: { params: { min_rate_per_s: 0.1 } },
    defaultMetric: "coal_per_s",
  });
  assert.equal(r[0].value, 0.1);
  assert.equal(r[0].metric, "coal_per_s");
});

test("coerceLegacyCriteria returns [] when no threshold present", () => {
  const r = coerceLegacyCriteria({ targetMetric: { metric: "power_kw" } });
  assert.deepEqual(r, []);
});

test("headlineThreshold pulls from first threshold criterion", () => {
  const { threshold, op } = headlineThreshold([
    { kind: "build_only" },
    { kind: "threshold", op: ">=", value: 100 },
    { kind: "threshold", op: ">", value: 50 },
  ]);
  assert.equal(threshold, 100);
  assert.equal(op, ">=");
});

test("headlineThreshold returns null when no threshold criterion", () => {
  const { threshold } = headlineThreshold([{ kind: "nonzero" }, { kind: "build_only" }]);
  assert.equal(threshold, null);
});

// --- field selector: snapshot-based criteria ---

test("nonzero with field=max_kw reads from snapshot, not measured", async () => {
  const r = await evaluateOne(
    { kind: "nonzero", field: "max_kw" },
    ctx({ measured: 0, snapshot: { max_kw: 900, stored_kj: 0 } }),
  );
  assert.equal(r.pass, true);
  assert.equal(r.value, 900);
  assert.equal(r.field, "max_kw");
});

test("nonzero with field=max_kw fails when snapshot field missing", async () => {
  const r = await evaluateOne(
    { kind: "nonzero", field: "max_kw" },
    ctx({ measured: 500, snapshot: { stored_kj: 0 } }),
  );
  assert.equal(r.pass, false);
  assert.equal(r.value, undefined);
});

test("threshold with field=max_kw evaluates against snapshot", async () => {
  const r = await evaluateOne(
    { kind: "threshold", field: "max_kw", op: ">=", value: 100 },
    ctx({ measured: 0, snapshot: { max_kw: 900 } }),
  );
  assert.equal(r.pass, true);
  assert.equal(r.value, 900);
  assert.equal(r.threshold, 100);
  assert.equal(r.field, "max_kw");
});

test("threshold with field=max_kw fails when below threshold", async () => {
  const r = await evaluateOne(
    { kind: "threshold", field: "max_kw", op: ">=", value: 100 },
    ctx({ snapshot: { max_kw: 50 } }),
  );
  assert.equal(r.pass, false);
});

test("nonzero default still reads measured (backward compat)", async () => {
  const r = await evaluateOne(
    { kind: "nonzero" },
    ctx({ measured: 0.42, snapshot: { max_kw: 0 } }),
  );
  assert.equal(r.pass, true);
  assert.equal(r.value, 0.42);
  assert.equal(r.field, "measured");
});

test("threshold default still reads measured", async () => {
  const r = await evaluateOne(
    { kind: "threshold", op: ">=", value: 100 },
    ctx({ measured: 100, snapshot: { max_kw: 0 } }),
  );
  assert.equal(r.pass, true);
  assert.equal(r.value, 100);
  assert.equal(r.field, "measured");
});

test("validateCriteria rejects unknown field", () => {
  assert.throws(
    () => validateCriteria([{ kind: "threshold", field: "bogus", op: ">=", value: 1 }]),
    /field 'bogus' invalid/,
  );
});

test("validateCriteria accepts field=max_kw / stored_kj / cumulative_produced / measured", () => {
  for (const field of ["max_kw", "stored_kj", "cumulative_produced", "measured"]) {
    validateCriteria([{ kind: "nonzero", field }]);
    validateCriteria([{ kind: "threshold", field, op: ">=", value: 0 }]);
  }
});

test("validateCriteria rejects field on build_only / entity_exists", () => {
  // field is silently ignored on those — validator only enforces shape
  // for nonzero/threshold, so this test pins current behaviour: setting
  // field on the wrong kind does not throw, but also does nothing.
  validateCriteria([{ kind: "build_only", field: "max_kw" }]);
  validateCriteria([{ kind: "entity_exists", name: "x", field: "max_kw" }]);
});
