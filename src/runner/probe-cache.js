// probe-cache.js — content-addressed cache for the Probe phase.
//
// Cache key combines:
//   - bytes of the input save zip
//   - bytes of epoch.yaml
//   - bytes of lib/probes/world-census.lua (the deterministic census script)
//
// Hash is sha256, truncated to 16 hex chars. Cache files live at
// state/cache/probe/<key>.yaml and a sibling <key>.meta.json carries human-
// readable provenance for `ls`-style inspection.
//
// Invalidation: any input change naturally invalidates (different hash).
// Manual override: `rm -rf state/cache/probe/`. No automatic GC; the cache
// is small (each entry is a few KB of yaml).
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

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


/**
 * Compute a deterministic cache key for a probe invocation.
 *
 * @param {object} args
 * @param {string} args.inputSavePath — absolute path to the input save zip
 * @param {string} args.epochYamlPath — absolute path to the epoch yaml
 * @param {string} args.censusLuaPath — absolute path to world-census.lua
 * @returns {Promise<string>} 16-char hex key
 */
export async function probeCacheKey({ inputSavePath, epochYamlPath, censusLuaPath }) {
  const h = createHash("sha256");
  await hashFile(h, inputSavePath);
  await hashFile(h, epochYamlPath);
  await hashFile(h, censusLuaPath);
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
