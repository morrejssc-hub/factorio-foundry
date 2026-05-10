// success-criteria.js — pure evaluators for epoch.success_criteria.
//
// epoch.md may declare:
//
//   success_criteria:
//     - { kind: build_only }                                 # execute phase succeeded
//     - { kind: nonzero, metric: power_kw }                  # measured > 0
//     - { kind: threshold, op: ">=", value: 100, metric: ... } # measured op value
//     - { kind: entity_exists, name: steam-engine, min_count: 1 }
//
//   Or — to evaluate a snapshot field instead of the cumulative-rate
//   `measured` value — pass `field: <snapshot-key>`:
//
//     - { kind: threshold, field: max_kw, op: ">=", value: 100 }
//     - { kind: nonzero, field: stored_kj }
//
//   Allowed snapshot fields are taken from the meter's post-window
//   output (ctx.snapshot): currently max_kw, stored_kj,
//   cumulative_produced. The default `field: "measured"` keeps the
//   legacy path that reads ctx.measured.
//
// `metric` defaults to the meter's primary metric. `min_count` defaults to 1.
//
// The runner calls `evaluateCriteria` AFTER the meter script has produced
// `measured`. For criteria that need world introspection beyond the meter
// script (entity_exists), we accept a callback so the verify/observe module
// can inject its rcon-bound entity counter without this file knowing about
// rcon.
//
// Backward compatibility: when an epoch has no success_criteria but a
// legacy `target_metric.threshold` (or `min_rate_per_s` / `min_power_kw`),
// `coerceLegacyCriteria` synthesises a single `threshold` criterion so the
// downstream verdict shape is uniform.

const KINDS = new Set(["build_only", "nonzero", "threshold", "entity_exists"]);
const OPS = new Set([">=", ">", "<=", "<", "==", "!="]);
const SNAPSHOT_FIELDS = new Set(["max_kw", "stored_kj", "cumulative_produced"]);

function compare(op, a, b) {
  switch (op) {
    case ">=": return a >= b;
    case ">":  return a >  b;
    case "<=": return a <= b;
    case "<":  return a <  b;
    case "==": return a === b;
    case "!=": return a !== b;
    default: throw new Error(`unsupported op '${op}'`);
  }
}

function readField(c, ctx) {
  if (!c.field || c.field === "measured") return ctx.measured;
  if (ctx.snapshot && ctx.snapshot[c.field] !== undefined) return ctx.snapshot[c.field];
  return undefined;
}

export function validateCriteria(criteria) {
  if (!Array.isArray(criteria)) throw new Error("success_criteria must be an array");
  if (criteria.length === 0) throw new Error("success_criteria must declare at least one criterion");
  for (const [i, c] of criteria.entries()) {
    if (!c || typeof c !== "object") throw new Error(`success_criteria[${i}] must be an object`);
    if (!KINDS.has(c.kind)) {
      throw new Error(`success_criteria[${i}].kind '${c.kind}' invalid (allowed: ${[...KINDS].join(", ")})`);
    }
    if (c.kind === "threshold") {
      if (!OPS.has(c.op)) throw new Error(`success_criteria[${i}].op '${c.op}' invalid (allowed: ${[...OPS].join(", ")})`);
      if (typeof c.value !== "number" || !Number.isFinite(c.value)) {
        throw new Error(`success_criteria[${i}].value must be a finite number`);
      }
    }
    if ((c.kind === "nonzero" || c.kind === "threshold") && c.field !== undefined) {
      if (typeof c.field !== "string" || !c.field) {
        throw new Error(`success_criteria[${i}].field must be a non-empty string when set`);
      }
      if (c.field !== "measured" && !SNAPSHOT_FIELDS.has(c.field)) {
        throw new Error(`success_criteria[${i}].field '${c.field}' invalid (allowed: measured, ${[...SNAPSHOT_FIELDS].join(", ")})`);
      }
    }
    if (c.kind === "entity_exists") {
      if (typeof c.name !== "string" || !c.name) {
        throw new Error(`success_criteria[${i}].name must be a non-empty string`);
      }
      if (c.min_count !== undefined && (!Number.isInteger(c.min_count) || c.min_count < 1)) {
        throw new Error(`success_criteria[${i}].min_count must be a positive integer`);
      }
    }
  }
}

/**
 * Translate legacy threshold-style target_metric into a single-criterion
 * array so the runner can use one code path.
 */
export function coerceLegacyCriteria({ targetMetric, defaultMetric }) {
  const tm = targetMetric || {};
  const params = tm.params || {};
  const value = tm.threshold ?? params.min_rate_per_s ?? params.min_power_kw;
  if (typeof value !== "number") {
    // No legacy threshold either — caller should default to nonzero or
    // raise. We return [] to let the caller decide.
    return [];
  }
  return [{
    kind: "threshold",
    op: ">=",
    value,
    metric: tm.metric ?? defaultMetric ?? null,
  }];
}

/**
 * Evaluate one criterion. Returns { kind, pass, ... details }.
 *
 * @param {object} c               — the criterion spec
 * @param {object} ctx
 * @param {number|null} ctx.measured — the meter script's measured value
 * @param {string|null} ctx.metric  — the metric label
 * @param {boolean} ctx.executeOk   — whether the execute phase succeeded
 * @param {(name: string) => Promise<number>} ctx.countEntities
 *        — async fn returning a count of `name` entities on nauvis;
 *          required for entity_exists; may throw if introspection fails.
 */
export async function evaluateOne(c, ctx) {
  switch (c.kind) {
    case "build_only":
      return { kind: c.kind, pass: !!ctx.executeOk };

    case "nonzero": {
      const v = readField(c, ctx);
      const pass = typeof v === "number" && Number.isFinite(v) && v > 0;
      return {
        kind: c.kind,
        field: c.field ?? "measured",
        metric: c.metric ?? ctx.metric ?? null,
        value: v,
        pass,
      };
    }

    case "threshold": {
      const v = readField(c, ctx);
      const pass = typeof v === "number" && Number.isFinite(v) && compare(c.op, v, c.value);
      return {
        kind: c.kind,
        field: c.field ?? "measured",
        metric: c.metric ?? ctx.metric ?? null,
        op: c.op,
        threshold: c.value,
        value: v,
        pass,
      };
    }

    case "entity_exists": {
      const minCount = c.min_count ?? 1;
      let found = 0, error = null;
      try { found = await ctx.countEntities(c.name); }
      catch (err) { error = err.message; }
      return {
        kind: c.kind,
        name: c.name,
        min_count: minCount,
        found,
        pass: error === null && found >= minCount,
        ...(error ? { error } : {}),
      };
    }

    default:
      throw new Error(`unsupported criterion kind '${c.kind}'`);
  }
}

/**
 * Evaluate all criteria and return aggregate verdict block.
 *
 * @returns {Promise<{pass: boolean, results: Array<object>}>}
 */
export async function evaluateCriteria(criteria, ctx) {
  validateCriteria(criteria);
  const results = [];
  for (const c of criteria) {
    results.push(await evaluateOne(c, ctx));
  }
  return { pass: results.every((r) => r.pass), results };
}

/**
 * Pull the "headline" measurement for legacy callers that still want a
 * single threshold field on the verdict (run-summary etc.). Returns
 * { threshold, op } from the first threshold-kind criterion, or nulls.
 */
export function headlineThreshold(criteria) {
  const t = (criteria || []).find((c) => c.kind === "threshold");
  if (!t) return { threshold: null, op: null };
  return { threshold: t.value, op: t.op };
}
