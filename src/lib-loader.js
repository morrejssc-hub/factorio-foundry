// lib-loader.js — discovers and validates lib/modules/*.yaml entries.
//
// Schema is enforced as data, not a separate file. Failure to validate is
// a hard error: silent skipping was the silent-failure-mode bug from
// yoitsu-v2. We surface each issue with the offending file path.
import { readFile, readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const REQUIRED_TOP = ["id", "version", "inputs", "outputs", "footprint", "realization"];
const REQUIRED_OUTPUT = ["name", "rel_pos", "throughput", "item", "kind"];
const REQUIRED_REALIZATION = ["blueprint"];
const KIND_VALUES = new Set(["belt", "inventory", "pipe", "power"]);

function isFinitePair(value) {
  return Array.isArray(value)
    && value.length === 2
    && Number.isFinite(value[0])
    && Number.isFinite(value[1]);
}

function validateModule(module, file) {
  const errors = [];
  for (const key of REQUIRED_TOP) {
    if (!(key in module)) errors.push(`missing top-level field: ${key}`);
  }
  if (typeof module.id !== "string" || !module.id) errors.push("id must be a non-empty string");
  if (!Number.isInteger(module.version) || module.version < 1) errors.push("version must be a positive integer");

  if (!Array.isArray(module.inputs)) errors.push("inputs must be an array");
  if (!Array.isArray(module.outputs)) errors.push("outputs must be an array");
  for (const [i, port] of (module.outputs || []).entries()) {
    for (const key of REQUIRED_OUTPUT) {
      if (!(key in port)) errors.push(`outputs[${i}] missing field: ${key}`);
    }
    if (port.rel_pos && !isFinitePair(port.rel_pos)) {
      errors.push(`outputs[${i}].rel_pos must be [x, y]`);
    }
    if (port.kind && !KIND_VALUES.has(port.kind)) {
      errors.push(`outputs[${i}].kind invalid: ${port.kind} (allowed: ${[...KIND_VALUES].join(",")})`);
    }
    if (port.throughput !== undefined && !Number.isFinite(port.throughput)) {
      errors.push(`outputs[${i}].throughput must be a number`);
    }
  }

  if (module.footprint) {
    if (!isFinitePair(module.footprint.min)) errors.push("footprint.min must be [x, y]");
    if (!isFinitePair(module.footprint.max)) errors.push("footprint.max must be [x, y]");
  }

  if (module.realization) {
    for (const key of REQUIRED_REALIZATION) {
      if (!(key in module.realization)) errors.push(`realization missing: ${key}`);
    }
  }

  if (errors.length) {
    throw new Error(`invalid module ${file}:\n  ${errors.join("\n  ")}`);
  }
  return module;
}

export async function loadModule(modulePath) {
  const text = await readFile(modulePath, "utf8");
  const parsed = parseYaml(text);
  return validateModule(parsed, modulePath);
}

export async function loadAllModules(libDir) {
  const dir = resolve(libDir, "modules");
  const entries = await readdir(dir);
  const out = new Map();
  for (const entry of entries) {
    if (![".yaml", ".yml"].includes(extname(entry))) continue;
    const modulePath = join(dir, entry);
    const module = await loadModule(modulePath);
    if (out.has(module.id)) {
      throw new Error(`duplicate module id ${module.id} in ${modulePath}`);
    }
    out.set(module.id, { ...module, _path: modulePath });
  }
  return out;
}

/**
 * Load lib/modules/ merged with an optional staged-modules directory. Staged
 * entries shadow lib entries on id collision (so an in-progress authoring
 * run doesn't fight a same-id lib module). Staged entries are tagged with
 * `_staged: true` and the absolute path of their blueprint JSON so execute.js
 * can pass it inline to factorio_action without going through the workspace
 * blueprint lookup.
 *
 * Used by epochs with `allow_module_creation: true` to expose newly-authored
 * modules to dry-validate / execute / audit before they're promoted to lib/.
 *
 * @param {string} libDir
 * @param {string|null|undefined} stagedDir — optional dir holding .yaml + .json pairs
 * @returns {Promise<Map<string, object>>}
 */
export async function loadAllModulesWithStaged(libDir, stagedDir) {
  const merged = await loadAllModules(libDir);
  if (!stagedDir) return merged;
  let stagedEntries;
  try {
    stagedEntries = await readdir(stagedDir);
  } catch (error) {
    if (error.code === "ENOENT") return merged;
    throw error;
  }
  for (const entry of stagedEntries) {
    if (![".yaml", ".yml"].includes(extname(entry))) continue;
    const yamlPath = join(stagedDir, entry);
    const module = await loadModule(yamlPath);
    // Resolve the module's declared blueprint path against the staged dir
    // first; fall back to the lib path so a staged yaml can still reference
    // an unchanged lib blueprint if the new module reuses an old geometry.
    const blueprintRel = module.realization?.blueprint || "";
    const blueprintBase = blueprintRel.split("/").pop();
    const stagedBlueprint = join(stagedDir, blueprintBase);
    let stagedBlueprintExists = true;
    try {
      await readFile(stagedBlueprint, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") stagedBlueprintExists = false;
      else throw error;
    }
    const tagged = {
      ...module,
      _path: yamlPath,
      _staged: true,
      _stagedYamlPath: yamlPath,
      _stagedBlueprintPath: stagedBlueprintExists ? stagedBlueprint : null,
    };
    merged.set(module.id, tagged);
  }
  return merged;
}

/**
 * Compute axis-aligned overlap between two placed module footprints.
 * Returns true iff their bounding boxes (after anchor translation) overlap.
 */
export function footprintOverlaps(a, b) {
  const ax0 = a.anchor.x + a.footprint.min[0];
  const ay0 = a.anchor.y + a.footprint.min[1];
  const ax1 = a.anchor.x + a.footprint.max[0];
  const ay1 = a.anchor.y + a.footprint.max[1];
  const bx0 = b.anchor.x + b.footprint.min[0];
  const by0 = b.anchor.y + b.footprint.min[1];
  const bx1 = b.anchor.x + b.footprint.max[0];
  const by1 = b.anchor.y + b.footprint.max[1];
  return ax0 < bx1 && bx0 < ax1 && ay0 < by1 && by0 < ay1;
}

/**
 * Look up a port on a module by name.
 */
export function findPort(module, portName) {
  return [...(module.inputs || []), ...(module.outputs || [])].find((p) => p.name === portName);
}
