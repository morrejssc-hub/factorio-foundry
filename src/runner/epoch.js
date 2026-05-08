// epoch.js — orchestrator for the 5-phase epoch loop.
//
// Two epoch kinds:
//   - bootstrap: deterministic. Creates a fresh save, ensures worker, stocks
//     starter inventory. No probe / design / audit phases.
//   - composition: full 5-phase loop (probe → design → dry-validate →
//     execute → audit). Operates on an input save, produces an output save.
import { mkdir, copyFile, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { rconExec } from "../rcon.js";
import { loadAllModules, loadAllModulesWithStaged } from "../lib-loader.js";
import { runProbe } from "./probe.js";
import { runDesign } from "./design.js";
import { runDryValidate } from "./dry-validate.js";
import { runExecute } from "./execute.js";
import { runAudit } from "./audit.js";
import { runBenchmarkAudit } from "./benchmark-audit.js";
import { InstancePool } from "./instance-pool.js";
import { writeSummary } from "./run-summary.js";
import {
  candidateId, candidateDir, epochSaveDir, runSavePath,
  winnerSavePath, resolveInputSave, promoteWinner, writeManifest,
} from "./run-layout.js";
import { pickWinner } from "./select-winner.js";
import { worldMdPath, appendDeployedModule } from "./world-md.js";

export async function loadEpoch(epochsDir, epochId) {
  const path = resolve(epochsDir, `${epochId}.yaml`);
  const text = await readFile(path, "utf8");
  const parsed = parseYaml(text);
  parsed._path = path;
  return parsed;
}

async function rcon(config, command, timeoutMs = 30000) {
  return rconExec({
    host: config.rconHost,
    port: config.rconPort,
    password: config.rconPassword,
    command,
    timeoutMs,
  });
}

async function stockWorkerInventory(config, items) {
  // Insert items into the tagged worker character. The worker is created
  // automatically by factorio-server.js on the first action call; here we
  // ensure it exists by issuing a silent-command that creates one if missing.
  const itemsLua = items.map((it) => `{name="${it.item}", count=${it.count}}`).join(", ");
  const lua = `
    local force = game.forces.player
    local surface = game.surfaces[1]
    local function find_worker()
      for _, char in pairs(surface.find_entities_filtered{name="character", force=force}) do
        if char.name_tag == "factorio-agent-worker" then return char end
      end
      return nil
    end
    local worker = find_worker()
    if not worker then
      local pos = surface.find_non_colliding_position("character", {0, 0}, 32, 0.5) or {0, 0}
      worker = surface.create_entity{name="character", position=pos, force=force}
      worker.name_tag = "factorio-agent-worker"
      worker.get_inventory(defines.inventory.character_main).clear()
    end
    local inv = worker.get_inventory(defines.inventory.character_main)
    local items = { ${itemsLua} }
    for _, it in ipairs(items) do inv.insert(it) end
    rcon.print("ok=true tick=" .. game.tick)
  `;
  const command = `/silent-command ${lua.replace(/\s+/g, " ").trim()}`;
  const output = await rcon(config, command);
  if (!output.includes("ok=true")) {
    throw new Error(`stock_worker_inventory failed: ${output}`);
  }
  return output;
}

async function ensureFactorioStartedFromSave({ factorio, savePath }) {
  // Stop any running instance, replace the in-runtime save with the supplied
  // input save zip, then start. The factorio-server.js start() expects
  // `runtime/saves/main.zip` (configurable via FACTORIO_SAVE_NAME).
  if (factorio.isRunning()) await factorio.stop();
  if (savePath) {
    const target = factorio.savePath();
    await mkdir(resolve(target, ".."), { recursive: true });
    await copyFile(savePath, target);
  }
  await factorio.start();
}

async function runBootstrapEpoch({ config, factorio, epoch, log }) {
  log(`[epoch ${epoch.id}] bootstrap kind: creating fresh save`);
  // Force fresh save: remove any existing main.zip so factorio-server.js
  // creates one via --create.
  if (factorio.isRunning()) await factorio.stop();
  await rm(factorio.savePath(), { force: true });
  await factorio.start();
  log(`[epoch ${epoch.id}] factorio ready, stocking worker inventory…`);
  await stockWorkerInventory(config, epoch.starter_inventory || []);
  log(`[epoch ${epoch.id}] saving as ${epoch.output_save}…`);
  await rcon(config, "/server-save");
  // Wait briefly for save file flush.
  await new Promise((r) => setTimeout(r, 2000));
  const newest = await import("node:fs/promises").then((mod) => mod.readdir(config.savesDir));
  const candidates = newest.filter((n) => n.endsWith(".zip"));
  if (!candidates.length) throw new Error("no save zip found after /server-save");
  const newestPath = candidates
    .map((n) => ({ name: n, path: join(config.savesDir, n) }))
    .pop();
  const out = resolve(config.rootDir, epoch.output_save);
  await mkdir(resolve(out, ".."), { recursive: true });
  await copyFile(newestPath.path, out);
  log(`[epoch ${epoch.id}] output save → ${out}`);
  // Bootstrap = clean slate. Reset world.md so any prior chain's deployed
  // modules don't bleed into the new chain. (Re-running bootstrap is the
  // explicit "wipe and start over" gesture.)
  const wmPath = worldMdPath(config);
  await rm(wmPath, { force: true });
  log(`[epoch ${epoch.id}] reset ${wmPath}`);
  return { ok: true, savePath: out };
}

async function runCompositionEpoch({ config, factorio, epoch, log }) {
  if (!epoch.input_save) throw new Error(`composition epoch ${epoch.id} requires input_save`);
  const inputSave = resolveInputSave(config, epoch.input_save);
  const maxAttempts = Math.max(1, Number(epoch.recovery_attempts) || 1);
  log(`[epoch ${epoch.id}] starting from save ${inputSave}` + (maxAttempts > 1 ? ` (recovery_attempts=${maxAttempts})` : ""));
  await ensureFactorioStartedFromSave({ factorio, savePath: inputSave });

  const runTs = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = resolve(config.rootDir, "plans", `${epoch.id}-${runTs}`);
  await mkdir(runDir, { recursive: true });

  const saveDir = epochSaveDir(config, epoch.id);
  await mkdir(saveDir, { recursive: true });
  const winnerPath = winnerSavePath(saveDir);

  // Probe runs once per run regardless of recovery_attempts. The world
  // resets to input_save between attempts so the same probe output remains
  // valid; the cache (probe-cache.js) makes this cheap even across runs.
  log(`[epoch ${epoch.id}] phase 1: probe`);
  const probeResult = await runProbe({
    config,
    epoch,
    outDir: join(runDir, "probe"),
    inputSavePath: inputSave,
  });
  log(`[epoch ${epoch.id}] probe ok — tick=${probeResult.state.tick}` + (probeResult.cacheHit ? " (cache hit)" : ""));

  // Recovery loop: design → dry-validate → execute → audit, with the
  // world reset to input_save before each retry so each attempt starts
  // from the same blank slate. previousAttempts is fed to design so the
  // next LLM call sees a focused brief on what already failed.
  const previousAttempts = [];
  const attemptRecords = [];
  let winning = null;
  let lastVerdict = null;
  const historyPath = join(runDir, "designer-history.yaml");
  const historyEntries = [];

  async function flushHistory() {
    await writeFile(historyPath, stringifyYaml({ attempts: historyEntries }), "utf8");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const cid = candidateId(attempt - 1);
    const candDir = candidateDir(runDir, cid);
    await mkdir(candDir, { recursive: true });
    const designOut = join(candDir, "design");
    const stagedDir = join(candDir, "staged-modules");
    const executeOut = join(candDir, "execute");
    const candidateSavePath = runSavePath(saveDir, runTs, cid);

    if (attempt > 1) {
      log(`[epoch ${epoch.id}] retry attempt ${attempt}/${maxAttempts} — resetting world to input_save`);
      await ensureFactorioStartedFromSave({ factorio, savePath: inputSave });
    }

    let designResult, modules, dryResult, exResult, verdict;
    let attemptError = null;
    try {
      log(`[epoch ${epoch.id}] attempt ${attempt}: design`);
      designResult = await runDesign({
        config,
        epoch,
        state: probeResult.state,
        probeDir: join(runDir, "probe"),
        outDir: designOut,
        stagedDir,
        previousAttempts,
        historyPath: historyEntries.length > 0 ? historyPath : null,
      });
      log(`[epoch ${epoch.id}] attempt ${attempt}: design ok — placements=${designResult.plan.placements.length}` +
          (designResult.authored?.length ? ` authored=${designResult.authored.map((a) => a.id).join(",")}` : ""));

      log(`[epoch ${epoch.id}] attempt ${attempt}: dry-validate`);
      modules = await loadAllModulesWithStaged(config.libDir, stagedDir);
      dryResult = await runDryValidate({
        plan: designResult.plan,
        modules,
        outDir: candDir,
      });
      if (!dryResult.ok) throw new Error(`dry-validate: ${dryResult.errors.join("; ")}`);
      log(`[epoch ${epoch.id}] attempt ${attempt}: dry-validate ok`);

      log(`[epoch ${epoch.id}] attempt ${attempt}: execute`);
      exResult = await runExecute({
        config,
        epoch,
        plan: designResult.plan,
        modules,
        outDir: executeOut,
        savePathOut: candidateSavePath,
        stateYamlPath: probeResult.stateYamlPath,
      });
      log(`[epoch ${epoch.id}] attempt ${attempt}: execute ok — save=${exResult.savePath}`);

      log(`[epoch ${epoch.id}] attempt ${attempt}: audit${config.benchmarkAudit ? " (benchmark)" : ""}`);
      verdict = config.benchmarkAudit
        ? await runBenchmarkAudit({
            config,
            factorio,
            targetMetric: epoch.target_metric,
            outDir: candDir,
            candidateSavePath,
          })
        : await runAudit({
            config,
            targetMetric: epoch.target_metric,
            outDir: candDir,
          });
      log(`[epoch ${epoch.id}] attempt ${attempt}: audit verdict: pass=${verdict.pass} measured=${verdict.measured} threshold=${verdict.threshold}`);
      lastVerdict = verdict;

      if (verdict.pass) {
        winning = { designResult, modules, exResult, verdict, stagedDir, attempt };
      } else {
        previousAttempts.push({
          attempt,
          plan: designResult.plan,
          verdict,
          authored: designResult.authored,
        });
      }
      historyEntries.push({
        attempt,
        placements: (designResult.plan.placements || []).map((p) => ({
          module: p.module,
          anchor: p.anchor,
          direction: p.direction,
        })),
        expected_throughput: designResult.plan.expected_throughput,
        scaling_note: designResult.plan.scaling_note,
        audit: verdict ? {
          pass: verdict.pass,
          measured: verdict.measured,
          threshold: verdict.threshold,
          item: verdict.item,
        } : null,
      });
      await flushHistory();
    } catch (error) {
      attemptError = error.message;
      log(`[epoch ${epoch.id}] attempt ${attempt} failed before audit: ${error.message}`);
      // If the execute phase wrote a structured proposal.json before throwing,
      // attach it to previousAttempts + designer-history so the next design
      // retry sees a focused failure record (root_cause, suggested_changes)
      // instead of just the raw error string. Designer prompt has a section
      // "Reading executor_proposal in TASK HISTORY" that consumes this.
      let executorProposal = null;
      try {
        executorProposal = JSON.parse(await readFile(join(executeOut, "proposal.json"), "utf8"));
      } catch { /* no proposal (failure before execute, or execute didn't write one) — proceed */ }
      previousAttempts.push({
        attempt,
        plan: designResult?.plan,
        authored: designResult?.authored,
        error: error.message,
        executor_proposal: executorProposal,
      });
      historyEntries.push({
        attempt,
        placements: (designResult?.plan?.placements || []).map((p) => ({
          module: p.module,
          anchor: p.anchor,
          direction: p.direction,
        })),
        expected_throughput: designResult?.plan?.expected_throughput ?? null,
        scaling_note: designResult?.plan?.scaling_note ?? null,
        audit: null,
        error: error.message,
        executor_proposal: executorProposal,
      });
      await flushHistory();
    }

    // Record this attempt's full disposition for run-meta. The earlier
    // "throw on last pre-audit failure" behaviour is replaced by uniform
    // return-with-ok=false; callers can inspect attemptsDetail to see
    // exactly which phase failed.
    attemptRecords.push({
      attempt,
      candidate: cid,
      candidateDir: candDir,
      designOut,
      executeOut,
      candidateSavePath,
      placements: designResult?.plan?.placements?.length ?? null,
      authored: designResult?.authored?.map((a) => a.id) ?? [],
      dry_validate: dryResult ? { ok: dryResult.ok, errors: dryResult.errors ?? [] } : null,
      execute: exResult ? { ok: exResult.ok, save_path: exResult.savePath } : null,
      audit: verdict ? {
        pass: verdict.pass,
        measured: verdict.measured,
        threshold: verdict.threshold,
        item: verdict.item,
        seconds_actual: verdict.seconds_actual,
        produced_delta: verdict.produced_delta,
      } : null,
      error: attemptError,
    });

    if (winning) break;
  }

  const actualAttempts = winning ? winning.attempt : attemptRecords.length;

  const selection = pickWinner(attemptRecords, epoch.optimize);

  if (winning) {
    const { designResult, verdict, exResult: winExResult } = winning;
    await promoteWinner(winExResult.savePath, winnerPath);
    log(`[epoch ${epoch.id}] winner promoted → ${winnerPath}`);
    await writeManifest(runDir, {
      epoch: epoch.id,
      run_ts: runTs,
      winner_candidate: candidateId(winning.attempt - 1),
      winner_save: winnerPath,
      winner_evidence: selection,
      candidates: attemptRecords.map((r) => ({
        candidate: r.candidate,
        save: r.candidateSavePath,
        audit: r.audit,
        error: r.error ?? null,
      })),
    });
    if (designResult.authored?.length) {
      await promoteStagedModules({ config, authored: designResult.authored, log, epochId: epoch.id });
    }
    await writeDigest({ config, epoch, verdict, runDir });
    await appendWinnerToWorldMd({ config, epoch, plan: designResult.plan, log });
  } else {
    log(`[epoch ${epoch.id}] all ${maxAttempts} attempts failed`);
    if (lastVerdict) {
      await writeDigest({ config, epoch, verdict: lastVerdict, runDir });
    }
  }

  await writeRunMeta({
    runDir, epoch, ok: !!winning, inputSave, outputSave: winnerPath,
    maxAttempts, actualAttempts, probeCacheHit: !!probeResult.cacheHit,
    attemptRecords, lastVerdict: winning ? winning.verdict : lastVerdict,
  });

  // Auto-render summary.md alongside run-meta.json. Failure is non-fatal
  // (observability shouldn't block the actual return).
  try {
    const { markdownPath } = await writeSummary(runDir);
    log(`[epoch ${epoch.id}] summary → ${markdownPath}`);
  } catch (error) {
    log(`[epoch ${epoch.id}] summary write failed (non-fatal): ${error.message}`);
  }

  return {
    ok: !!winning,
    verdict: winning ? winning.verdict : lastVerdict,
    runDir,
    attempts: actualAttempts,
    attemptsDetail: attemptRecords,
  };
}

async function promoteStagedModules({ config, authored, log, epochId }) {
  for (const a of authored) {
    const moduleDest = resolve(config.libDir, "modules", `${a.id}.yaml`);
    const blueprintDest = resolve(config.libDir, "blueprints", `${a.id}.json`);
    await copyFile(a.yamlPath, moduleDest);
    await copyFile(a.jsonPath, blueprintDest);
    log(`[epoch ${epochId}] promoted staged module '${a.id}' → ${moduleDest} + ${blueprintDest}`);
  }
}

async function readJsonOrNull(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return null; }
}

// Aggregate pi-trace.json files across the run into a single, summary-friendly
// object and persist as <runDir>/run-meta.json. Tolerant of missing trace
// files (e.g. probe cache hit before pi-trace was added; pre-audit attempt
// failures where design dir might be empty).
async function writeRunMeta({
  runDir, epoch, ok, inputSave, outputSave,
  maxAttempts, actualAttempts, probeCacheHit,
  attemptRecords, lastVerdict,
}) {
  const probeTrace = await readJsonOrNull(join(runDir, "probe", "pi-trace.json"));
  const probeBlock = {
    cache_hit: probeCacheHit,
    wall_ms: probeTrace?.wall_ms ?? 0,
    usage: probeTrace?.usage ?? null,
    cost_usd: probeTrace?.cost?.total ?? 0,
    model: probeTrace?.model ?? null,
    provider: probeTrace?.provider ?? null,
    schema_retry: probeTrace?.schema_retry ?? false,
  };

  const totals = {
    wall_ms: probeBlock.wall_ms,
    tokens: probeTrace?.usage?.totalTokens ?? 0,
    cost_usd: probeBlock.cost_usd,
  };

  const attempts = [];
  for (const r of attemptRecords) {
    const trace = await readJsonOrNull(join(r.designOut, "pi-trace.json"));
    const designBlock = {
      placements: r.placements,
      authored: r.authored,
      wall_ms: trace?.wall_ms ?? 0,
      usage: trace?.usage ?? null,
      cost_usd: trace?.cost?.total ?? 0,
      model: trace?.model ?? null,
      provider: trace?.provider ?? null,
      schema_retry: trace?.schema_retry ?? false,
      previous_attempts: trace?.previous_attempts ?? 0,
    };
    totals.wall_ms += designBlock.wall_ms;
    totals.tokens += trace?.usage?.totalTokens ?? 0;
    totals.cost_usd += designBlock.cost_usd;
    attempts.push({
      attempt: r.attempt,
      design: designBlock,
      dry_validate: r.dry_validate,
      execute: r.execute,
      audit: r.audit,
      error: r.error,
    });
  }

  const meta = {
    epoch: epoch.id,
    ok,
    input_save: inputSave,
    output_save: outputSave,
    max_attempts: maxAttempts,
    actual_attempts: actualAttempts,
    probe: probeBlock,
    attempts,
    final_verdict: lastVerdict ? {
      pass: lastVerdict.pass,
      item: lastVerdict.item,
      measured: lastVerdict.measured,
      threshold: lastVerdict.threshold,
    } : null,
    totals,
  };
  try {
    await writeFile(join(runDir, "run-meta.json"), JSON.stringify(meta, null, 2), "utf8");
  } catch (error) {
    console.log(`[run-meta] write failed (non-fatal): ${error.message}`);
  }
  return meta;
}

// world.md append: after a winning composition execute, record each
// placement as a deployed module so subsequent epochs can see it. The id
// is namespaced as `<epoch_id>:<plan_id>` to keep entries unique across
// the chain. Errors are non-fatal — world.md is agent-aid only and we
// must not regress the epoch result on a bookkeeping failure.
async function appendWinnerToWorldMd({ config, epoch, plan, log }) {
  const path = worldMdPath(config);
  for (const placement of plan?.placements || []) {
    const globalId = `${epoch.id}:${placement.id}`;
    try {
      await appendDeployedModule(path, {
        id: globalId,
        module: placement.module,
        anchor: placement.anchor,
        direction: placement.direction,
        epoch: epoch.id,
      });
    } catch (e) {
      log(`[world.md] append ${globalId} failed (non-fatal): ${e.message}`);
    }
  }
}

async function writeDigest({ config, epoch, verdict, runDir }) {
  const digestDir = resolve(config.rootDir, "state/digests");
  await mkdir(digestDir, { recursive: true });
  const digestPath = join(digestDir, `${epoch.id}.md`);
  const lines = [
    `# Epoch ${epoch.id}`,
    ``,
    `- run_dir: ${runDir}`,
    `- pass: ${verdict.pass}`,
    `- measured: ${verdict.measured} (${verdict.item}/s)`,
    `- threshold: ${verdict.threshold}`,
    `- window_ticks_actual: ${verdict.window_ticks_actual}`,
    `- timestamp: ${verdict.timestamp}`,
    ``,
  ];
  await writeFile(digestPath, lines.join("\n"), "utf8");
}

// ---------------------------------------------------------------------------
// Parallel composition epoch — N independent designs evaluated simultaneously.
// Design phases run in parallel (LLM-only, no Factorio interaction).
// Execute+audit phases run concurrently on an N-slot InstancePool.
// ---------------------------------------------------------------------------

async function runOneDesign(idx, { config, epoch, probeResult, runDir, log }) {
  const cid = candidateId(idx);
  const candDir = candidateDir(runDir, cid);
  await mkdir(candDir, { recursive: true });
  const designOut = join(candDir, "design");
  const stagedDir = join(candDir, "staged-modules");

  log(`[epoch ${epoch.id}] [${cid}] design`);
  let designResult, modules, dryResult;
  let designError = null;
  try {
    designResult = await runDesign({
      config,
      epoch,
      state: probeResult.state,
      probeDir: join(runDir, "probe"),
      outDir: designOut,
      stagedDir,
      previousAttempts: [],
      historyPath: null,
    });
    log(`[epoch ${epoch.id}] [${cid}] design ok — placements=${designResult.plan.placements.length}`);

    modules = await loadAllModulesWithStaged(config.libDir, stagedDir);
    dryResult = await runDryValidate({ plan: designResult.plan, modules, outDir: candDir });
    if (!dryResult.ok) throw new Error(`dry-validate: ${dryResult.errors.join("; ")}`);
    log(`[epoch ${epoch.id}] [${cid}] dry-validate ok`);
  } catch (err) {
    designError = err.message;
    log(`[epoch ${epoch.id}] [${cid}] design/dry-validate failed: ${err.message}`);
  }
  return { idx, cid, candDir, designOut, stagedDir, designResult, modules, dryResult, designError };
}

async function runOneExecuteAudit(design, { config, epoch, pool, runDir, saveDir, runTs, log, probeResult }) {
  const { idx, cid, candDir, designOut, stagedDir, designResult, modules, designError } = design;
  const candidateSavePath = runSavePath(saveDir, runTs, cid);
  const executeOut = join(candDir, "execute");
  const record = {
    attempt: idx + 1,
    candidate: cid,
    candidateDir: candDir,
    designOut,
    executeOut,
    candidateSavePath,
    placements: designResult?.plan?.placements?.length ?? null,
    authored: designResult?.authored?.map((a) => a.id) ?? [],
    dry_validate: design.dryResult ? { ok: design.dryResult.ok, errors: design.dryResult.errors ?? [] } : null,
    execute: null,
    audit: null,
    error: designError,
  };
  if (designError) return record;

  const slot = await pool.acquire();
  try {
    log(`[epoch ${epoch.id}] [${cid}] execute (slot ${slot.index})`);
    const exResult = await runExecute({
      config: slot.config,
      epoch,
      plan: designResult.plan,
      modules,
      outDir: executeOut,
      savePathOut: candidateSavePath,
      stateYamlPath: probeResult?.stateYamlPath,
    });
    record.execute = { ok: exResult.ok ?? true, save_path: exResult.savePath };
    log(`[epoch ${epoch.id}] [${cid}] execute ok — save=${exResult.savePath}`);

    log(`[epoch ${epoch.id}] [${cid}] audit (benchmark)`);
    const verdict = await runBenchmarkAudit({
      config: slot.config,
      factorio: slot.factorio,
      targetMetric: epoch.target_metric,
      outDir: candDir,
      candidateSavePath,
    });
    record.audit = {
      pass: verdict.pass,
      measured: verdict.measured,
      threshold: verdict.threshold,
      item: verdict.item,
      seconds_actual: verdict.seconds_actual,
      produced_delta: verdict.produced_delta,
      window_ticks_actual: verdict.window_ticks_actual,
      timestamp: verdict.timestamp,
    };
    log(`[epoch ${epoch.id}] [${cid}] audit verdict: pass=${verdict.pass} measured=${verdict.measured}`);
  } catch (err) {
    record.error = err.message;
    log(`[epoch ${epoch.id}] [${cid}] execute/audit failed: ${err.message}`);
  } finally {
    pool.release(slot);
  }
  return record;
}

async function runParallelCompositionEpoch({ config, factorio, epoch, log }) {
  if (!epoch.input_save) throw new Error(`composition epoch ${epoch.id} requires input_save`);
  const inputSave = resolveInputSave(config, epoch.input_save);
  const n = config.parallelCandidates;
  log(`[epoch ${epoch.id}] parallel mode: ${n} candidates, benchmark audit`);

  const runTs = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = resolve(config.rootDir, "plans", `${epoch.id}-${runTs}`);
  await mkdir(runDir, { recursive: true });
  const saveDir = epochSaveDir(config, epoch.id);
  await mkdir(saveDir, { recursive: true });
  const winnerPath = winnerSavePath(saveDir);

  // Probe: single instance (the factorio passed in from run-epoch.js).
  log(`[epoch ${epoch.id}] phase 1: probe`);
  await ensureFactorioStartedFromSave({ factorio, savePath: inputSave });
  const probeResult = await runProbe({
    config,
    epoch,
    outDir: join(runDir, "probe"),
    inputSavePath: inputSave,
  });
  log(`[epoch ${epoch.id}] probe ok — tick=${probeResult.state.tick}` + (probeResult.cacheHit ? " (cache hit)" : ""));

  // Stop probe instance — pool manages everything from here.
  await factorio.stop();

  // Parallel design + dry-validate (no live Factorio needed).
  log(`[epoch ${epoch.id}] launching ${n} parallel designs…`);
  const designs = await Promise.all(
    Array.from({ length: n }, (_, i) => runOneDesign(i, { config, epoch, probeResult, runDir, log })),
  );

  // Initialize pool — N instances loaded from inputSave.
  const pool = new InstancePool(config, n);
  log(`[epoch ${epoch.id}] initializing ${n}-slot instance pool…`);
  await pool.init(inputSave);

  let attemptRecords;
  try {
    // Parallel execute + benchmark audit.
    log(`[epoch ${epoch.id}] running ${n} candidates in parallel…`);
    attemptRecords = await Promise.all(
      designs.map((design) => runOneExecuteAudit(design, { config, epoch, pool, runDir, saveDir, runTs, log, probeResult })),
    );
  } finally {
    await pool.shutdown();
  }

  const selection = pickWinner(attemptRecords, epoch.optimize);
  const winningRecord = attemptRecords.find((r) => r.audit?.pass);

  const historyEntries = designs.map((d) => ({
    attempt: d.idx + 1,
    placements: (d.designResult?.plan?.placements || []).map((p) => ({
      module: p.module, anchor: p.anchor, direction: p.direction,
    })),
    expected_throughput: d.designResult?.plan?.expected_throughput ?? null,
    error: d.designError ?? null,
  }));
  await writeFile(join(runDir, "designer-history.yaml"), stringifyYaml({ attempts: historyEntries }), "utf8");

  if (winningRecord) {
    await promoteWinner(winningRecord.candidateSavePath, winnerPath);
    log(`[epoch ${epoch.id}] winner → ${winningRecord.candidate} promoted to ${winnerPath}`);

    // Promote staged modules from winning candidate's design.
    const winDesign = designs.find((d) => d.idx === winningRecord.attempt - 1);
    if (winDesign?.designResult?.authored?.length) {
      await promoteStagedModules({
        config,
        authored: winDesign.designResult.authored,
        log,
        epochId: epoch.id,
      });
    }

    const winVerdict = (() => {
      const r = winningRecord.audit;
      return r ? { pass: r.pass, item: r.item, measured: r.measured, threshold: r.threshold,
        window_ticks_actual: r.window_ticks_actual ?? null, timestamp: new Date().toISOString() } : null;
    })();
    if (winVerdict) await writeDigest({ config, epoch, verdict: winVerdict, runDir });
    if (winDesign?.designResult?.plan) {
      await appendWinnerToWorldMd({ config, epoch, plan: winDesign.designResult.plan, log });
    }

    await writeManifest(runDir, {
      epoch: epoch.id,
      run_ts: runTs,
      winner_candidate: winningRecord.candidate,
      winner_save: winnerPath,
      winner_evidence: selection,
      candidates: attemptRecords.map((r) => ({
        candidate: r.candidate,
        save: r.candidateSavePath,
        audit: r.audit,
        error: r.error ?? null,
      })),
    });
  } else {
    log(`[epoch ${epoch.id}] all ${n} parallel candidates failed`);
  }

  await writeRunMeta({
    runDir, epoch,
    ok: !!winningRecord,
    inputSave,
    outputSave: winnerPath,
    maxAttempts: n,
    actualAttempts: n,
    probeCacheHit: !!probeResult.cacheHit,
    attemptRecords,
    lastVerdict: winningRecord?.audit ?? null,
  });

  try {
    const { markdownPath } = await writeSummary(runDir);
    log(`[epoch ${epoch.id}] summary → ${markdownPath}`);
  } catch (err) {
    log(`[epoch ${epoch.id}] summary write failed (non-fatal): ${err.message}`);
  }

  return {
    ok: !!winningRecord,
    verdict: winningRecord?.audit ?? null,
    runDir,
    attempts: n,
    attemptsDetail: attemptRecords,
  };
}

export async function runEpoch({ config, factorio, epoch }) {
  const log = (msg) => console.log(msg);
  if (epoch.kind === "bootstrap") return runBootstrapEpoch({ config, factorio, epoch, log });
  if (epoch.kind === "composition") {
    if (config.parallelCandidates > 1) {
      return runParallelCompositionEpoch({ config, factorio, epoch, log });
    }
    return runCompositionEpoch({ config, factorio, epoch, log });
  }
  throw new Error(`unknown epoch.kind: ${epoch.kind}`);
}
