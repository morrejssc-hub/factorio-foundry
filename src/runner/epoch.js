// epoch.js — orchestrator for the 5-phase epoch loop.
//
// Two epoch kinds:
//   - bootstrap: deterministic. Creates a fresh save, ensures worker, stocks
//     starter inventory. No probe / design / audit phases.
//   - composition: full 5-phase loop (probe → design → dry-validate →
//     execute → audit). Operates on an input save, produces an output save.
import { mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { rconExec } from "../rcon.js";
import { loadAllModules } from "../lib-loader.js";
import { runProbe } from "./probe.js";
import { runDesign } from "./design.js";
import { runDryValidate } from "./dry-validate.js";
import { runExecute } from "./execute.js";
import { runAudit } from "./audit.js";

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
  return { ok: true, savePath: out };
}

async function runCompositionEpoch({ config, factorio, epoch, log }) {
  if (!epoch.input_save) throw new Error(`composition epoch ${epoch.id} requires input_save`);
  const inputSave = resolve(config.rootDir, epoch.input_save);
  const outputSave = resolve(config.rootDir, epoch.output_save);
  log(`[epoch ${epoch.id}] starting from save ${inputSave}`);
  await ensureFactorioStartedFromSave({ factorio, savePath: inputSave });

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = resolve(config.rootDir, "plans", `${epoch.id}-${runId}`);
  await mkdir(runDir, { recursive: true });

  log(`[epoch ${epoch.id}] phase 1: probe`);
  const probeResult = await runProbe({ config, epoch, outDir: join(runDir, "probe") });
  log(`[epoch ${epoch.id}] probe ok — tick=${probeResult.state.tick}`);

  log(`[epoch ${epoch.id}] phase 2: design`);
  const designResult = await runDesign({
    config,
    epoch,
    state: probeResult.state,
    probeDir: join(runDir, "probe"),
    outDir: join(runDir, "design"),
  });
  log(`[epoch ${epoch.id}] design ok — placements=${designResult.plan.placements.length}`);

  log(`[epoch ${epoch.id}] phase 3: dry-validate`);
  const modules = await loadAllModules(config.libDir);
  const dryResult = await runDryValidate({
    plan: designResult.plan,
    modules,
    outDir: runDir,
  });
  if (!dryResult.ok) {
    throw new Error(`dry-validate failed:\n  ${dryResult.errors.join("\n  ")}`);
  }
  log(`[epoch ${epoch.id}] dry-validate ok`);

  log(`[epoch ${epoch.id}] phase 4: execute`);
  const exResult = await runExecute({
    config,
    epoch,
    plan: designResult.plan,
    modules,
    outDir: join(runDir, "execute"),
    savePathOut: outputSave,
  });
  log(`[epoch ${epoch.id}] execute ok — save=${exResult.savePath}`);

  log(`[epoch ${epoch.id}] phase 5: audit`);
  const verdict = await runAudit({
    config,
    targetMetric: epoch.target_metric,
    outDir: runDir,
  });
  log(`[epoch ${epoch.id}] audit verdict: pass=${verdict.pass} measured=${verdict.measured} threshold=${verdict.threshold}`);

  await writeDigest({ config, epoch, verdict, runDir });
  return { ok: verdict.pass, verdict, runDir };
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

export async function runEpoch({ config, factorio, epoch }) {
  const log = (msg) => console.log(msg);
  if (epoch.kind === "bootstrap") return runBootstrapEpoch({ config, factorio, epoch, log });
  if (epoch.kind === "composition") return runCompositionEpoch({ config, factorio, epoch, log });
  throw new Error(`unknown epoch.kind: ${epoch.kind}`);
}
