// probe-cache.js — content-addressed cache for the Probe phase.
//
// Probe is the most expensive phase to repeat: a pi call that takes minutes.
// Within a single epoch run (recovery loop with N attempts) the world state
// hasn't changed between attempts — the runner resets to input_save before
// each retry — so the probe output from attempt 1 is still valid for attempt
// N. Across epoch runs, if the input save and prompts/scripts haven't
// changed, the probe output is also reusable.
//
// Cache key combines:
//   - bytes of the input save zip
//   - bytes of epoch.yaml (goal + target_metric + allowed_modules influence
//     what the probe LLM looks for)
//   - bytes of prompts/probe.md (changes here change probe behaviour)
//   - bytes of every lib/probes/*.lua file (sorted by name)
//
// Hash is sha256, truncated to 16 hex chars. Cache files live at
// state/cache/probe/<key>.yaml and a sibling <key>.meta.json carries human-
// readable provenance for `ls`-style inspection.
//
// Invalidation: any input change naturally invalidates (different hash).
// Manual override: `rm -rf state/cache/probe/`. No automatic GC; the cache
// is small (each entry is a few KB of yaml).
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, readdir, copyFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

async function hashFile(h, path) {
  try {
    const data = await readFile(path);
    h.update(`${path}\0`);
    h.update(data);
    h.update("\0");
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function hashDirSorted(h, dir, suffix) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const matching = entries.filter((e) => e.endsWith(suffix)).sort();
  for (const entry of matching) {
    await hashFile(h, join(dir, entry));
  }
}

/**
 * Compute a deterministic cache key for a probe invocation.
 *
 * @param {object} args
 * @param {string} args.inputSavePath  — absolute path to the input save zip
 * @param {string} args.epochYamlPath  — absolute path to the epoch yaml
 * @param {string} args.probePromptPath — absolute path to prompts/probe.md
 * @param {string} args.probesDir      — absolute path to lib/probes/
 * @returns {Promise<string>} 16-char hex key
 */
export async function probeCacheKey({ inputSavePath, epochYamlPath, probePromptPath, probesDir }) {
  const h = createHash("sha256");
  await hashFile(h, inputSavePath);
  await hashFile(h, epochYamlPath);
  await hashFile(h, probePromptPath);
  await hashDirSorted(h, probesDir, ".lua");
  return h.digest("hex").slice(0, 16);
}

/**
 * Try to read a cached state.yaml for this key; return null on miss.
 * @returns {Promise<{stateYaml: string, meta: object} | null>}
 */
export async function readProbeCache(cacheDir, key) {
  const yamlPath = join(cacheDir, `${key}.yaml`);
  const metaPath = join(cacheDir, `${key}.meta.json`);
  try {
    const stateYaml = await readFile(yamlPath, "utf8");
    let meta = {};
    try {
      meta = JSON.parse(await readFile(metaPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { stateYaml, meta };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Persist a state.yaml + provenance metadata for this key. Writes are
 * post-validation only (caller's responsibility).
 */
export async function writeProbeCache(cacheDir, key, stateYaml, meta) {
  await mkdir(cacheDir, { recursive: true });
  const yamlPath = join(cacheDir, `${key}.yaml`);
  const metaPath = join(cacheDir, `${key}.meta.json`);
  await writeFile(yamlPath, stateYaml, "utf8");
  await writeFile(metaPath, JSON.stringify({ ...meta, written_at: new Date().toISOString() }, null, 2), "utf8");
}
