// lib-loader.js — discovers and validates lib/modules/*.yaml entries.
//
// Schema is enforced as data, not a separate file. Failure to validate is
// a hard error: silent skipping was the silent-failure-mode bug from
// yoitsu-v2. We surface each issue with the offending file path.
import { readFile, readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  ALL_KINDS, METERED_KINDS, PORT_CONNECTORS, PORT_CONTAINERS, isAllowedPortEntity,
} from "./runner/port-entities.js";

const REQUIRED_TOP = ["id", "version", "inputs", "outputs", "footprint", "realization"];
const REQUIRED_OUTPUT = ["name", "rel_pos", "throughput", "item", "kind"];
const REQUIRED_REALIZATION = ["blueprint"];
const KIND_VALUES = ALL_KINDS;
const AGGREGATE_VALUES = new Set(["rate_from_cumulative", "snapshot_post", "snapshot_avg"]);

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

  // meters[] is optional but, if present, each entry must have id and
  // EXACTLY ONE of {script, port}. The `port` form routes to the unified
  // port-meter (lib/meters/port-meter.lua) and references a port declared
  // in inputs/outputs by name. The `script` form is the legacy direct
  // path; metric and aggregate are optional (rate_from_cumulative is the
  // default for legacy throughput-window.lua-style scripts).
  if (module.meters !== undefined) {
    if (!Array.isArray(module.meters)) {
      errors.push("meters must be an array");
    } else {
      const portIndex = new Map();
      for (const port of [...(module.inputs || []), ...(module.outputs || [])]) {
        if (port && typeof port.name === "string") portIndex.set(port.name, port);
      }
      const seenIds = new Set();
      for (const [i, m] of module.meters.entries()) {
        if (!m || typeof m !== "object") { errors.push(`meters[${i}] must be an object`); continue; }
        if (typeof m.id !== "string" || !m.id) errors.push(`meters[${i}].id must be a non-empty string`);
        else if (seenIds.has(m.id)) errors.push(`meters[${i}].id duplicate: ${m.id}`);
        else seenIds.add(m.id);
        const hasScript = typeof m.script === "string" && m.script.length > 0;
        const hasPort = typeof m.port === "string" && m.port.length > 0;
        if (hasScript && hasPort) {
          errors.push(`meters[${i}] must declare either 'script' or 'port', not both`);
        } else if (!hasScript && !hasPort) {
          errors.push(`meters[${i}] must declare one of 'script' or 'port'`);
        }
        if (hasPort) {
          const refPort = portIndex.get(m.port);
          if (!refPort) {
            errors.push(`meters[${i}].port '${m.port}' does not match any inputs[]/outputs[].name`);
          } else if (!METERED_KINDS.has(refPort.kind)) {
            errors.push(`meters[${i}].port '${m.port}' has kind '${refPort.kind}' — port-meter only supports ${[...METERED_KINDS].join(", ")}`);
          }
        }
        if (m.metric !== undefined && typeof m.metric !== "string") errors.push(`meters[${i}].metric must be a string`);
        if (m.aggregate !== undefined && !AGGREGATE_VALUES.has(m.aggregate)) {
          errors.push(`meters[${i}].aggregate invalid: ${m.aggregate} (allowed: ${[...AGGREGATE_VALUES].join(",")})`);
        }
        if (m.params !== undefined && (typeof m.params !== "object" || Array.isArray(m.params))) {
          errors.push(`meters[${i}].params must be an object`);
        }
      }
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

/**
 * Validate a parsed blueprint JSON against the port-entity registry.
 * Each blueprint.ports[name] must (a) declare a kind in ALL_KINDS,
 * (b) reference an entity-key that exists in entities[], and
 * (c) the referenced entity's prototype must be allowed for that kind.
 *
 * @param {object} blueprint  — parsed blueprint object
 * @param {string} blueprintPath  — for error messages
 * @returns {void}  — throws on validation failure
 */
export function validateBlueprint(blueprint, blueprintPath) {
  const errors = [];
  if (!blueprint || typeof blueprint !== "object") {
    throw new Error(`invalid blueprint ${blueprintPath}: not an object`);
  }
  const entities = Array.isArray(blueprint.entities) ? blueprint.entities : [];
  const entityByKey = new Map();
  for (const e of entities) {
    if (e && typeof e.key === "string") entityByKey.set(e.key, e);
  }
  const ports = blueprint.ports;
  if (ports !== undefined) {
    if (typeof ports !== "object" || Array.isArray(ports)) {
      errors.push("ports must be an object map");
    } else {
      for (const [portName, rec] of Object.entries(ports)) {
        if (!rec || typeof rec !== "object") {
          errors.push(`ports.${portName} must be an object`);
          continue;
        }
        if (typeof rec.kind !== "string" || !ALL_KINDS.has(rec.kind)) {
          errors.push(`ports.${portName}.kind '${rec.kind}' invalid (allowed: ${[...ALL_KINDS].join(",")})`);
          continue;
        }
        if (typeof rec.entity !== "string" || !rec.entity) {
          errors.push(`ports.${portName}.entity must be a non-empty entity key`);
          continue;
        }
        const ent = entityByKey.get(rec.entity);
        if (!ent) {
          errors.push(`ports.${portName}.entity '${rec.entity}' not found in blueprint.entities[].key`);
          continue;
        }
        if (typeof ent.item !== "string") {
          errors.push(`ports.${portName} → entity '${rec.entity}' missing item field`);
          continue;
        }
        if (!isAllowedPortEntity(rec.kind, ent.item)) {
          const allowed = [...(PORT_CONNECTORS[rec.kind] || []), ...(PORT_CONTAINERS[rec.kind] || [])];
          errors.push(`ports.${portName}: entity '${ent.item}' not allowed for kind '${rec.kind}' (allowed: ${allowed.join(", ")})`);
        }
      }
    }
  }
  if (errors.length) {
    throw new Error(`invalid blueprint ${blueprintPath}:\n  ${errors.join("\n  ")}`);
  }
}

/**
 * Resolve a blueprint path relative to the lib root (libDir's parent).
 * Yaml's realization.blueprint is `lib/blueprints/<id>.json` — repo-rooted.
 */
function resolveBlueprintPath(libDir, blueprintRel) {
  return resolve(libDir, "..", blueprintRel);
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
    const blueprintRel = module.realization?.blueprint;
    if (blueprintRel) {
      const blueprintPath = resolveBlueprintPath(libDir, blueprintRel);
      try {
        const text = await readFile(blueprintPath, "utf8");
        validateBlueprint(JSON.parse(text), blueprintPath);
      } catch (err) {
        // Missing-file is tolerated: the runner re-checks at place_blueprint
        // time. Tests use synthetic paths that don't exist on disk. Real
        // shape errors in an existing blueprint still throw.
        if (err.code !== "ENOENT") throw err;
      }
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
 * modules to dry-validate / verify / execute / observe before they're promoted to lib/.
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
    let blueprintTextForValidation = null;
    try {
      blueprintTextForValidation = await readFile(stagedBlueprint, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") stagedBlueprintExists = false;
      else throw error;
    }
    if (!stagedBlueprintExists && blueprintRel) {
      const libBlueprintPath = resolveBlueprintPath(libDir, blueprintRel);
      try {
        blueprintTextForValidation = await readFile(libBlueprintPath, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (blueprintTextForValidation) {
      validateBlueprint(
        JSON.parse(blueprintTextForValidation),
        stagedBlueprintExists ? stagedBlueprint : resolveBlueprintPath(libDir, blueprintRel),
      );
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
