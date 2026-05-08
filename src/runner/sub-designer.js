// sub-designer.js — runs N region-scoped designers in parallel for a
// decomposition output from the parent designer. Each sub-designer is a
// pi process that fills in placements for one region given a contract,
// emitting plan-fragment.yaml that the connector-injector merges into a
// final plan.yaml.
//
// FORBIDDEN_TOOL_PATTERNS apply identically to sub-designers — they
// inherit the design phase's "no factorio_action" architectural
// invariant. Subs cannot author new modules; if the parent authored
// modules in staged-modules/, subs see them read-only.
import { mkdir, copyFile, readFile, writeFile, symlink, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { piInvoke } from "../pi-invoke.js";
import { normalize, FRAGMENT_SCHEMA } from "./schema-norm.js";
import { newTrace, addPiCall, writePiTrace } from "./pi-trace.js";

const FORBIDDEN_TOOL_PATTERNS = [
  /tool[_-]?name["']?\s*[:=]\s*["']?factorio_action/i,
  /\bfactorio_action\s*\(/,
  /:\s*"factorio_action"/,
];

async function ensureSymlink(target, linkPath) {
  try {
    const info = await lstat(linkPath);
    if (info.isSymbolicLink() || info.isDirectory()) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await symlink(target, linkPath);
}

function validateFragment(parsed, sub) {
  const { normalized, errors, warnings, unwrapped } = normalize(parsed, FRAGMENT_SCHEMA);
  const allErrors = [...errors];
  if (!normalized) return { effective: null, errors: allErrors, warnings, unwrapped };

  if (normalized.mode !== "fragment") {
    allErrors.push(`mode must be "fragment" (got "${normalized.mode}")`);
  }
  if (normalized.sub_id !== sub.id) {
    allErrors.push(`sub_id must equal "${sub.id}" (got "${normalized.sub_id}")`);
  }

  if (!Array.isArray(normalized.placements)) {
    allErrors.push(`placements must be an array`);
  } else {
    for (const [i, p] of normalized.placements.entries()) {
      if (!p || typeof p !== "object") {
        allErrors.push(`placements[${i}] must be a mapping`);
        continue;
      }
      if (!p.id) allErrors.push(`placements[${i}].id missing`);
      if (!p.module) allErrors.push(`placements[${i}].module missing`);
      if (!p.anchor || !Number.isFinite(p.anchor.x) || !Number.isFinite(p.anchor.y)) {
        allErrors.push(`placements[${i}].anchor must be {x,y}`);
      }
      if (!["north", "east", "south", "west"].includes(p.direction)) {
        allErrors.push(`placements[${i}].direction must be one of north/east/south/west`);
      }
    }
  }

  if (!normalized.ports || typeof normalized.ports !== "object" || Array.isArray(normalized.ports)) {
    allErrors.push(`ports must be a mapping`);
  } else {
    const expectedPortIds = new Set([
      ...((sub.contract?.inputs || []).map((p) => p.id)),
      ...((sub.contract?.outputs || []).map((p) => p.id)),
    ]);
    const placementIds = new Set((normalized.placements || []).map((p) => p && p.id));
    for (const portId of expectedPortIds) {
      const binding = normalized.ports[portId];
      if (!binding) {
        allErrors.push(`ports.${portId} missing — must bind every contract port to "<placement_id>.<module_port_name>"`);
        continue;
      }
      if (typeof binding !== "string") {
        allErrors.push(`ports.${portId} must be a string "<placement_id>.<module_port_name>" (got ${typeof binding})`);
        continue;
      }
      if (!binding.includes(".")) {
        allErrors.push(`ports.${portId} must be "<placement_id>.<module_port_name>" (got "${binding}")`);
        continue;
      }
      const [pid] = binding.split(".", 2);
      if (!placementIds.has(pid)) {
        allErrors.push(`ports.${portId} references unknown placement id "${pid}"`);
      }
    }
  }

  return { effective: normalized, errors: allErrors, warnings, unwrapped };
}

async function runOneSubDesigner({ config, epoch, sub, probeDir, parentStagedDir, subDir, log }) {
  await mkdir(subDir, { recursive: true });
  await copyFile(join(probeDir, "state.yaml"), join(subDir, "state.yaml"));
  await copyFile(epoch._path, join(subDir, "epoch.yaml"));
  await ensureSymlink(config.libDir, join(subDir, "lib"));
  if (parentStagedDir) {
    await ensureSymlink(parentStagedDir, join(subDir, "staged-modules"));
  }

  const contractObj = {
    sub_id: sub.id,
    region: sub.region,
    contract: sub.contract || { inputs: [], outputs: [] },
    allowed_modules: sub.allowed_modules || epoch.allowed_modules || [],
  };
  await writeFile(join(subDir, "contract.yaml"), stringifyYaml(contractObj), "utf8");

  const systemPrompt = await readFile(resolve(config.rootDir, "prompts/sub-designer.md"), "utf8");
  const factorioApiDocsExt = resolve(config.rootDir, ".pi/extensions/factorio-api-docs/index.ts");
  const foundryReadExt = resolve(config.rootDir, ".pi/extensions/foundry-read/index.ts");

  const userMessage = [
    `Emit a placement specification fragment for sub_id "${sub.id}" of epoch ${epoch.id}.`,
    ``,
    `Inputs in your cwd:`,
    `  - state.yaml (probe output, full world)`,
    `  - epoch.yaml`,
    `  - contract.yaml (YOUR region + port contract — read this first)`,
    `  - lib/modules/*.yaml, lib/blueprints/*.json (read-only)`,
    parentStagedDir ? `  - staged-modules/ (read-only modules authored by the parent designer)` : ``,
    ``,
    `Allowed modules: ${(sub.allowed_modules || epoch.allowed_modules || []).join(", ") || "(none)"}`,
    ``,
    `Constraints:`,
    `  - Stay inside contract.region (every placement's footprint must be within the bbox).`,
    `  - Bind every port id in contract.inputs/outputs to a "<placement_id>.<module_port_name>" pair in your output \`ports\` mapping.`,
    `  - The bound module port must have kind "belt" so a transport-belt connector can route to it.`,
    ``,
    `Write plan-fragment.yaml at the bare relative path \`plan-fragment.yaml\`.`,
    `See the system prompt for the exact schema.`,
  ].filter(Boolean).join("\n");

  const piOpts = {
    systemPrompt,
    tools: ["read", "write", "ls", "grep", "find", "factorio_api_docs", "factorio_read"],
    extensions: [factorioApiDocsExt, foundryReadExt],
    cwd: subDir,
    serviceUrl: config.serviceUrl,
    timeoutMs: epoch.budgets?.sub_designer_timeout_ms ?? epoch.budgets?.design_timeout_ms ?? 600_000,
    onStdout: (line) => log(`[sub-designer ${sub.id}] ${line}`),
    onStderr: (line) => process.stderr.write(`[sub-designer ${sub.id} err] ${line}\n`),
  };

  const fragmentPath = join(subDir, "plan-fragment.yaml");
  const trace = newTrace(`sub-designer:${sub.id}`, { sub_id: sub.id });

  let result, fragment, validation, errors;
  try {
    result = await piInvoke({ ...piOpts, prompt: userMessage });
    addPiCall(trace, result);

    for (const pattern of FORBIDDEN_TOOL_PATTERNS) {
      if (pattern.test(result.stdout)) {
        throw new Error(
          `sub-designer ${sub.id} violated tool boundary: stdout contains '${pattern}' — `
          + `the LLM tried to invoke a Factorio world tool. Sub-designers inherit the `
          + `design phase's no-factorio_action invariant.`,
        );
      }
    }

    let text = await readFile(fragmentPath, "utf8").catch(() => null);
    let parsed = text ? parseYaml(text) : null;
    validation = parsed
      ? validateFragment(parsed, sub)
      : { effective: null, errors: ["plan-fragment.yaml not produced"], warnings: [], unwrapped: false };
    errors = validation.errors;
    fragment = validation.effective;
    for (const w of validation.warnings || []) log(`[sub-designer ${sub.id}] normalize: ${w}`);

    // One schema retry, parallel to design.js. Sub-designers are particularly
    // prone to writing `mode: decompose` (contagion from the parent's
    // epoch.yaml wording) — give them one corrective shot before failing
    // the whole epoch.
    if (errors.length) {
      const previousYaml = text ?? "(no plan-fragment.yaml was written)";
      const errorList = errors.map((e) => `  - ${e}`).join("\n");
      const retryMessage = [
        `Your previous plan-fragment.yaml output failed schema validation.`,
        ``,
        `Errors from the deterministic validator:`,
        errorList,
        ``,
        `Your previous plan-fragment.yaml content (truncated to 4000 chars):`,
        "```yaml",
        previousYaml.slice(0, 4000),
        "```",
        ``,
        `Re-emit a corrected plan-fragment.yaml at the bare relative path`,
        `\`plan-fragment.yaml\`. Required top-level keys:`,
        ``,
        `  mode: fragment             # literal "fragment" — NOT "decompose", NOT "single"`,
        `  sub_id: ${sub.id}`,
        `  placements:                # array of {id, module, anchor:{x,y}, direction}`,
        `    - id: <short string>`,
        `      module: <one of ${(sub.allowed_modules || epoch.allowed_modules || []).join(", ") || "the allowed modules"}>`,
        `      anchor: { x: <number>, y: <number> }`,
        `      direction: <north|east|south|west>`,
        `  ports:                     # bind every contract port to "<placement_id>.<module_port_name>"`,
        ...((sub.contract?.inputs || []).concat(sub.contract?.outputs || []))
          .map((p) => `    ${p.id}: "<placement_id>.<module_port_name>"`),
      ].join("\n");
      log(`[sub-designer ${sub.id}] schema validation failed; retrying with error feedback`);
      const retryResult = await piInvoke({ ...piOpts, prompt: retryMessage });
      addPiCall(trace, retryResult);
      trace.schema_retry = true;

      text = await readFile(fragmentPath, "utf8").catch(() => null);
      parsed = text ? parseYaml(text) : null;
      validation = parsed
        ? validateFragment(parsed, sub)
        : { effective: null, errors: ["plan-fragment.yaml not produced on retry"], warnings: [], unwrapped: false };
      errors = validation.errors;
      fragment = validation.effective;
      for (const w of validation.warnings || []) log(`[sub-designer ${sub.id}] normalize: ${w} (retry)`);
    }
  } finally {
    await writePiTrace(subDir, trace).catch((e) => log(`[sub-designer ${sub.id}] trace write failed (non-fatal): ${e.message}`));
  }

  return { sub_id: sub.id, sub, fragment, errors: errors || [], raw: result };
}

/**
 * Spawn one pi process per entry in decomposition.subs in parallel and collect
 * each sub's plan-fragment.yaml. Returns one record per sub regardless of
 * success — caller (connector-injector) aggregates errors.
 *
 * @param {object} args
 * @param {object} args.config
 * @param {object} args.epoch
 * @param {object} args.decomposition
 * @param {string} args.probeDir
 * @param {string} args.parentDesignDir — parent design phase outDir; subs land under <parentDesignDir>/subs/<sub_id>/
 * @param {string|null} [args.parentStagedDir]
 * @param {(msg: string) => void} args.log
 * @returns {Promise<Array<{sub_id: string, sub: object, fragment: object|null, errors: string[], raw: object}>>}
 */
export async function runSubDesigners({ config, epoch, decomposition, probeDir, parentDesignDir, parentStagedDir, log }) {
  const subsRoot = join(parentDesignDir, "subs");
  await mkdir(subsRoot, { recursive: true });
  log(`[design] decomposition: spawning ${decomposition.subs.length} sub-designers in parallel`);

  const tasks = decomposition.subs.map((sub) => {
    const subDir = join(subsRoot, sub.id);
    return runOneSubDesigner({ config, epoch, sub, probeDir, parentStagedDir, subDir, log });
  });

  return await Promise.all(tasks);
}
