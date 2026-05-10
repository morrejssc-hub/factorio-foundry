// meter-resolver.js — single resolver shared by runObserve (observe phase)
// and runVerify (verify phase). Translates an epoch's `target_metric` into
// a concrete {scriptPath, params, aggregate, metric, threshold, item}
// record by consulting the modules map (lib + staged) when needed.
//
// Three target_metric shapes are supported:
//
//   1. Legacy direct path:
//        target_metric:
//          meter: lib/meters/throughput-window.lua
//          params: { item: coal, min_rate_per_s: 0.1, window_ticks: 3600 }
//
//   2. Module-driven (mature modules with an established meter):
//        target_metric:
//          module: coal-burner-cell
//          meter_id: coal-burner-cell-throughput   # optional, defaults to first
//          params: { window_ticks: 3600 }          # override default_params
//          threshold: 0.3
//
//   3. Goal-only (module-creation epochs — Designer authors the meter):
//        target_metric:
//          metric: power_kw                        # required
//          threshold: 100
//          params: { window_ticks: 3600 }
//      The resolver scans plan.placements → modules → meters, picks the
//      single meter whose `metric` matches, and complains if 0 or >1 match.
//
// Each meters[] entry on a module declares EITHER `script: <path>` (legacy
// per-module Lua) OR `port: <port-name>` (unified port-meter dispatcher).
// When the resolver picks a meter with `port:`, it computes the world
// port_position from the placement + module port rel_pos, hard-codes
// scriptPath = lib/meters/port-meter.lua, and packs port_kind + item into
// params for the meter to switch on.
//
// The resolver is intentionally pure/deterministic — given the same inputs
// it always picks the same script path. No I/O beyond resolve().
import { resolve, isAbsolute } from "node:path";
import { rotateRelPos } from "./execute.js";

const VALID_AGGREGATES = new Set(["rate_from_cumulative", "snapshot_post", "snapshot_avg"]);
const PORT_METER_REL = "lib/meters/port-meter.lua";

function resolveScriptPath({ scriptRel, module, rootDir, stagedDir }) {
  if (isAbsolute(scriptRel)) return scriptRel;
  // Staged path: a module being authored references its in-flight meter lua
  // sitting in plans/<run>/candidates/cN/staged-modules/. After promotion the
  // module yaml is rewritten to point at lib/meters/<basename>.lua, so this
  // branch only fires for not-yet-promoted (staged) modules.
  if (scriptRel.startsWith("staged-modules/")) {
    if (!stagedDir) {
      throw new Error(`meter script '${scriptRel}' lives in staged-modules/ but no stagedDir was provided`);
    }
    const basename = scriptRel.slice("staged-modules/".length);
    return resolve(stagedDir, basename);
  }
  // Anything else (lib/meters/..., scripts/...) resolves against rootDir.
  return resolve(rootDir, scriptRel);
}

function pickMeterFromModule(module, { meterId, metric }) {
  const meters = Array.isArray(module.meters) ? module.meters : [];
  if (meters.length === 0) {
    throw new Error(`module '${module.id}' declares no meters[]`);
  }
  if (meterId) {
    const found = meters.find((m) => m.id === meterId);
    if (!found) throw new Error(`module '${module.id}' has no meter with id '${meterId}'`);
    return found;
  }
  if (metric) {
    const matches = meters.filter((m) => m.metric === metric);
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
      throw new Error(`module '${module.id}' has no meter with metric '${metric}'`);
    }
    throw new Error(`module '${module.id}' has ${matches.length} meters with metric '${metric}' — disambiguate with meter_id`);
  }
  return meters[0];
}

function findModuleByMetric(plan, modules, metric) {
  const placements = plan?.placements || [];
  const matches = [];
  for (const p of placements) {
    const mod = modules.get(p.module);
    if (!mod) continue;
    const meters = Array.isArray(mod.meters) ? mod.meters : [];
    if (meters.some((m) => m.metric === metric)) {
      if (!matches.find((m) => m.id === mod.id)) matches.push(mod);
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(`no placed module declares a meter with metric '${metric}'`);
  }
  throw new Error(`${matches.length} placed modules declare meters with metric '${metric}' — disambiguate target_metric with module:<id>`);
}

function findPlacementByModule(plan, moduleId) {
  const placements = (plan?.placements || []).filter((p) => p.module === moduleId);
  if (placements.length === 0) {
    throw new Error(`port-meter needs a placement of module '${moduleId}' in plan, but none found`);
  }
  if (placements.length > 1) {
    throw new Error(
      `port-meter on module '${moduleId}' is ambiguous: ${placements.length} placements in plan ` +
      `(p${placements.map((p) => p.id ?? "?").join(", p")}). V1 supports a single placement per metered module.`,
    );
  }
  return placements[0];
}

function findPortOnModule(module, portName) {
  const port = [...(module.inputs || []), ...(module.outputs || [])].find((p) => p.name === portName);
  if (!port) {
    throw new Error(`module '${module.id}' has no port named '${portName}' (meter references it)`);
  }
  return port;
}

/**
 * Build the resolver result for a meter entry that uses `port:` instead
 * of `script:`. Hard-codes scriptPath to the unified port-meter and packs
 * port_kind + port_position + item/fluid into params.
 */
function resolvePortMeter({ module, meter, tm, plan, rootDir }) {
  if (!plan) {
    throw new Error(`meter '${meter.id}' on module '${module.id}' uses port: but no plan was provided`);
  }
  const placement = findPlacementByModule(plan, module.id);
  const port = findPortOnModule(module, meter.port);
  const [dx, dy] = port.rel_pos;
  const rotated = rotateRelPos(dx, dy, placement.direction);
  const portWorld = {
    x: placement.anchor.x + rotated.x,
    y: placement.anchor.y + rotated.y,
  };
  // Param merge order: meter.params (defaults) ⊕ tm.params (epoch overrides)
  // ⊕ port-derived (port_kind, port_position, item/fluid) — port-derived
  // wins so the dispatcher always switches on the port's declared kind.
  const portParams = {
    port_kind: port.kind,
    port_position: portWorld,
  };
  if (port.kind === "belt") portParams.item = port.item;
  if (port.kind === "pipe") portParams.fluid = port.item;
  const params = { ...(meter.params || {}), ...(tm.params || {}), ...portParams };
  const aggregate = meter.aggregate || "rate_from_cumulative";
  if (!VALID_AGGREGATES.has(aggregate)) {
    throw new Error(`module '${module.id}' meter '${meter.id}' has invalid aggregate '${aggregate}'`);
  }
  const threshold = tm.threshold
    ?? params.min_rate_per_s
    ?? params.min_power_kw
    ?? 0;
  return {
    scriptPath: resolve(rootDir, PORT_METER_REL),
    scriptRel: PORT_METER_REL,
    params,
    aggregate,
    metric: meter.metric ?? tm.metric ?? null,
    threshold,
    item: port.kind === "belt" ? port.item : (port.kind === "pipe" ? port.item : null),
    moduleId: module.id,
    meterId: meter.id,
  };
}

/**
 * Resolve a target_metric into a concrete meter invocation record.
 *
 * @param {object} args
 * @param {object} args.targetMetric  — epoch.target_metric (any of 3 shapes)
 * @param {Map<string, object>} [args.modules] — module map (required for shapes 2/3)
 * @param {object} [args.plan]        — plan.yaml object (required for shape 3)
 * @param {string} args.rootDir       — config.rootDir
 * @param {string} [args.stagedDir]   — candidate's staged-modules/ if any
 * @returns {{
 *   scriptPath: string,
 *   scriptRel: string,
 *   params: object,
 *   aggregate: "rate_from_cumulative"|"snapshot_post"|"snapshot_avg",
 *   metric: string|null,
 *   threshold: number,
 *   item: string|null,
 *   moduleId: string|null,
 *   meterId: string|null,
 * }}
 */
export function resolveMeter({ targetMetric, modules, plan, rootDir, stagedDir }) {
  if (!targetMetric || typeof targetMetric !== "object") {
    throw new Error("target_metric missing or not an object");
  }
  const tm = targetMetric;

  // Shape 1: legacy direct path. Aggregate defaults to rate_from_cumulative
  // because every legacy meter (throughput-window.lua) reports a cumulative
  // counter and the Node side computes the delta.
  if (tm.meter && !tm.module && !tm.metric) {
    const params = { ...(tm.params || {}) };
    const threshold = tm.threshold ?? params.min_rate_per_s ?? 0;
    return {
      scriptPath: resolveScriptPath({ scriptRel: tm.meter, rootDir, stagedDir }),
      scriptRel: tm.meter,
      params,
      aggregate: "rate_from_cumulative",
      metric: null,
      threshold,
      item: params.item ?? null,
      moduleId: null,
      meterId: null,
    };
  }

  if (!modules) {
    throw new Error("target_metric.module / target_metric.metric requires a modules map");
  }

  let module, meter;
  if (tm.module) {
    module = modules.get(tm.module);
    if (!module) throw new Error(`target_metric.module '${tm.module}' not found in modules map`);
    meter = pickMeterFromModule(module, { meterId: tm.meter_id, metric: tm.metric });
  } else if (tm.metric) {
    if (!plan) throw new Error("target_metric.metric requires a plan to scan placements");
    module = findModuleByMetric(plan, modules, tm.metric);
    meter = pickMeterFromModule(module, { meterId: tm.meter_id, metric: tm.metric });
  } else {
    throw new Error("target_metric must declare one of: meter, module, metric");
  }

  // Branch: port-meter dispatcher vs legacy per-module script.
  if (meter.port) {
    return resolvePortMeter({ module, meter, tm, plan, rootDir });
  }

  const aggregate = meter.aggregate || "rate_from_cumulative";
  if (!VALID_AGGREGATES.has(aggregate)) {
    throw new Error(`module '${module.id}' meter '${meter.id}' has invalid aggregate '${aggregate}'`);
  }
  // Param merge: meter.params (defaults baked into the module) ⊕ tm.params
  // (epoch overrides). Threshold may live on tm directly or as legacy
  // min_rate_per_s/min_power_kw inside params.
  const params = { ...(meter.params || {}), ...(tm.params || {}) };
  const threshold = tm.threshold
    ?? params.min_rate_per_s
    ?? params.min_power_kw
    ?? 0;

  return {
    scriptPath: resolveScriptPath({ scriptRel: meter.script, module, rootDir, stagedDir }),
    scriptRel: meter.script,
    params,
    aggregate,
    metric: meter.metric ?? tm.metric ?? null,
    threshold,
    item: params.item ?? null,
    moduleId: module.id,
    meterId: meter.id,
  };
}
