// audit.js — deterministic verdict generator. Reads the audit script
// referenced by the epoch's target_metric, runs it via RCON before and
// after a tick window, derives `measured` per the module's aggregate
// strategy, then evaluates each `epoch.success_criteria` entry against
// the world.
//
// Critical invariant: this module never invokes `pi`. Auditor must be
// deterministic so the multi-branch and multi-run comparisons are valid.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { rconExec, buildLuaCommand } from "../rcon.js";
import { resolveAudit } from "./audit-resolver.js";
import {
  evaluateCriteria, validateCriteria, coerceLegacyCriteria, headlineThreshold,
} from "./success-criteria.js";

const TICKS_PER_SECOND = 60;
const ENTITY_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

async function rconCountEntities(config) {
  const command = `/silent-command rcon.print(#game.surfaces[1].find_entities())`;
  const body = await rconExec({
    host: config.rconHost, port: config.rconPort,
    password: config.rconPassword, command, timeoutMs: 10000,
  });
  return parseInt(body.trim(), 10) || 0;
}

async function rconCountEntitiesByName({ config, name, surface = "nauvis" }) {
  // Reject anything that doesn't look like a Factorio prototype id so we
  // can't be tricked into injecting Lua via a crafted criterion name.
  if (!ENTITY_NAME_RE.test(name)) {
    throw new Error(`refusing to query entity name with unsafe chars: ${JSON.stringify(name)}`);
  }
  if (!ENTITY_NAME_RE.test(surface)) {
    throw new Error(`refusing to query surface with unsafe chars: ${JSON.stringify(surface)}`);
  }
  const command = `/silent-command rcon.print(#game.surfaces["${surface}"].find_entities_filtered{name="${name}"})`;
  const body = await rconExec({
    host: config.rconHost, port: config.rconPort,
    password: config.rconPassword, command, timeoutMs: 10000,
  });
  const n = parseInt(body.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

async function rconRunScript({ config, scriptPath, params }) {
  const lua = await readFile(scriptPath, "utf8");
  const command = buildLuaCommand(scriptPath.split("/").pop(), lua, params);
  const body = await rconExec({
    host: config.rconHost,
    port: config.rconPort,
    password: config.rconPassword,
    command,
    timeoutMs: 15000,
  });
  let parsed;
  try {
    parsed = JSON.parse(body.trim());
  } catch (error) {
    throw new Error(`audit script returned non-JSON: ${body.slice(0, 200)}`);
  }
  // `ok` semantics: true ⇒ the snapshot read succeeded. The runner — not
  // the script — decides pass/fail via success_criteria. Some authored
  // scripts conflate ok with "passes threshold" (e.g. set ok = measured
  // >= min_kw); when that happens we still have a valid `measured`, so
  // accept the read instead of treating it as a script error.
  if (parsed.ok === false && typeof parsed.measured !== "number" && typeof parsed.cumulative_produced !== "number") {
    throw new Error(`audit script failed: ${parsed.error || "unknown"}`);
  }
  return parsed;
}

async function waitTicks({ config, ticks }) {
  // Use the factorio-server HTTP /tool/factorio_action wait_ticks endpoint
  // so the Factorio process advances simulation time while we wait.
  const timeoutMs = Math.ceil((ticks / TICKS_PER_SECOND) * 1000) + 60_000;
  const response = await fetch(`${config.serviceUrl}/tool/factorio_action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "wait_ticks", ticks }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(`wait_ticks failed: ${payload.error || response.statusText}`);
  }
  return payload.result;
}

function readMeasured(snapshot) {
  if (typeof snapshot.measured === "number") return snapshot.measured;
  if (typeof snapshot.cumulative_produced === "number") return snapshot.cumulative_produced;
  throw new Error("audit script must return numeric `measured` (or legacy `cumulative_produced`)");
}

/**
 * @param {object} args
 * @param {object} args.config         — loaded foundry config
 * @param {object} args.targetMetric   — see audit-resolver.js for the 3 supported shapes
 * @param {Array<object>} [args.successCriteria] — epoch.success_criteria; if absent,
 *        a legacy `target_metric.threshold` is auto-converted to a single
 *        threshold criterion. If neither is present we fall back to a
 *        `nonzero` criterion so the verdict shape stays uniform.
 * @param {string} args.outDir         — plans/<run>/ directory; audit.json is written here
 * @param {Map<string, object>} [args.modules]  — module map (lib + staged); required for module-driven shapes
 * @param {object} [args.plan]         — plan.yaml object; required for goal-only metric shape
 * @param {string} [args.stagedDir]    — candidate's staged-modules/ for resolving in-flight audit lua
 * @returns {Promise<object>}
 */
export async function runAudit({
  config, targetMetric, outDir, modules, plan, stagedDir, successCriteria,
}) {
  const resolved = resolveAudit({
    targetMetric, modules, plan, stagedDir,
    rootDir: config.rootDir,
  });
  const { scriptPath, params, aggregate, metric, item, moduleId, auditId } = resolved;
  const windowTicks = params.window_ticks ?? 3600;

  const criteria = (successCriteria && successCriteria.length > 0)
    ? successCriteria
    : (coerceLegacyCriteria({ targetMetric, defaultMetric: metric }).length > 0
        ? coerceLegacyCriteria({ targetMetric, defaultMetric: metric })
        : [{ kind: "nonzero", metric }]);
  validateCriteria(criteria);

  const auditStart = Date.now();
  let before = null, after;
  if (aggregate === "snapshot_post") {
    await waitTicks({ config, ticks: windowTicks });
    after = await rconRunScript({ config, scriptPath, params });
  } else {
    before = await rconRunScript({ config, scriptPath, params });
    await waitTicks({ config, ticks: windowTicks });
    after = await rconRunScript({ config, scriptPath, params });
  }
  const wall_clock_ms = Date.now() - auditStart;
  const entity_count = await rconCountEntities(config).catch(() => null);

  const tickDelta = before ? (after.tick - before.tick) : windowTicks;
  const seconds = tickDelta / TICKS_PER_SECOND;

  let measured, producedDelta = null;
  if (aggregate === "rate_from_cumulative") {
    producedDelta = readMeasured(after) - readMeasured(before);
    measured = seconds > 0 ? producedDelta / seconds : 0;
  } else if (aggregate === "snapshot_post") {
    measured = readMeasured(after);
  } else if (aggregate === "snapshot_avg") {
    measured = (readMeasured(before) + readMeasured(after)) / 2;
  } else {
    throw new Error(`unsupported aggregate: ${aggregate}`);
  }

  const ctx = {
    measured,
    metric,
    snapshot: after || null,
    executeOk: true, // we only reach audit if execute didn't throw
    countEntities: (name) => rconCountEntitiesByName({ config, name }),
  };
  const { pass, results: criteriaResults } = await evaluateCriteria(criteria, ctx);

  // Headline threshold (legacy field) — pulled from the first
  // threshold-kind criterion if any, so summary tooling that reads
  // verdict.threshold keeps working.
  const { threshold } = headlineThreshold(criteria);

  const verdict = {
    pass,
    item,
    metric,
    measured,
    threshold,
    aggregate,
    criteria: criteriaResults,
    window_ticks_requested: windowTicks,
    window_ticks_actual: tickDelta,
    seconds_actual: seconds,
    produced_delta: producedDelta,
    wall_clock_ms,
    entity_count,
    before,
    after,
    audit_script: resolved.scriptRel,
    module_id: moduleId,
    audit_id: auditId,
    timestamp: new Date().toISOString(),
  };
  await mkdir(dirname(resolve(outDir, "audit.json")), { recursive: true });
  await writeFile(resolve(outDir, "audit.json"), JSON.stringify(verdict, null, 2), "utf8");
  return verdict;
}
