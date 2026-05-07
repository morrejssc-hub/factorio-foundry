// pi-trace.js — small helpers for accumulating piInvoke() results into a
// per-phase trace, then writing it as `<phaseDir>/pi-trace.json`. Used by
// probe.js and design.js (the only phases that call pi). The trace records
// usage, cost, wall_ms, model/provider, and per-call counts. The full event
// stream is intentionally NOT persisted; pi-invoke summaries are enough.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Create an empty trace for a phase. `extra` is merged onto the trace at
 * write time (e.g. `{previous_attempts: 2}` for design phase retries).
 */
export function newTrace(phase, extra = {}) {
  return {
    phase,
    wall_ms: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    model: null,
    provider: null,
    turns: 0,
    invocations: 0,
    schema_retry: false,
    cache_hit: false,
    ...extra,
  };
}

/**
 * Fold one piInvoke() result into a trace. Safe to call multiple times for
 * the schema-retry path — usage and cost accumulate, model/provider take
 * the latest non-null value.
 */
export function addPiCall(trace, piResult) {
  if (!piResult) return;
  trace.invocations += 1;
  trace.wall_ms += piResult.wall_ms ?? 0;
  trace.turns += piResult.turns ?? 0;
  if (piResult.model) trace.model = piResult.model;
  if (piResult.provider) trace.provider = piResult.provider;
  for (const k of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
    trace.usage[k] += piResult.usage?.[k] ?? 0;
  }
  for (const k of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
    trace.cost[k] += piResult.cost?.[k] ?? 0;
  }
}

/**
 * Write `<phaseDir>/pi-trace.json` (pretty-printed). Non-fatal on failure —
 * observability should never block the actual phase return.
 */
export async function writePiTrace(phaseDir, trace) {
  try {
    await writeFile(join(phaseDir, "pi-trace.json"), JSON.stringify(trace, null, 2), "utf8");
  } catch (error) {
    console.log(`[pi-trace] write failed (non-fatal): ${error.message}`);
  }
}
