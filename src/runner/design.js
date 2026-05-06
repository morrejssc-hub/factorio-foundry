// design.js — Design phase. Spawns `pi -p` WITHOUT any factorio_action /
// factorio_read tools. The pi process can only read state.yaml, lib files,
// and factorio_api_docs. Output: plan.yaml.
//
// This is the architectural lever that prevents the "4-miner copy" bug seen
// in ~/factorio-agent: the agent literally cannot place anything, so its
// only output channel is a written plan. Composition replaces improvisation.
import { mkdir, readFile, copyFile, symlink, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { piInvoke } from "../pi-invoke.js";

const FORBIDDEN_TOOL_PATTERNS = [
  /tool[_-]?name["']?\s*[:=]\s*["']?factorio_action/i,
  /tool[_-]?name["']?\s*[:=]\s*["']?factorio_read/i,
  /\bfactorio_action\s*\(/,
];

const PLAN_REQUIRED_FIELDS = ["epoch", "placements", "connections", "expected_throughput", "why_not_replicate"];
const PLAN_WRAPPER_KEYS = ["plan", "design", "result", "data", "output"];

async function ensureSymlink(target, linkPath) {
  try {
    const info = await lstat(linkPath);
    if (info.isSymbolicLink() || info.isDirectory()) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await symlink(target, linkPath);
}

function validatePlanShape(parsed, allowedModules) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return ["plan.yaml must be a YAML mapping at the top level"];
  }
  const errors = [];
  for (const f of PLAN_REQUIRED_FIELDS) {
    if (!(f in parsed)) errors.push(`missing field: ${f}`);
  }
  if (Array.isArray(parsed.placements)) {
    for (const [i, p] of parsed.placements.entries()) {
      if (!p.id) errors.push(`placements[${i}].id missing`);
      if (!p.module) errors.push(`placements[${i}].module missing`);
      else if (allowedModules && !allowedModules.includes(p.module)) {
        errors.push(`placements[${i}].module '${p.module}' not in allowed_modules`);
      }
      if (!p.anchor || !Number.isFinite(p.anchor.x) || !Number.isFinite(p.anchor.y)) {
        errors.push(`placements[${i}].anchor must be {x,y}`);
      }
      if (!["north", "east", "south", "west"].includes(p.direction)) {
        errors.push(`placements[${i}].direction must be one of north/east/south/west`);
      }
    }
  }
  return errors;
}

// Auto-unwrap rescue, parallel to probe.js. Absorbs Pattern B drift where the
// LLM nests the plan inside a single namespacing dict like `plan: {...}` or
// `design: {...}` instead of writing a flat schema. Pattern A (wrong shape
// entirely — `steps`/`entities`/`risks` and no placements) is NOT rescued
// here; that requires retry with explicit error feedback.
function validatePlan(parsed, allowedModules) {
  const direct = validatePlanShape(parsed, allowedModules);
  if (direct.length === 0) return { effective: parsed, errors: [] };
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const wrapper of PLAN_WRAPPER_KEYS) {
      const inner = parsed[wrapper];
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        const innerErrors = validatePlanShape(inner, allowedModules);
        if (innerErrors.length === 0) {
          return { effective: inner, errors: [], unwrappedFrom: wrapper };
        }
      }
    }
  }
  return { effective: parsed, errors: direct };
}

/**
 * @param {object} args
 * @param {object} args.config
 * @param {object} args.epoch
 * @param {object} args.state          — from probe phase
 * @param {string} args.probeDir       — plans/<run>/probe/ (state.yaml lives here)
 * @param {string} args.outDir         — plans/<run>/design/
 * @returns {Promise<{planPath: string, plan: object, raw: object}>}
 */
export async function runDesign({ config, epoch, state, probeDir, outDir }) {
  await mkdir(outDir, { recursive: true });
  await copyFile(join(probeDir, "state.yaml"), join(outDir, "state.yaml"));
  await copyFile(epoch._path, join(outDir, "epoch.yaml"));
  // Surface the lib/ tree read-only inside the design cwd so the agent can
  // grep modules and read blueprints without being able to escape upward.
  await ensureSymlink(config.libDir, join(outDir, "lib"));

  const systemPrompt = await readFile(resolve(config.rootDir, "prompts/design.md"), "utf8");
  const factorioApiDocsExt = resolve(config.rootDir, ".pi/extensions/factorio-api-docs/index.ts");

  const allowedModulesList = (epoch.allowed_modules || []).join(", ") || "(none)";
  const userMessage = [
    `Emit a placement specification for epoch ${epoch.id}.`,
    ``,
    `Inputs in your cwd:`,
    `  - state.yaml (probe output)`,
    `  - epoch.yaml`,
    `  - lib/modules/*.yaml, lib/blueprints/*.json (read-only)`,
    ``,
    `Allowed modules: ${allowedModulesList}`,
    ``,
    `OUTPUT: write a single file plan.yaml in cwd. The validator requires`,
    `EXACTLY these 5 top-level keys, no more, no less:`,
    ``,
    `  epoch: ${epoch.id}`,
    `  placements:`,
    `    - id: p0                                # short string`,
    `      module: <one of the allowed modules>`,
    `      anchor: { x: <number>, y: <number> }`,
    `      direction: <north|east|south|west>    # lowercase only`,
    `  connections: []                           # use [] if single placement`,
    `  expected_throughput: <number>             # items/s of target item`,
    `  why_not_replicate: <one-sentence string>`,
    ``,
    `You are NOT writing a runbook. Do NOT add: id (top-level), created,`,
    `steps, kind, action, depends_on, formula, assert, entities, risks,`,
    `success_criteria, version, module (top-level), starter_fuel, anchor`,
    `(top-level), or any per-step structure. The runner walks, places,`,
    `seeds fuel, waits, audits, and saves on its own; your only job is to`,
    `pick which module to place and where.`,
    ``,
    `Read state.yaml for world coordinates and lib/modules/ for module`,
    `footprints, then write plan.yaml and exit.`,
  ].join("\n");

  const piOpts = {
    systemPrompt,
    tools: ["read", "write", "ls", "grep", "find", "factorio_api_docs"],
    extensions: [factorioApiDocsExt],
    cwd: outDir,
    serviceUrl: config.serviceUrl,
    timeoutMs: epoch.budgets?.design_timeout_ms ?? 600_000,
    onStdout: (line) => console.log(`[design pi] ${line}`),
    onStderr: (line) => process.stderr.write(`[design pi err] ${line}\n`),
  };

  const planPath = join(outDir, "plan.yaml");

  // First attempt.
  const result = await piInvoke({ ...piOpts, prompt: userMessage });

  // Hard verification of the architectural invariant: design phase stdout
  // must contain zero factorio_action / factorio_read tool invocations.
  // This check applies to the FIRST attempt (it's an architectural property,
  // not a schema property). Retries also forbid these tools because they're
  // not in the tool allowlist anyway.
  for (const pattern of FORBIDDEN_TOOL_PATTERNS) {
    if (pattern.test(result.stdout)) {
      throw new Error(
        `design phase violated tool boundary: stdout contains '${pattern}' — `
        + `the LLM tried to invoke a Factorio world tool. This is the bug `
        + `the architecture is supposed to prevent.`,
      );
    }
  }

  let text = await readFile(planPath, "utf8").catch(() => null);
  let parsed = text ? parseYaml(text) : null;
  let validation = parsed ? validatePlan(parsed, epoch.allowed_modules)
                          : { effective: null, errors: ["plan.yaml not produced"] };
  let errors = validation.errors;
  if (validation.unwrappedFrom) {
    console.log(`[design] auto-unwrapped plan from top-level "${validation.unwrappedFrom}:" key`);
    parsed = validation.effective;
  }

  // One retry with error feedback (parallel to probe.js). If schema fails,
  // hand the model the validator's specific complaints + its previous output
  // so it can correct rather than re-improvise from scratch.
  if (errors.length) {
    const previousYaml = text ?? "(no plan.yaml was written)";
    const errorList = errors.map((e) => `  - ${e}`).join("\n");
    const retryMessage = [
      `Your previous Design phase output failed schema validation.`,
      ``,
      `Errors from the deterministic validator:`,
      errorList,
      ``,
      `Your previous plan.yaml content (truncated to 4000 chars):`,
      "```yaml",
      previousYaml.slice(0, 4000),
      "```",
      ``,
      `Re-emit a corrected plan.yaml at the bare relative path \`plan.yaml\``,
      `(no absolute paths, no \`..\`, no subdirectories). The validator`,
      `accepts EXACTLY these 5 top-level keys, no others:`,
      ``,
      `  epoch: ${epoch.id}`,
      `  placements:`,
      `    - id: <short string>`,
      `      module: <one of ${(epoch.allowed_modules || []).join(", ") || "the allowed modules"}>`,
      `      anchor: { x: <number>, y: <number> }`,
      `      direction: <north|east|south|west>`,
      `  connections: []`,
      `  expected_throughput: <number>`,
      `  why_not_replicate: <one-sentence string>`,
      ``,
      `Do NOT add: steps, entities, risks, success_criteria, kind, action,`,
      `depends_on, formula, assert, version, starter_fuel, id (top-level),`,
      `created, or any other key. You are emitting a placement spec, not a`,
      `runbook.`,
    ].join("\n");
    console.log(`[design] schema validation failed; retrying with error feedback`);
    await piInvoke({ ...piOpts, prompt: retryMessage });

    text = await readFile(planPath, "utf8").catch(() => null);
    parsed = text ? parseYaml(text) : null;
    validation = parsed ? validatePlan(parsed, epoch.allowed_modules)
                        : { effective: null, errors: ["plan.yaml not produced on retry"] };
    errors = validation.errors;
    if (validation.unwrappedFrom) {
      console.log(`[design] auto-unwrapped plan from top-level "${validation.unwrappedFrom}:" key (retry)`);
      parsed = validation.effective;
    }
  }

  if (!text) throw new Error(`design phase did not produce plan.yaml in ${outDir}`);
  if (errors.length) {
    throw new Error(`design phase produced invalid plan.yaml:\n  ${errors.join("\n  ")}`);
  }
  return { planPath, plan: parsed, raw: result };
}
