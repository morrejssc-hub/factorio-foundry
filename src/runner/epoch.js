// epoch.js — orchestrator for the epoch loop.
//
// Two epoch kinds:
//   - bootstrap: deterministic. Creates a fresh save, ensures worker, stocks
//     starter inventory. No probe / design / verify / observe phases.
//   - composition: full pipeline (probe → design → dry-validate → verify →
//     observe). Operates on an input save, produces an output save.
import { mkdir, copyFile, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { loadAllModules, loadAllModulesWithStaged } from "../lib-loader.js";
import { runProbe } from "./probe.js";
import { runDesign } from "./design.js";
import { runDryValidate } from "./dry-validate.js";
import { applyCandidate, runVerifyGate } from "./verify.js";
import { runObserve } from "./observe.js";
import { InstancePool } from "./instance-pool.js";
import { FactorioController } from "./factorio-controller.js";
import { writeSummary } from "./run-summary.js";
import {
  candidateId, candidateDir, epochSaveDir, runSavePath,
  winnerSavePath, resolveInputSave, promoteWinner, writeManifest,
} from "./run-layout.js";
import { pickWinner } from "./select-winner.js";
import { worldMdPath, appendDeployedModule } from "./world-md.js";
import { exists } from "../fs-util.js";

// dry-validate failures are spatial/recipe/inventory mistakes that the LLM
// can fix from prompt feedback alone — no Factorio simulation needed. They
// get up to N free re-designs without consuming the recovery_attempts
// budget (which is reserved for the expensive verify failures).
const MAX_DRY_VALIDATE_RETRIES = 3;

export async function loadEpoch(epochsDir, epochId) {
  const mdPath = resolve(epochsDir, `${epochId}.md`);
  const yamlPath = resolve(epochsDir, `${epochId}.yaml`);
  const path = await exists(mdPath) ? mdPath : yamlPath;
  const text = await readFile(path, "utf8");
  let parsed;
  if (path.endsWith(".md")) {
    const fm = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!fm) {
      throw new Error(`invalid epoch.md frontmatter in ${path}`);
    }
    parsed = parseYaml(fm[1]) || {};
    const body = fm[2].trim();
    if (body) parsed.goal = body;
  } else {
    parsed = parseYaml(text);
  }
  parsed._path = path;
  return parsed;
}

function renderDesignerHistoryMd(historyEntries) {
  const frontmatter = stringifyYaml({ attempts: historyEntries }).trimEnd();
  return `---\n${frontmatter}\n---\n\n# Designer History\n\nCross-attempt history used by the design phase retry prompt.\n`;
}

async function replayObserveExport({
  controller, epoch, plan, modules, outDir, executeOut, stagedDir,
  savePathOut, log,
}) {
  const applied = await applyCandidate({
    controller,
    plan,
    modules,
    outDir: executeOut,
    dryValidate: false,
  });
  const observeVerdict = await runObserve({
    controller,
    targetMetric: epoch.target_metric,
    successCriteria: epoch.success_criteria,
    outDir,
    modules,
    plan,
    stagedDir,
  });
  const savePath = await controller.exportZip(savePathOut);
  log(`[epoch ${epoch.id}] winner replay exported — ${savePath}`);
  return { observeVerdict, savePath, perPlacement: applied.perPlacement };
}

async function stockWorkerInventory(controller, items) {
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
  const output = await controller.rcon(command, 30000);
  if (!output.includes("ok=true")) {
    throw new Error(`stock_worker_inventory failed: ${output}`);
  }
  return output;
}

async function runBootstrapEpoch({ controller, config, epoch, log }) {
  log(`[epoch ${epoch.id}] bootstrap kind: creating fresh save`);
  // Force fresh save: remove any existing main.zip so factorio-server.js
  // creates one via --create.
  if (controller.isRunning()) await controller.stop();
  await rm(controller.savePath(), { force: true });
  await controller.start();
  log(`[epoch ${epoch.id}] factorio ready, stocking worker inventory…`);
  await stockWorkerInventory(controller, epoch.starter_inventory || []);
  log(`[epoch ${epoch.id}] saving as ${epoch.output_save}…`);
  const out = resolve(config.rootDir, epoch.output_save);
  await controller.exportZip(out);
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
  const controller = new FactorioController(factorio, config);
  const inputSave = resolveInputSave(config, epoch.input_save);
  const maxAttempts = Math.max(1, Number(epoch.recovery_attempts) || 1);
  log(`[epoch ${epoch.id}] starting from save ${inputSave}` + (maxAttempts > 1 ? ` (recovery_attempts=${maxAttempts})` : ""));
  await controller.loadSave(inputSave);

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
    controller,
    epoch,
    outDir: join(runDir, "probe"),
    inputSavePath: inputSave,
  });
  log(`[epoch ${epoch.id}] probe ok — tick=${probeResult.state.tick}` + (probeResult.cacheHit ? " (cache hit)" : ""));

  const gatePool = new InstancePool(config, 1);
  log(`[epoch ${epoch.id}] initializing verifier clone…`);
  await gatePool.init(inputSave);

  // Recovery loop: design → dry-validate → cloned verify gate. The primary
  // instance stays on input_save until a winner is replayed for observe/export.
  // previousAttempts is fed to design so the next LLM call sees a focused
  // brief on what already failed.
  const previousAttempts = [];
  const attemptRecords = [];
  let winning = null;
  let lastVerdict = null;
  let primaryNeedsReset = false;
  const historyPath = join(runDir, "designer-history.md");
  const historyEntries = [];

  async function flushHistory() {
    await writeFile(historyPath, renderDesignerHistoryMd(historyEntries), "utf8");
  }

  try {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const cid = candidateId(attempt - 1);
    const candDir = candidateDir(runDir, cid);
    await mkdir(candDir, { recursive: true });
    const designOut = join(candDir, "design");
    const stagedDir = join(candDir, "staged-modules");
    const executeOut = join(candDir, "execute");
    const candidateSavePath = runSavePath(saveDir, runTs, cid);

    if (primaryNeedsReset) {
      log(`[epoch ${epoch.id}] retry attempt ${attempt}/${maxAttempts} — resetting primary to input_save`);
      await controller.loadSave(inputSave);
      primaryNeedsReset = false;
    }

    let designResult, modules, dryResult, exResult, verdict, observeVerdict;
    let attemptError = null;
    try {
      // Inner retry: design → dry-validate. dry-validate failures are
      // spatial/recipe/inventory mistakes (cheap to detect, no Factorio
      // simulation cost). They get up to MAX_DRY_VALIDATE_RETRIES free
      // re-designs WITHOUT consuming the attempt budget — recovery_attempts
      // is reserved for verify failures (which DO carry the 60s+
      // simulation cost). Each retry pushes the failure to previousAttempts
      // so the next runDesign sees the dry-validate error and can adjust.
      let dryValidateRetry = 0;
      while (true) {
        const designLabel = dryValidateRetry === 0 ? "design"
          : `design (free retry ${dryValidateRetry}/${MAX_DRY_VALIDATE_RETRIES})`;
        log(`[epoch ${epoch.id}] attempt ${attempt}: ${designLabel}`);
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
          controller,
        });
        if (dryResult.ok) {
          log(`[epoch ${epoch.id}] attempt ${attempt}: dry-validate ok`);
          break;
        }

        const dryError = `dry-validate: ${dryResult.errors.join("; ")}`;
        dryValidateRetry++;
        if (dryValidateRetry >= MAX_DRY_VALIDATE_RETRIES) {
          throw new Error(`${dryError} (exhausted ${MAX_DRY_VALIDATE_RETRIES} free retries)`);
        }
        log(`[epoch ${epoch.id}] attempt ${attempt}: dry-validate failed (free retry ${dryValidateRetry}/${MAX_DRY_VALIDATE_RETRIES}): ${dryResult.errors.join("; ")}`);
        previousAttempts.push({
          attempt,
          plan: designResult.plan,
          authored: designResult.authored,
          error: dryError,
          kind: "dry_validate_fail",
        });
        historyEntries.push({
          attempt,
          kind: "dry_validate_fail",
          retry: dryValidateRetry,
          placements: (designResult.plan.placements || []).map((p) => ({
            module: p.module,
            anchor: p.anchor,
            direction: p.direction,
          })),
          expected_throughput: designResult.plan.expected_throughput ?? null,
          error: dryError,
        });
        await flushHistory();
      }

      log(`[epoch ${epoch.id}] attempt ${attempt}: verify`);
      const slot = await gatePool.acquire();
      let verifyResult;
      try {
        if (slot._foundryDirty) {
          log(`[epoch ${epoch.id}] attempt ${attempt}: resetting verifier clone`);
          await slot.controller.loadSave(inputSave);
          slot._foundryDirty = false;
        }
        verifyResult = await runVerifyGate({
          controller: slot.controller,
          epoch,
          plan: designResult.plan,
          modules,
          outDir: executeOut,
          stagedDir,
        });
      } finally {
        slot._foundryDirty = true;
        gatePool.release(slot);
      }
      verdict = verifyResult.verdict;
      log(`[epoch ${epoch.id}] attempt ${attempt}: verify ok — pass=${verdict.pass} measured=${verdict.measured} threshold=${verdict.threshold}`);
      lastVerdict = verdict;

      if (verdict.pass) {
        log(`[epoch ${epoch.id}] attempt ${attempt}: winner replay on primary`);
        const replay = await replayObserveExport({
          controller,
          epoch,
          plan: designResult.plan,
          modules,
          outDir: candDir,
          executeOut,
          stagedDir,
          savePathOut: candidateSavePath,
          log,
        });
        observeVerdict = replay.observeVerdict;
        log(`[epoch ${epoch.id}] attempt ${attempt}: observe — pass=${observeVerdict.pass} measured=${observeVerdict.measured}`);
        exResult = { savePath: replay.savePath, perPlacement: replay.perPlacement };
        winning = { designResult, modules, exResult, verdict, observeVerdict, stagedDir, attempt };
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
        verify: verdict ? {
          pass: verdict.pass,
          measured: verdict.measured,
          threshold: verdict.threshold,
          item: verdict.item,
        } : null,
      });
      await flushHistory();
    } catch (error) {
      attemptError = error.message;
      log(`[epoch ${epoch.id}] attempt ${attempt} failed before observe: ${error.message}`);
      // If the execute phase wrote a structured proposal.json before throwing,
      // attach it to previousAttempts + designer-history so the next design
      // retry sees a focused failure record (root_cause, suggested_changes)
      // instead of just the raw error string. Designer prompt has a section
      // "Reading executor_proposal in TASK HISTORY" that consumes this.
      let executorProposal = null;
      try {
        executorProposal = JSON.parse(await readFile(join(executeOut, "proposal.json"), "utf8"));
      } catch { /* no proposal (failure before execute, or execute didn't write one) — proceed */ }
      if (verdict?.pass) primaryNeedsReset = true;
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
        verify: null,
        error: error.message,
        executor_proposal: executorProposal,
      });
      await flushHistory();
    }

    // Record this attempt's full disposition for run-meta. The earlier
    // "throw on last pre-observe failure" behaviour is replaced by uniform
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
      execute: exResult ? { ok: !!exResult.savePath, save_path: exResult.savePath } : null,
      verify: verdict ? {
        pass: verdict.pass,
        measured: verdict.measured,
        threshold: verdict.threshold,
        item: verdict.item,
        seconds_actual: verdict.seconds_actual,
        produced_delta: verdict.produced_delta,
      } : null,
      observe: observeVerdict ? {
        pass: observeVerdict.pass,
        measured: observeVerdict.measured,
        threshold: observeVerdict.threshold,
        item: observeVerdict.item,
        seconds_actual: observeVerdict.seconds_actual,
        produced_delta: observeVerdict.produced_delta,
      } : null,
      error: attemptError,
    });

    if (winning) break;
  }
  } finally {
    await gatePool.shutdown();
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
        verify: r.verify,
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
    await copyFile(a.jsonPath, blueprintDest);
    const promotedMeters = [];
    for (const sm of (a.stagedMeters || [])) {
      const meterDest = resolve(config.libDir, "meters", sm.basename);
      await copyFile(sm.stagedPath, meterDest);
      promotedMeters.push({ ...sm, libRel: `lib/meters/${sm.basename}` });
      log(`[epoch ${epochId}] promoted meter '${sm.meterId}' → ${meterDest}`);
    }
    // Rewrite the yaml's meters[].script entries that pointed at staged-modules/
    // so the promoted module yaml references the lib path. Without this, the
    // next epoch's lib-load would point at a non-existent staged-modules/ dir.
    let yamlText = await readFile(a.yamlPath, "utf8");
    if (promotedMeters.length > 0) {
      const parsed = parseYaml(yamlText);
      for (const meter of (parsed.meters || [])) {
        if (typeof meter.script !== "string") continue;
        if (!meter.script.startsWith("staged-modules/")) continue;
        const base = meter.script.slice("staged-modules/".length);
        const pm = promotedMeters.find((p) => p.basename === base);
        if (pm) meter.script = pm.libRel;
      }
      yamlText = stringifyYaml(parsed);
    }
    await writeFile(moduleDest, yamlText, "utf8");
    log(`[epoch ${epochId}] promoted staged module '${a.id}' → ${moduleDest} + ${blueprintDest}`);
  }
}

async function readJsonOrNull(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return null; }
}

// Aggregate pi-trace.json files across the run into a single, summary-friendly
// object and persist as <runDir>/run-meta.json. Tolerant of missing trace
// files (e.g. probe cache hit before pi-trace was added; pre-observe attempt
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
      verify: r.verify,
      observe: r.observe ?? null,
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
// Verify + execute + observe phases run concurrently on an N-slot InstancePool.
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

async function runOneExecuteAudit(design, { config, epoch, pool, saveDir, runTs, log, inputSave }) {
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
    verify: null,
    observe: null,
    error: designError,
  };
  if (designError) return record;

  const slot = await pool.acquire();
  try {
    log(`[epoch ${epoch.id}] [${cid}] verify (slot ${slot.index})`);
    const verifyResult = await runVerifyGate({
      controller: slot.controller,
      epoch,
      plan: designResult.plan,
      modules,
      outDir: executeOut,
      stagedDir,
    });
    const verdict = verifyResult.verdict;
    record.verify = {
      pass: verdict.pass,
      measured: verdict.measured,
      threshold: verdict.threshold,
      item: verdict.item,
      seconds_actual: verdict.seconds_actual,
      produced_delta: verdict.produced_delta,
      window_ticks_actual: verdict.window_ticks_actual,
      timestamp: verdict.timestamp,
    };
    log(`[epoch ${epoch.id}] [${cid}] verify ok — pass=${verdict.pass} measured=${verdict.measured}`);

    if (verdict.pass) {
      record.execute = { ok: true, save_path: null };
    }
  } catch (err) {
    record.error = err.message;
    log(`[epoch ${epoch.id}] [${cid}] verify failed: ${err.message}`);
  } finally {
    pool.release(slot);
  }
  return record;
}

async function runParallelCompositionEpoch({ config, factorio, epoch, log }) {
  if (!epoch.input_save) throw new Error(`composition epoch ${epoch.id} requires input_save`);
  const controller = new FactorioController(factorio, config);
  const inputSave = resolveInputSave(config, epoch.input_save);
  const n = config.parallelCandidates;
  log(`[epoch ${epoch.id}] parallel mode: ${n} candidates`);

  const runTs = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = resolve(config.rootDir, "plans", `${epoch.id}-${runTs}`);
  await mkdir(runDir, { recursive: true });
  const saveDir = epochSaveDir(config, epoch.id);
  await mkdir(saveDir, { recursive: true });
  const winnerPath = winnerSavePath(saveDir);

  // Probe: single instance (the factorio passed in from run-epoch.js).
  log(`[epoch ${epoch.id}] phase 1: probe`);
  await controller.loadSave(inputSave);
  const probeResult = await runProbe({
    controller,
    epoch,
    outDir: join(runDir, "probe"),
    inputSavePath: inputSave,
  });
  log(`[epoch ${epoch.id}] probe ok — tick=${probeResult.state.tick}` + (probeResult.cacheHit ? " (cache hit)" : ""));

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
    // Parallel cloned verify gate. Candidate worlds are disposable; the
    // primary instance replays only the selected winner for observe/export.
    log(`[epoch ${epoch.id}] running ${n} candidates in parallel…`);
    attemptRecords = await Promise.all(
      designs.map((design) => runOneExecuteAudit(design, { config, epoch, pool, runDir, saveDir, runTs, log, probeResult, inputSave })),
    );
  } finally {
    await pool.shutdown();
  }

  const selection = pickWinner(attemptRecords, epoch.optimize);
  const winningRecord = selection.winnerId
    ? attemptRecords.find((r) => r.candidate === selection.winnerId)
    : null;

  const historyEntries = designs.map((d) => ({
    attempt: d.idx + 1,
    placements: (d.designResult?.plan?.placements || []).map((p) => ({
      module: p.module, anchor: p.anchor, direction: p.direction,
    })),
    expected_throughput: d.designResult?.plan?.expected_throughput ?? null,
    error: d.designError ?? null,
  }));
  await writeFile(join(runDir, "designer-history.md"), renderDesignerHistoryMd(historyEntries), "utf8");

  if (winningRecord) {
    const winDesign = designs.find((d) => d.idx === winningRecord.attempt - 1);
    if (!winDesign?.designResult?.plan) {
      throw new Error(`winner ${winningRecord.candidate} missing design plan`);
    }
    log(`[epoch ${epoch.id}] winner → ${winningRecord.candidate}; replaying on primary`);
    await controller.loadSave(inputSave);
    const replay = await replayObserveExport({
      controller,
      epoch,
      plan: winDesign.designResult.plan,
      modules: winDesign.modules,
      outDir: winningRecord.candidateDir,
      executeOut: winningRecord.executeOut,
      stagedDir: winDesign.stagedDir,
      savePathOut: winningRecord.candidateSavePath,
      log,
    });
    winningRecord.execute = { ok: true, save_path: replay.savePath };
    winningRecord.observe = {
      pass: replay.observeVerdict.pass,
      measured: replay.observeVerdict.measured,
      threshold: replay.observeVerdict.threshold,
      item: replay.observeVerdict.item,
      seconds_actual: replay.observeVerdict.seconds_actual,
      produced_delta: replay.observeVerdict.produced_delta,
    };

    await promoteWinner(winningRecord.candidateSavePath, winnerPath);
    log(`[epoch ${epoch.id}] winner → ${winningRecord.candidate} promoted to ${winnerPath}`);

    // Promote staged modules from winning candidate's design.
    if (winDesign?.designResult?.authored?.length) {
      await promoteStagedModules({
        config,
        authored: winDesign.designResult.authored,
        log,
        epochId: epoch.id,
      });
    }

    const winVerdict = (() => {
      const r = winningRecord.verify;
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
        verify: r.verify,
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
    lastVerdict: winningRecord?.verify ?? null,
  });

  try {
    const { markdownPath } = await writeSummary(runDir);
    log(`[epoch ${epoch.id}] summary → ${markdownPath}`);
  } catch (err) {
    log(`[epoch ${epoch.id}] summary write failed (non-fatal): ${err.message}`);
  }

  return {
    ok: !!winningRecord,
    verdict: winningRecord?.verify ?? null,
    runDir,
    attempts: n,
    attemptsDetail: attemptRecords,
  };
}

export async function runEpoch({ config, factorio, epoch }) {
  const log = (msg) => console.log(msg);
  if (epoch.kind === "bootstrap") {
    const controller = new FactorioController(factorio, config);
    return runBootstrapEpoch({ controller, config, epoch, log });
  }
  if (epoch.kind === "composition") {
    if (config.parallelCandidates > 1) {
      return runParallelCompositionEpoch({ config, factorio, epoch, log });
    }
    return runCompositionEpoch({ config, factorio, epoch, log });
  }
  throw new Error(`unknown epoch.kind: ${epoch.kind}`);
}
