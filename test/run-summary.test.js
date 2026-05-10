// run-summary.test.js — fixture-based tests for the summary renderer.
// Three shapes covered: 1-attempt success (flat layout), 3-attempt success
// (multi layout, e6-style), 3-attempt all-fail (e7-style).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeSummary, scanRunDir } from "../src/runner/run-summary.js";

async function makeRunDir() {
  return await mkdtemp(join(tmpdir(), "foundry-summary-test-"));
}

async function writeJson(path, obj) {
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

async function writePiTrace(dir, { wall_ms, tokens, cost, cache_hit = false, schema_retry = false, previous_attempts = 0 }) {
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, "pi-trace.json"), {
    phase: "design",
    wall_ms,
    usage: { input: tokens / 2, output: tokens / 2, cacheRead: 0, cacheWrite: 0, totalTokens: tokens },
    cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
    model: "test-model",
    provider: "test",
    turns: 1,
    invocations: 1,
    schema_retry,
    cache_hit,
    previous_attempts,
  });
}

async function writePlanYaml(dir, placements) {
  const lines = ["epoch: e_test", "placements:"];
  for (let i = 0; i < placements; i++) {
    lines.push(`  - id: p${i}`);
    lines.push(`    module: coal-burner-cell`);
    lines.push(`    anchor: { x: ${i}, y: 0 }`);
    lines.push(`    direction: east`);
  }
  lines.push("connections: []");
  lines.push("expected_throughput: 1.0");
  lines.push("why_not_replicate: test");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "plan.yaml"), lines.join("\n"), "utf8");
}

test("writeSummary renders a 1-attempt success (flat layout, run-meta present)", async () => {
  const runDir = await makeRunDir();
  try {
    const meta = {
      epoch: "e_one",
      ok: true,
      input_save: "/abs/in.zip",
      output_save: "/abs/out.zip",
      max_attempts: 1,
      actual_attempts: 1,
      probe: { cache_hit: false, wall_ms: 38000, usage: { totalTokens: 5000 }, cost_usd: 0.18, model: "m", provider: "p", schema_retry: false },
      attempts: [{
        attempt: 1,
        design: { placements: 1, authored: [], wall_ms: 4200, usage: { totalTokens: 8421 }, cost_usd: 0.04, model: "m", provider: "p", schema_retry: false, previous_attempts: 0 },
        dry_validate: { ok: true, errors: [] },
        execute: { ok: true, save_path: "/abs/out.zip" },
        audit: { pass: true, measured: 0.5, threshold: 0.4, item: "coal", seconds_actual: 60, produced_delta: 30 },
        error: null,
      }],
      final_verdict: { pass: true, item: "coal", measured: 0.5, threshold: 0.4 },
      totals: { wall_ms: 42200, tokens: 13421, cost_usd: 0.22 },
    };
    await writeJson(join(runDir, "run-meta.json"), meta);
    const { markdownPath } = await writeSummary(runDir);
    const md = await readFile(markdownPath, "utf8");
    assert.match(md, /^# Epoch e_one — ✅ pass/m);
    assert.match(md, /\*\*final\*\*: coal 0\.5000\/s vs threshold 0\.4000/);
    assert.match(md, /\*\*attempts\*\*: 1 \/ 1/);
    assert.match(md, /## Attempts/);
    assert.match(md, /\| 1 \| 1 \| — \| ok \| 0\.5000 \/ 0\.4000 \| ✅/);
    assert.match(md, /## Trajectory/);
    assert.match(md, /converged/);
    // No "promoted module" line when authored=[]
    assert.doesNotMatch(md, /promoted/);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("writeSummary renders a 3-attempt success (e6-style trajectory) with totals from per-attempt traces", async () => {
  const runDir = await makeRunDir();
  try {
    const meta = {
      epoch: "e_recovery",
      ok: true,
      input_save: "/in.zip",
      output_save: "/out.zip",
      max_attempts: 3,
      actual_attempts: 3,
      probe: { cache_hit: true, wall_ms: 12, usage: null, cost_usd: 0, model: null, provider: null, schema_retry: false },
      attempts: [
        { attempt: 1, design: { placements: 1, authored: [], wall_ms: 4000, usage: { totalTokens: 8000 }, cost_usd: 0.04, schema_retry: false, previous_attempts: 0 },
          dry_validate: { ok: true, errors: [] }, execute: { ok: true, save_path: "/out.zip" },
          audit: { pass: false, measured: 0.25, threshold: 0.95, item: "coal" }, error: null },
        { attempt: 2, design: { placements: 1, authored: [], wall_ms: 4500, usage: { totalTokens: 8200 }, cost_usd: 0.04, schema_retry: false, previous_attempts: 1 },
          dry_validate: { ok: true, errors: [] }, execute: { ok: true, save_path: "/out.zip" },
          audit: { pass: false, measured: 0.25, threshold: 0.95, item: "coal" }, error: null },
        { attempt: 3, design: { placements: 4, authored: [], wall_ms: 5000, usage: { totalTokens: 9100 }, cost_usd: 0.05, schema_retry: false, previous_attempts: 2 },
          dry_validate: { ok: true, errors: [] }, execute: { ok: true, save_path: "/out.zip" },
          audit: { pass: true, measured: 0.999, threshold: 0.95, item: "coal" }, error: null },
      ],
      final_verdict: { pass: true, item: "coal", measured: 0.999, threshold: 0.95 },
      totals: { wall_ms: 13512, tokens: 25300, cost_usd: 0.13 },
    };
    await writeJson(join(runDir, "run-meta.json"), meta);
    const { markdownPath } = await writeSummary(runDir);
    const md = await readFile(markdownPath, "utf8");
    assert.match(md, /pass$|✅ pass/m);
    assert.match(md, /placements 1 → 1 → 4/);
    assert.match(md, /measured 0\.25 → 0\.25 → 1\.00/);
    assert.match(md, /converged/);
    // Cache hit must be visible.
    assert.match(md, /cache hit/);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("writeSummary renders a 3-attempt all-fail run (e7-style)", async () => {
  const runDir = await makeRunDir();
  try {
    const mkAttempt = (n) => ({
      attempt: n,
      design: { placements: n, authored: [], wall_ms: 4000, usage: { totalTokens: 8000 }, cost_usd: 0.04, schema_retry: false, previous_attempts: n - 1 },
      dry_validate: { ok: true, errors: [] },
      execute: { ok: true, save_path: "/out.zip" },
      audit: { pass: false, measured: 0, threshold: 0.01, item: "iron-ore" },
      error: null,
    });
    const meta = {
      epoch: "e_unreach",
      ok: false,
      input_save: "/in.zip",
      output_save: "/out.zip",
      max_attempts: 3,
      actual_attempts: 3,
      probe: { cache_hit: true, wall_ms: 8, usage: null, cost_usd: 0, schema_retry: false },
      attempts: [mkAttempt(1), mkAttempt(2), mkAttempt(3)],
      final_verdict: { pass: false, item: "iron-ore", measured: 0, threshold: 0.01 },
      totals: { wall_ms: 12008, tokens: 24000, cost_usd: 0.12 },
    };
    await writeJson(join(runDir, "run-meta.json"), meta);
    const { markdownPath } = await writeSummary(runDir);
    const md = await readFile(markdownPath, "utf8");
    assert.match(md, /❌ fail/);
    assert.match(md, /iron-ore/);
    assert.match(md, /all failed/);
    // Three failure rows.
    const failRows = (md.match(/❌/g) || []).length;
    assert.ok(failRows >= 3, `expected at least 3 ❌ rows, got ${failRows}`);
    // No false promotion.
    assert.doesNotMatch(md, /promoted/);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("scanRunDir falls back when run-meta.json absent (multi-attempt layout)", async () => {
  const runDir = await makeRunDir();
  try {
    // probe
    await mkdir(join(runDir, "probe"), { recursive: true });
    await writeFile(join(runDir, "probe", "state.yaml"), "tick: 100\n", "utf8");
    await writePiTrace(join(runDir, "probe"), { wall_ms: 30000, tokens: 4000, cost: 0.10 });
    // attempts
    for (const n of [1, 2, 3]) {
      const dir = join(runDir, `attempt-${n}`);
      await mkdir(join(dir, "execute"), { recursive: true });
      await writeJson(join(dir, "observe.json"), { pass: n === 3, measured: n === 3 ? 0.99 : 0.25, threshold: 0.95, item: "coal", seconds_actual: 60, produced_delta: 30 });
      await writeJson(join(dir, "dry-validate.json"), { ok: true, errors: [] });
      await writeJson(join(dir, "execute", "execute.json"), { ok: true });
      await writePlanYaml(join(dir, "design"), n === 3 ? 4 : 1);
      await writePiTrace(join(dir, "design"), { wall_ms: 4000, tokens: 8000, cost: 0.04, previous_attempts: n - 1 });
    }
    const meta = await scanRunDir(runDir);
    assert.equal(meta.actual_attempts, 3);
    assert.equal(meta.attempts.length, 3);
    assert.equal(meta.attempts[0].design.placements, 1);
    assert.equal(meta.attempts[2].design.placements, 4);
    assert.equal(meta.ok, true);
    // Totals = probe(30000) + 3*4000 = 42000
    assert.equal(meta.totals.wall_ms, 42000);
    // Tokens = probe(4000) + 3*8000 = 28000
    assert.equal(meta.totals.tokens, 28000);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
