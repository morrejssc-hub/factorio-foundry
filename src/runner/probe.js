// probe.js — Probe phase (deterministic, LLM-free).
//
// Runs lib/probes/world-census.lua via rcon — one call, no pi, no tokens.
// The census script clusters resource tiles into patches and returns
// everything state.yaml needs. JS assembles and validates the result.
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import { buildLuaCommand } from "../rcon.js";
import { normalize, STATE_SCHEMA } from "./schema-norm.js";
import { probeCacheKey, readProbeCache, writeProbeCache } from "./probe-cache.js";
import { newTrace, writePiTrace } from "./pi-trace.js";
import { loadAllModules } from "../lib-loader.js";
import { worldMdPath, readWorldMd } from "./world-md.js";

// Build the chests_to_query list passed to world-census.lua. Reads
// world.md's deployed-modules fence, looks up each module spec in lib,
// and computes world coords for every output port of kind "inventory".
// Returns also the world.md raw text (so we can include its bytes in
// the probe cache key) and the modules-by-id map (for diagnostics).
async function buildChestsToQuery({ config }) {
  const path = worldMdPath(config);
  let rawText, deployed;
  try {
    const wm = await readWorldMd(path);
    rawText = wm.rawText;
    deployed = wm.entries;
  } catch (e) {
    // First-run: file may not exist yet (readWorldMd creates from
    // template, so this should be rare). Treat as empty registry.
    return { chests: [], rawText: "", deployed: [] };
  }
  if (!deployed.length) return { chests: [], rawText, deployed };

  // lib/modules/*.yaml — spec lookup so we know each module's inventory
  // ports and their rel_pos offsets.
  const modulesById = await loadAllModules(config.libDir);
  const chests = [];
  for (const dep of deployed) {
    const spec = modulesById.get(dep.module);
    if (!spec) continue;
    for (const port of spec.outputs || []) {
      if (port.kind !== "inventory") continue;
      // All current modules are anchored north; rel_pos applies as-is.
      // Direction-aware rotation can be added once a non-north module
      // ships.
      const rx = Array.isArray(port.rel_pos) ? port.rel_pos[0] : (port.rel_pos?.x ?? 0);
      const ry = Array.isArray(port.rel_pos) ? port.rel_pos[1] : (port.rel_pos?.y ?? 0);
      chests.push({
        id: `${dep.id}:${port.name}`,
        world_pos: { x: dep.anchor.x + rx, y: dep.anchor.y + ry },
        item: port.item,
      });
    }
  }
  return { chests, rawText, deployed };
}

function validateState(parsed) {
  const { normalized, errors, warnings, unwrapped } = normalize(parsed, STATE_SCHEMA);
  const allErrors = [...errors];
  if (normalized) {
    if (normalized.tick !== undefined && !Number.isFinite(normalized.tick)) {
      allErrors.push("tick must be a number");
    }
    if (normalized.worker && (!normalized.worker.position
        || !Number.isFinite(normalized.worker.position.x)
        || !Number.isFinite(normalized.worker.position.y))) {
      allErrors.push("worker.position must be {x,y}");
    }
  }
  return { effective: normalized, errors: allErrors, warnings, unwrapped };
}

/**
 * @param {object} args
 * @param {object} args.controller  — FactorioController
 * @param {object} args.epoch       — parsed epoch spec
 * @param {string} args.outDir      — plans/<run>/probe/ (will be created)
 * @param {string} [args.inputSavePath] — absolute path to the input save zip
 * @returns {Promise<{stateYamlPath: string, state: object, raw: object, cacheHit: boolean}>}
 */
export async function runProbe({ controller, epoch, outDir, inputSavePath }) {
  const config = controller.config;
  await mkdir(outDir, { recursive: true });

  const stateYamlPath = join(outDir, "state.yaml");
  const cacheDir      = resolve(config.rootDir, "state/cache/probe");
  const censusSrc     = resolve(config.libDir, "probes/world-census.lua");

  // Resolve the chests-to-query list from world.md upfront — its bytes go
  // into the cache key so a deploy that adds a new chest invalidates the
  // cache; chest contents themselves do not change without the input save
  // changing, so cached state.yaml remains correct.
  const { chests: chestsToQuery, rawText: worldMdRaw } = await buildChestsToQuery({ config });

  // Cache lookup — key: (save bytes, epoch.md bytes, world-census.lua bytes,
  // world.md bytes). world.md bytes ensures registry changes bust the cache.
  let cacheKey = null;
  if (inputSavePath) {
    cacheKey = await probeCacheKey({
      inputSavePath,
      epochPath: epoch._path,
      censusLuaPath: censusSrc,
      worldMdRaw,
    });
    const hit = await readProbeCache(cacheDir, cacheKey);
    if (hit) {
      await writeFile(stateYamlPath, hit.stateYaml, "utf8");
      const parsed     = parseYaml(hit.stateYaml);
      const validation = validateState(parsed);
      if (!validation.errors.length) {
        console.log(`[probe] cache hit (${cacheKey}) — skipping census`);
        const trace = newTrace("probe");
        trace.cache_hit     = true;
        trace.deterministic = true;
        await writePiTrace(outDir, trace);
        return { stateYamlPath, state: validation.effective, raw: { cached: true, meta: hit.meta }, cacheHit: true };
      }
      console.log(`[probe] cache hit (${cacheKey}) but stale (validator rejected); re-running census`);
    }
  }

  const censusLua = await readFile(censusSrc, "utf8");
  const params    = { radius: 150, cluster_gap: 3, chests_to_query: chestsToQuery };
  const command   = buildLuaCommand("world-census.lua", censusLua, params);

  const trace = newTrace("probe");
  trace.deterministic = true;
  const t0 = Date.now();

  let rawOutput;
  try {
    rawOutput = await controller.rcon(
      command,
      Math.min(epoch.budgets?.probe_timeout_ms ?? 60_000, 60_000),
    );
  } finally {
    trace.wall_ms = Date.now() - t0;
    await writePiTrace(outDir, trace).catch((e) =>
      console.log(`[probe] trace write failed (non-fatal): ${e.message}`)
    );
  }

  // Parse census response.
  let census;
  try {
    census = JSON.parse(rawOutput);
  } catch {
    throw new Error(`world-census.lua returned non-JSON: ${String(rawOutput).slice(0, 300)}`);
  }
  if (!census.ok) {
    throw new Error(`world-census.lua reported failure: ${JSON.stringify(census)}`);
  }
  if (!census.worker_found) {
    console.log("[probe] warning: no factorio-agent-worker found; using (0,0) as position");
  }

  // Assemble state object. Copper and stone patches go in extra (schema
  // only requires coal and iron); omit empty extra arrays to keep yaml tidy.
  const extra = {};
  if (census.copper_patches?.length) extra.copper_patches = census.copper_patches;
  if (census.stone_patches?.length)  extra.stone_patches  = census.stone_patches;
  if (census.water_patches?.length)  extra.water_patches  = census.water_patches;

  const stateRaw = {
    tick:              census.tick,
    worker:            { position: census.position },
    inventory_summary: census.inventory ?? [],
    coal_patches:      census.coal_patches ?? [],
    iron_patches:      census.iron_patches ?? [],
    water_patches:     census.water_patches ?? [],
    ...(census.world_inventory?.length ? { world_inventory: census.world_inventory } : {}),
    notes:             `Deterministic probe (world-census.lua). ${params.radius}-tile radius.`,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };

  const validation = validateState(stateRaw);
  for (const w of validation.warnings ?? []) console.log(`[probe normalize] ${w}`);
  if (validation.errors.length) {
    throw new Error(`probe census produced invalid state:\n  ${validation.errors.join("\n  ")}`);
  }

  const text = stringifyYaml(validation.effective);
  await writeFile(stateYamlPath, text, "utf8");

  if (cacheKey) {
    await writeProbeCache(cacheDir, cacheKey, text, {
      epoch_id:   epoch.id,
      input_save: inputSavePath,
      tick:       census.tick,
    }).catch((e) => console.log(`[probe] cache write failed (non-fatal): ${e.message}`));
    console.log(`[probe] cached state.yaml under key ${cacheKey}`);
  }

  return { stateYamlPath, state: validation.effective, raw: { census }, cacheHit: false };
}
