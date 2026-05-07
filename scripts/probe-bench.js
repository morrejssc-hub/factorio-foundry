// Minimal direct benchmark probe — bypasses factorio-analytics (incompatible
// with Factorio 2.0). Uses Factorio's `--benchmark <save> --benchmark-ticks N`
// mode and parses its stdout for per-tick timing stats.
//
// Probes two saves: e0 (empty world) and e1 (post-execute, has coal cell).
// No Lua instrumentation injected — just measures raw simulation throughput.
//
// Output: logs/probe-bench-results.json + stdout summary table.

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FACTORIO_BIN = path.join(ROOT, 'runtime/factorio/bin/x64/factorio');
const SAVES_DIR = path.join(ROOT, 'runtime/factorio/saves');

const SAVES = [
  { label: 'e0-empty',     src: path.join(ROOT, 'state/saves/e0-bootstrap-v1.zip') },
  { label: 'e1-coal-cell', src: path.join(ROOT, 'state/saves/e1-first-coal-v1.zip') },
];

const TICKS = 3600;

async function ensureCopy(srcZip, dstName) {
  const dst = path.join(SAVES_DIR, `${dstName}.zip`);
  await fs.mkdir(SAVES_DIR, { recursive: true });
  await fs.copyFile(srcZip, dst);
  return dst;
}

function runFactorio(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FACTORIO_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const startTime = Date.now();
    const startUsage = process.cpuUsage();
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', code => {
      resolve({
        code,
        stdout,
        stderr,
        wall_ms: Date.now() - startTime,
        node_cpu: process.cpuUsage(startUsage),
      });
    });
  });
}

// Parse Factorio --benchmark stdout for perf summary lines like:
//   Performed 3600 updates in 280.123 ms
//     avg: 0.078 ms, min: 0.040 ms, max: 1.230 ms
function parseBench(stdout) {
  const m1 = stdout.match(/Performed\s+(\d+)\s+updates in\s+([\d.]+)\s+ms/);
  const m2 = stdout.match(/avg:\s+([\d.]+)\s+ms,\s+min:\s+([\d.]+)\s+ms,\s+max:\s+([\d.]+)\s+ms/);
  return {
    updates: m1 ? +m1[1] : null,
    total_ms: m1 ? +m1[2] : null,
    avg_ms: m2 ? +m2[1] : null,
    min_ms: m2 ? +m2[2] : null,
    max_ms: m2 ? +m2[3] : null,
  };
}

async function probeOne({ label, src }) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const benchName = `probe-${label}`;
  const dst = await ensureCopy(src, benchName);
  process.stdout.write(`  copied: ${dst}\n`);

  const args = ['--benchmark', benchName, '--benchmark-ticks', String(TICKS), '--benchmark-verbose', 'all'];
  process.stdout.write(`  spawn: factorio ${args.join(' ')}\n`);
  const r = await runFactorio(args);
  const bench = parseBench(r.stdout);
  process.stdout.write(`  exit=${r.code} wall=${r.wall_ms}ms parsed=${JSON.stringify(bench)}\n`);
  if (r.code !== 0) {
    process.stdout.write(`  --- stderr ---\n${r.stderr.slice(-500)}\n`);
    process.stdout.write(`  --- stdout tail ---\n${r.stdout.slice(-500)}\n`);
  }
  return {
    label,
    src,
    exit_code: r.code,
    wall_ms: r.wall_ms,
    node_cpu_user_ms: +(r.node_cpu.user / 1000).toFixed(1),
    node_cpu_sys_ms: +(r.node_cpu.system / 1000).toFixed(1),
    bench,
    speedup_vs_realtime:
      bench.total_ms ? +(TICKS * 1000 / 60 / bench.total_ms).toFixed(1) : null,
    stdout_tail: r.stdout.slice(-400),
  };
}

(async () => {
  process.stdout.write(`Factorio: ${FACTORIO_BIN}\n`);
  const results = [];
  for (const save of SAVES) {
    try {
      results.push(await probeOne(save));
    } catch (e) {
      results.push({ label: save.label, error: e.message, stack: e.stack });
    }
  }

  const summary = results.map(r => ({
    label: r.label,
    exit: r.exit_code,
    wall_ms: r.wall_ms,
    bench_total_ms: r.bench?.total_ms,
    avg_ms_per_tick: r.bench?.avg_ms,
    min_ms_per_tick: r.bench?.min_ms,
    max_ms_per_tick: r.bench?.max_ms,
    speedup: r.speedup_vs_realtime ? r.speedup_vs_realtime + 'x' : null,
  }));
  process.stdout.write('\n=== SUMMARY ===\n');
  console.table(summary);

  await fs.writeFile(
    path.join(ROOT, 'logs/probe-bench-results.json'),
    JSON.stringify({ ticks: TICKS, results, summary }, null, 2),
  );
  process.stdout.write('\nWrote logs/probe-bench-results.json\n');
})();
