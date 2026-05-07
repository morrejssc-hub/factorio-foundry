// execute.js — Execute phase. Walks plan.placements and POSTs
// execute_blueprint to the Factorio service for each one. After all
// placements, calls save and copies the resulting zip into
// state/saves/<epoch>-v<N>.zip.
//
// pi fallback: if a deterministic placement fails, we spawn a one-shot pi
// with factorio_read + factorio_action tools and a focused repair prompt
// giving it the failed step's context. The fallback is bounded — it gets
// one chance per failed step, then the run is failed.
import { mkdir, copyFile, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { piInvoke } from "../pi-invoke.js";
import { newTrace, addPiCall, writePiTrace } from "./pi-trace.js";

async function postAction(config, body, { timeoutMs = 60_000 } = {}) {
  const response = await fetch(`${config.serviceUrl}/tool/factorio_action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const err = new Error(payload.error || `${body.action} HTTP ${response.status}`);
    err.payload = payload;
    err.status = response.status;
    throw err;
  }
  return payload.result;
}

async function executeBlueprint({ config, blueprint, anchor, direction, dryRun }) {
  return postAction(config, {
    action: "execute_blueprint",
    blueprint,
    anchor,
    direction,
    dryRun,
  });
}

async function placeOne({ config, placement, modules, log }) {
  const module = modules.get(placement.module);
  // Staged modules (newly authored in this run, not yet promoted to lib/)
  // pass the blueprint as an inline JSON object so the factorio service
  // doesn't need a workspace blueprint file. Lib modules continue to use
  // the by-name path so the existing tooling stays untouched.
  let blueprintArg;
  let blueprintLabel;
  if (module._staged && module._stagedBlueprintPath) {
    const json = JSON.parse(await readFile(module._stagedBlueprintPath, "utf8"));
    blueprintArg = json;
    blueprintLabel = `staged:${module.id}`;
  } else {
    const blueprintRel = module.realization.blueprint;
    // Strip the lib/blueprints/ prefix — the factorio service resolves names
    // relative to its workspace's blueprints/ dir, which we symlinked to lib/blueprints.
    const blueprintLabelRaw = blueprintRel.replace(/^lib\/blueprints\//, "").replace(/\.json$/, "");
    blueprintArg = blueprintLabelRaw;
    blueprintLabel = blueprintLabelRaw;
  }
  log(`[execute] placement ${placement.id}: module=${module.id} anchor=(${placement.anchor.x},${placement.anchor.y}) direction=${placement.direction}`);
  log(`[execute]   dryRun ${blueprintLabel}…`);
  const dry = await executeBlueprint({
    config,
    blueprint: blueprintArg,
    anchor: placement.anchor,
    direction: placement.direction,
    dryRun: true,
  });
  log(`[execute]   dryRun ok=${dry.ok ?? "n/a"} required=${JSON.stringify(dry.requiredItems || dry.required || {})}`);
  log(`[execute]   placing live…`);
  const live = await executeBlueprint({
    config,
    blueprint: blueprintArg,
    anchor: placement.anchor,
    direction: placement.direction,
    dryRun: false,
  });
  return { dry, live };
}

async function repairWithPi({ config, epoch, plan, placement, error, outDir, log }) {
  const repairDir = join(outDir, "repair", placement.id);
  await mkdir(repairDir, { recursive: true });
  await writeFile(join(repairDir, "plan.yaml"), JSON.stringify(plan, null, 2), "utf8");
  await writeFile(join(repairDir, "failed.json"), JSON.stringify({
    placement,
    error: error.message,
    payload: error.payload,
  }, null, 2), "utf8");
  const factorioServerExt = resolve(config.rootDir, ".pi/extensions/factorio-server/index.ts");
  const message = [
    `A deterministic blueprint placement failed.`,
    `See failed.json for placement and error details.`,
    `Use factorio_read and factorio_action to recover: investigate the cause `,
    `(missing inventory, blocked tile, wrong anchor, etc.), then place the `,
    `blueprint manually using execute_blueprint with the same anchor and `,
    `direction. Save no extra entities. When done, exit. Budget: 30 calls.`,
  ].join("\n");
  log(`[execute][repair] invoking pi for ${placement.id}…`);
  const result = await piInvoke({
    prompt: message,
    tools: ["read", "factorio_read", "factorio_action"],
    extensions: [factorioServerExt],
    cwd: repairDir,
    serviceUrl: config.serviceUrl,
    timeoutMs: 600_000,
    onStdout: (line) => log(`[repair pi] ${line}`),
    onStderr: (line) => process.stderr.write(`[repair pi err] ${line}\n`),
  });
  // Persist the repair trace alongside failed.json so cost/timing of the
  // repair pi call is preserved on disk. Not yet rolled up into run-meta;
  // operators can sum repairDir/*/pi-trace.json manually for now.
  const trace = newTrace("execute_repair", { placement_id: placement.id });
  addPiCall(trace, result);
  await writePiTrace(repairDir, trace);
  return result;
}

async function findNewestSave(savesDir) {
  const entries = await readdir(savesDir).catch(() => []);
  let latest = null;
  for (const entry of entries) {
    if (!entry.endsWith(".zip")) continue;
    const path = join(savesDir, entry);
    const info = await stat(path);
    if (!latest || info.mtimeMs > latest.mtimeMs) {
      latest = { path, mtimeMs: info.mtimeMs };
    }
  }
  return latest;
}

/**
 * @param {object} args
 * @param {object} args.config
 * @param {object} args.epoch
 * @param {object} args.plan
 * @param {Map<string, object>} args.modules
 * @param {string} args.outDir       — plans/<run>/execute/
 * @param {string} args.savePathOut  — destination for the produced save zip
 * @returns {Promise<{savePath: string, perPlacement: object[]}>}
 */
export async function runExecute({ config, epoch, plan, modules, outDir, savePathOut }) {
  await mkdir(outDir, { recursive: true });
  const log = (msg) => {
    console.log(msg);
  };
  const perPlacement = [];
  for (const placement of plan.placements) {
    try {
      const r = await placeOne({ config, placement, modules, log });
      perPlacement.push({ placement: placement.id, ok: true, dry: r.dry, live: r.live });
    } catch (error) {
      log(`[execute] placement ${placement.id} failed: ${error.message}`);
      try {
        await repairWithPi({ config, epoch, plan, placement, error, outDir, log });
        perPlacement.push({ placement: placement.id, ok: true, repaired: true });
      } catch (repairError) {
        perPlacement.push({ placement: placement.id, ok: false, error: error.message, repairError: repairError.message });
        await writeFile(join(outDir, "execute.json"), JSON.stringify({ ok: false, perPlacement }, null, 2), "utf8");
        throw new Error(`execute failed at placement ${placement.id}: ${error.message}`);
      }
    }
  }

  log(`[execute] saving game…`);
  await postAction(config, { action: "save" }, { timeoutMs: 60_000 });
  const newest = await findNewestSave(config.savesDir);
  if (!newest) throw new Error(`save action did not produce a save in ${config.savesDir}`);
  await mkdir(resolve(savePathOut, ".."), { recursive: true });
  await copyFile(newest.path, savePathOut);
  await writeFile(join(outDir, "execute.json"), JSON.stringify({
    ok: true,
    perPlacement,
    save: savePathOut,
  }, null, 2), "utf8");
  return { savePath: savePathOut, perPlacement };
}
