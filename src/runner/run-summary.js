// run-summary.js — render a runDir into a human-readable markdown summary.
// Primary input is `<runDir>/run-meta.json` (written by epoch.js). When the
// meta file is absent (e.g. an older run from before observability landed,
// or a partial run), falls back to scanning the on-disk artefacts directly.
//
// Output: `<runDir>/summary.md`. The library function returns the meta
// object it rendered from so callers can introspect totals.
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

async function readJsonOrNull(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return null; }
}

async function readYamlOrNull(path) {
  try { return parseYaml(await readFile(path, "utf8")); }
  catch { return null; }
}

async function exists(path) {
  try { await stat(path); return true; }
  catch { return false; }
}

/**
 * Reconstruct a meta-shaped object by scanning a runDir when run-meta.json
 * is missing. Best-effort: missing files surface as nulls / zeros rather
 * than failing the render. Handles both flat and attempt-N layouts.
 */
async function scanRunDir(runDir) {
  const probeTrace = await readJsonOrNull(join(runDir, "probe", "pi-trace.json"));
  const probeState = await readYamlOrNull(join(runDir, "probe", "state.yaml"));
  const probe = {
    cache_hit: !!probeTrace?.cache_hit,
    wall_ms: probeTrace?.wall_ms ?? 0,
    usage: probeTrace?.usage ?? null,
    cost_usd: probeTrace?.cost?.total ?? 0,
    model: probeTrace?.model ?? null,
    provider: probeTrace?.provider ?? null,
    schema_retry: !!probeTrace?.schema_retry,
    state_tick: probeState?.tick ?? null,
  };

  // Detect layout: if attempt-1/ exists, it's multi-attempt; otherwise flat.
  const entries = await readdir(runDir);
  const attemptDirs = entries.filter((e) => /^attempt-\d+$/.test(e)).sort((a, b) => {
    const na = parseInt(a.split("-")[1], 10);
    const nb = parseInt(b.split("-")[1], 10);
    return na - nb;
  });

  const attempts = [];
  const totals = { wall_ms: probe.wall_ms, tokens: probeTrace?.usage?.totalTokens ?? 0, cost_usd: probe.cost_usd };
  if (attemptDirs.length > 0) {
    for (const ad of attemptDirs) {
      const attemptNum = parseInt(ad.split("-")[1], 10);
      const attemptDir = join(runDir, ad);
      attempts.push(await scanAttempt(attemptDir, attemptNum, totals));
    }
  } else if (await exists(join(runDir, "design"))) {
    // Flat layout: single attempt.
    attempts.push(await scanAttempt(runDir, 1, totals));
  }

  const lastVerdict = [...attempts].reverse().find((a) => a.verify ?? a.observe)?.verify
    ?? [...attempts].reverse().find((a) => a.observe)?.observe ?? null;
  const winningAttempt = attempts.find((a) => (a.verify ?? a.observe)?.pass);

  return {
    epoch: null,                          // unknown without run-meta
    ok: !!winningAttempt,
    input_save: null,
    output_save: null,
    max_attempts: Math.max(attempts.length, 1),
    actual_attempts: attempts.length,
    probe,
    attempts,
    final_verdict: lastVerdict ? {
      pass: lastVerdict.pass,
      item: lastVerdict.item,
      measured: lastVerdict.measured,
      threshold: lastVerdict.threshold,
    } : null,
    totals,
  };
}

async function scanAttempt(attemptDir, attemptNum, totals) {
  // When run-meta.json is missing we synthesize the meta from what's on disk.
  // verify.json (under execute/) carries pass/measured/threshold + savePath
  // since the snapshot/rollback flip; observe.json on the clean post-execute
  // world adds the no-harness comparison number.
  const observe = await readJsonOrNull(join(attemptDir, "observe.json"));
  const dry = await readJsonOrNull(join(attemptDir, "dry-validate.json"));
  const verify = await readJsonOrNull(join(attemptDir, "execute", "verify.json"));
  const designTrace = await readJsonOrNull(join(attemptDir, "design", "pi-trace.json"));
  const plan = await readYamlOrNull(join(attemptDir, "design", "plan.yaml"));
  const wall = designTrace?.wall_ms ?? 0;
  const cost = designTrace?.cost?.total ?? 0;
  const tokens = designTrace?.usage?.totalTokens ?? 0;
  totals.wall_ms += wall;
  totals.cost_usd += cost;
  totals.tokens += tokens;
  return {
    attempt: attemptNum,
    design: {
      placements: plan?.placements?.length ?? null,
      authored: [],                       // unknown without run-meta
      wall_ms: wall,
      usage: designTrace?.usage ?? null,
      cost_usd: cost,
      model: designTrace?.model ?? null,
      provider: designTrace?.provider ?? null,
      schema_retry: !!designTrace?.schema_retry,
      previous_attempts: designTrace?.previous_attempts ?? 0,
    },
    dry_validate: dry ? { ok: dry.ok, errors: dry.errors ?? [] } : null,
    execute: verify ? { ok: verify.pass, save_path: verify.savePath ?? null } : null,
    verify: verify ? {
      pass: verify.pass,
      measured: verify.measured,
      threshold: verify.threshold,
      item: verify.item,
      seconds_actual: verify.seconds_actual,
      produced_delta: verify.produced_delta,
    } : null,
    observe: observe ? {
      pass: observe.pass,
      measured: observe.measured,
      threshold: observe.threshold,
      item: observe.item,
      seconds_actual: observe.seconds_actual,
      produced_delta: observe.produced_delta,
    } : null,
    error: null,
  };
}

function fmtMs(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`;
}

function fmtUSD(n) {
  if (!n) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n) {
  if (!n) return "0";
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtNumber(n, digits = 4) {
  if (n === null || n === undefined) return "—";
  if (typeof n !== "number") return String(n);
  return n.toFixed(digits);
}

function statusBadge(ok, hasVerdict) {
  if (ok) return "✅ pass";
  if (!hasVerdict) return "⚠ no verdict";
  return "❌ fail";
}

function trajectoryLine(attempts) {
  if (attempts.length === 0) return null;
  const placements = attempts.map((a) => a.design.placements ?? "?").join(" → ");
  const verdictOf = (a) => a.verify ?? a.observe;
  const measured = attempts.map((a) => verdictOf(a) ? verdictOf(a).measured.toFixed(2) : "—").join(" → ");
  const final = attempts[attempts.length - 1];
  const verdict = verdictOf(final)?.pass ? "converged" : "all failed";
  return `${attempts.length} attempts: placements ${placements}; measured ${measured}. (${verdict})`;
}

function renderMarkdown(meta) {
  const lines = [];
  lines.push(`# Epoch ${meta.epoch ?? "(unknown)"} — ${statusBadge(meta.ok, !!meta.final_verdict)}`);
  lines.push("");
  if (meta.final_verdict) {
    const v = meta.final_verdict;
    lines.push(`- **final**: ${v.item} ${fmtNumber(v.measured)}/s vs threshold ${fmtNumber(v.threshold)}`);
  }
  if (meta.input_save) lines.push(`- **input_save**: \`${meta.input_save}\``);
  if (meta.output_save) lines.push(`- **output_save**: \`${meta.output_save}\``);
  lines.push(`- **attempts**: ${meta.actual_attempts} / ${meta.max_attempts}`);
  const probeLabel = meta.probe.cache_hit
    ? `cache hit (${fmtMs(meta.probe.wall_ms)})`
    : `${fmtMs(meta.probe.wall_ms)} · ${fmtTokens(meta.probe.usage?.totalTokens ?? 0)} tok · ${fmtUSD(meta.probe.cost_usd)}`;
  lines.push(`- **probe**: ${probeLabel}`);
  lines.push(`- **totals**: ${fmtMs(meta.totals.wall_ms)} · ${fmtTokens(meta.totals.tokens)} tok · ${fmtUSD(meta.totals.cost_usd)}`);
  lines.push("");

  if (meta.attempts.length > 0) {
    lines.push("## Attempts");
    lines.push("");
    lines.push("| # | placements | authored | dry-validate | measured | pass | tokens | $ | wall |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const a of meta.attempts) {
      const v = a.verify ?? a.observe;
      const dryCell = a.dry_validate ? (a.dry_validate.ok ? "ok" : `fail: ${a.dry_validate.errors.join("; ").slice(0, 40)}`) : "—";
      const measuredCell = v ? `${fmtNumber(v.measured)} / ${fmtNumber(v.threshold)}` : (a.error ? `pre-verify fail` : "—");
      const passCell = v ? (v.pass ? "✅" : "❌") : (a.error ? "💥" : "—");
      const authoredCell = a.design.authored?.length ? a.design.authored.join(", ") : "—";
      lines.push([
        "",
        a.attempt,
        a.design.placements ?? "—",
        authoredCell,
        dryCell,
        measuredCell,
        passCell,
        fmtTokens(a.design.usage?.totalTokens ?? 0),
        fmtUSD(a.design.cost_usd),
        fmtMs(a.design.wall_ms),
        "",
      ].join(" | ").trim());
    }
    lines.push("");
    const traj = trajectoryLine(meta.attempts);
    if (traj) {
      lines.push("## Trajectory");
      lines.push("");
      lines.push(traj);
      lines.push("");
    }
  }
  return lines.join("\n");
}

/**
 * Public API: render a runDir into <runDir>/summary.md and return the meta
 * object that was rendered. Reads run-meta.json (preferred) or falls back to
 * filesystem scan. Idempotent — safe to invoke many times.
 *
 * @param {string} runDir absolute path to the run directory
 * @returns {Promise<{meta: object, markdownPath: string}>}
 */
export async function writeSummary(runDir) {
  let meta = await readJsonOrNull(join(runDir, "run-meta.json"));
  if (!meta) {
    meta = await scanRunDir(runDir);
  }
  await mkdir(runDir, { recursive: true });
  const markdown = renderMarkdown(meta);
  const markdownPath = join(runDir, "summary.md");
  await writeFile(markdownPath, markdown, "utf8");
  return { meta, markdownPath };
}

export { renderMarkdown, scanRunDir };
