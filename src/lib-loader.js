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
