// One-shot probe: feed two saves into factorio-analytics, run --benchmark for
// 3600 ticks each, record wall-clock + Factorio's own benchmark stats + output
// row counts. Wrap whole script in `/usr/bin/time -v` to capture RSS.
//
// Not part of any pipeline. Result lands in logs/probe-analytics-results.json.

import { Factory, Source, Trial } from 'factorio-analytics';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SAVES = [
  { label: 'e0-empty',     savePath: path.join(ROOT, 'state/saves/e0-bootstrap-v1.zip') },
  { label: 'e1-coal-cell', savePath: path.join(ROOT, 'state/saves/e1-first-coal-v1.zip') },
];

const TICKS = 3600;
const TICK_INTERVAL = 60;

async function probeOne({ label, savePath }) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const memBefore = process.memoryUsage();
  const t0 = Date.now();

  const source = new Source({
    name: label,
    variant: 'savegame',
    text: savePath,
    desc: 'foundry analytics probe',
    tags: ['probe'],
  });

  const trial = new Trial({
    name: `probe-${label}`,
    desc: 'analytics probe',
    source,
    length: TICKS,
    tickInterval: TICK_INTERVAL,
    recordItems: true,
    recordElectric: false,
    recordCircuits: false,
    recordPollution: false,
    recordSystem: true,
    initialBots: 0,
  });

  // Run compileTrial explicitly so we can patch the injected control.lua before
  // Factorio loads it. Without this patch, Factorio dies on:
  //   __level__/control.lua:2: attempt to index global 'handler' (a nil value)
  // The analytics lib appends `handler.add_lib(require("savegame"))` to
  // control.lua, but `handler` is only auto-loaded in scenario contexts.
  // Saves need an explicit `require("event_handler")`.
  await Factory.compileTrial(trial);

  const ctlPath = path.join(ROOT, 'runtime/factorio/saves', trial.id, 'control.lua');
  const ctl = await fs.readFile(ctlPath, 'utf8');
  if (!ctl.includes('require("event_handler")')) {
    const patched = ctl.replace(
      /handler\.add_lib\(require\("savegame"\)\)/,
      'local handler = require("event_handler")\nhandler.add_lib(require("savegame"))',
    );
    await fs.writeFile(ctlPath, patched);
    process.stdout.write(`  patched control.lua: ${ctlPath}\n`);
  }

  // Reset stale running flag from any prior failure (lib's catch doesn't clear).
  Factory.factorioRunning = false;
  Factory.isTrialRunning = false;

  await Factory.runTrial(trial);
  const tEnd = Date.now();
  const memAfter = process.memoryUsage();

  const dataDir = path.join(ROOT, 'runtime/factorio/script-output/data');
  let itemRows = [];
  let itemFileBytes = 0;
  try {
    const itemFile = path.join(dataDir, `${trial.id}_item.jsonl`);
    const stat = await fs.stat(itemFile);
    itemFileBytes = stat.size;
    const txt = await fs.readFile(itemFile, 'utf8');
    itemRows = txt.trim().split('\n').filter(Boolean);
  } catch (e) {
    process.stdout.write(`  ! no item data file: ${e.message}\n`);
  }

  return {
    label,
    trial_id: trial.id,
    wallclock_ms: tEnd - t0,
    factorio_metadata: trial.metadata,
    item_rows: itemRows.length,
    item_file_bytes: itemFileBytes,
    item_head: itemRows.slice(0, 2),
    item_tail: itemRows.slice(-2),
    rss_delta_mb: +((memAfter.rss - memBefore.rss) / 1024 / 1024).toFixed(1),
    rss_after_mb: +(memAfter.rss / 1024 / 1024).toFixed(1),
  };
}

(async () => {
  const installDir = path.join(ROOT, 'runtime/factorio');

  process.stdout.write(`Initializing Factory (installDir=${installDir})…\n`);
  try {
    await Factory.initialize({
      installDir,
      dataDir: installDir,
      build: 'headless',
      hideConsole: true,
      updateInstall: false,
    });
  } catch (e) {
    process.stdout.write(`  Factory.initialize threw: ${e.message}\n`);
  }
  process.stdout.write(
    `  factoryExecutable=${Factory.factoryExecutable}, version=${Factory.factoryVersion}\n`,
  );

  if (Factory.factoryExecutable !== true) {
    process.stdout.write('  Cannot proceed — factoryExecutable not true. Aborting.\n');
    process.exit(2);
  }

  const results = [];
  for (const save of SAVES) {
    try {
      results.push(await probeOne(save));
    } catch (e) {
      process.stdout.write(`!! ${save.label} failed: ${e.message}\n${e.stack}\n`);
      results.push({ label: save.label, error: e.message, stack: e.stack });
    }
  }

  const summary = results.map(r => ({
    label: r.label,
    wall_ms: r.wallclock_ms,
    factorio_exec_ms: r.factorio_metadata?.execTime?.toFixed(0),
    factorio_trial_ms: r.factorio_metadata?.trialTime,
    avg_ms_per_tick: r.factorio_metadata?.avg,
    min_ms_per_tick: r.factorio_metadata?.min,
    max_ms_per_tick: r.factorio_metadata?.max,
    speedup_vs_realtime:
      r.factorio_metadata?.execTime
        ? +((TICKS * 1000 / 60) / r.factorio_metadata.execTime).toFixed(1)
        : null,
    item_rows: r.item_rows,
    item_file_kb: r.item_file_bytes ? +(r.item_file_bytes / 1024).toFixed(1) : 0,
    rss_after_mb: r.rss_after_mb,
    error: r.error,
  }));
  process.stdout.write('\n=== SUMMARY ===\n');
  console.table(summary);

  const outFile = path.join(ROOT, 'logs', 'probe-analytics-results.json');
  await fs.writeFile(outFile, JSON.stringify({ ticks: TICKS, results, summary }, null, 2));
  process.stdout.write(`\nWrote ${outFile}\n`);
})();
