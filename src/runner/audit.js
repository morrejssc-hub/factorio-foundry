// audit.js — deterministic verdict generator. Loads the audit script
// referenced by the epoch's target_metric, runs it via RCON before and
// after a tick window, computes the rate delta, and compares against the
// threshold.
//
// Critical invariant: this module never invokes `pi`. Auditor must be
// deterministic so the multi-branch and multi-run comparisons are valid.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { rconExec, buildLuaCommand } from "../rcon.js";

const TICKS_PER_SECOND = 60;

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
  if (parsed.ok === false) {
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

/**
 * @param {object} args
 * @param {object} args.config         — loaded foundry config
 * @param {object} args.targetMetric   — { audit: <relpath>, params: {item, min_rate_per_s, window_ticks} }
 * @param {string} args.outDir         — plans/<run>/ directory; audit.json is written here
 * @returns {Promise<{pass: boolean, measured: number, threshold: number, details: object}>}
 */
export async function runAudit({ config, targetMetric, outDir }) {
  const scriptPath = resolve(config.rootDir, targetMetric.audit);
  const params = targetMetric.params || {};
  const item = params.item || "coal";
  const windowTicks = params.window_ticks ?? 3600;
  const minRatePerS = params.min_rate_per_s ?? 0;

  const before = await rconRunScript({ config, scriptPath, params });
  await waitTicks({ config, ticks: windowTicks });
  const after = await rconRunScript({ config, scriptPath, params });

  const tickDelta = after.tick - before.tick;
  const producedDelta = after.cumulative_produced - before.cumulative_produced;
  const seconds = tickDelta / TICKS_PER_SECOND;
  const measured = seconds > 0 ? producedDelta / seconds : 0;
  const pass = measured >= minRatePerS;

  const verdict = {
    pass,
    item,
    measured,
    threshold: minRatePerS,
    window_ticks_requested: windowTicks,
    window_ticks_actual: tickDelta,
    seconds_actual: seconds,
    produced_delta: producedDelta,
    before,
    after,
    audit_script: targetMetric.audit,
    timestamp: new Date().toISOString(),
  };
  await mkdir(dirname(resolve(outDir, "audit.json")), { recursive: true });
  await writeFile(resolve(outDir, "audit.json"), JSON.stringify(verdict, null, 2), "utf8");
  return verdict;
}
