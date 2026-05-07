// design.js — Design phase. Spawns `pi -p` WITHOUT any factorio_action /
// factorio_read tools. The pi process can only read state.yaml, lib files,
// and factorio_api_docs. Output: plan.yaml.
//
// This is the architectural lever that prevents the "4-miner copy" bug seen
// in ~/factorio-agent: the agent literally cannot place anything, so its
// only output channel is a written plan. Composition replaces improvisation.
import { mkdir, readFile, copyFile, symlink, lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { piInvoke } from "../pi-invoke.js";
import { normalize, PLAN_SCHEMA } from "./schema-norm.js";
import { loadModule } from "../lib-loader.js";
import { newTrace, addPiCall, writePiTrace } from "./pi-trace.js";

const FORBIDDEN_TOOL_PATTERNS = [
  /tool[_-]?name["']?\s*[:=]\s*["']?factorio_action/i,
  /tool[_-]?name["']?\s*[:=]\s*["']?factorio_read/i,
  /\bfactorio_action\s*\(/,
  // pi --mode json tool-call events serialize the tool name as a JSON string
  // value. Match either `"tool":"factorio_action"` or any other JSON field
  // whose value is the disallowed tool. The substring check is conservative
  // — even an error event mentioning the tool counts as evidence of an
  // attempt and trips this guard.
  /:\s*"factorio_action"/,
  /:\s*"factorio_read"/,
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

// validatePlan runs the unified normalizer against PLAN_SCHEMA, then layers
// per-placement type checks (id/module/anchor/direction). The normalizer
// absorbs Pattern B/C drift; only Pattern A (required fields actually
// missing) triggers retry.
function validatePlan(parsed, allowedModules) {
  const { normalized, errors, warnings, unwrapped } = normalize(parsed, PLAN_SCHEMA);
  const allErrors = [...errors];
  if (normalized && Array.isArray(normalized.placements)) {
    for (const [i, p] of normalized.placements.entries()) {
      if (!p || typeof p !== "object") {
        allErrors.push(`placements[${i}] must be a mapping`);
        continue;
      }
      if (!p.id) allErrors.push(`placements[${i}].id missing`);
      if (!p.module) allErrors.push(`placements[${i}].module missing`);
      else if (allowedModules && !allowedModules.includes(p.module)) {
        allErrors.push(`placements[${i}].module '${p.module}' not in allowed_modules`);
      }
      if (!p.anchor || !Number.isFinite(p.anchor.x) || !Number.isFinite(p.anchor.y)) {
        allErrors.push(`placements[${i}].anchor must be {x,y}`);
      }
      if (!["north", "east", "south", "west"].includes(p.direction)) {
        allErrors.push(`placements[${i}].direction must be one of north/east/south/west`);
      }
    }
  }
  return { effective: normalized, errors: allErrors, warnings, unwrapped };
}

/**
 * Validate authored module artefacts in the staged directory after the
 * Designer claims to have written them. Each authored id must produce a yaml
 * that passes lib-loader's validateModule, and a corresponding blueprint
 * .json that is at least a parseable object with a non-empty entities array.
 * (Deeper geometry validation runs in dry-validate.js via execute_blueprint
 * dryRun — no need to duplicate it here.)
 *
 * @param {string} stagedDir
 * @param {string[]} expectedIds
 * @returns {Promise<{errors: string[], authored: object[]}>}
 */
async function validateStagedModules(stagedDir, expectedIds) {
  const errors = [];
  const authored = [];
  let entries;
  try {
    entries = await readdir(stagedDir);
  } catch (error) {
    if (error.code === "ENOENT") {
      for (const id of expectedIds) {
        errors.push(`expected staged module '${id}' but staged-modules/ does not exist`);
      }
      return { errors, authored };
    }
    throw error;
  }
  const yamlNames = new Set(entries.filter((e) => /\.(ya?ml)$/.test(e)));
  const jsonNames = new Set(entries.filter((e) => /\.json$/.test(e)));
  for (const id of expectedIds) {
    const yamlBase = `${id}.yaml`;
    const ymlBase = `${id}.yml`;
    const jsonBase = `${id}.json`;
    if (!yamlNames.has(yamlBase) && !yamlNames.has(ymlBase)) {
      errors.push(`expected staged module '${id}' yaml at staged-modules/${yamlBase} (or .yml) — not found`);
      continue;
    }
    const yamlPath = join(stagedDir, yamlNames.has(yamlBase) ? yamlBase : ymlBase);
    let module;
    try {
      module = await loadModule(yamlPath);
    } catch (error) {
      errors.push(`staged module '${id}' yaml failed schema: ${error.message}`);
      continue;
    }
    if (module.id !== id) {
      errors.push(`staged module yaml at ${yamlPath} declares id '${module.id}' but is expected to declare '${id}'`);
      continue;
    }
    if (!jsonNames.has(jsonBase)) {
      errors.push(`expected staged blueprint at staged-modules/${jsonBase} — not found`);
      continue;
    }
    const jsonPath = join(stagedDir, jsonBase);
    let blueprint;
    try {
      blueprint = JSON.parse(await readFile(jsonPath, "utf8"));
    } catch (error) {
      errors.push(`staged blueprint '${id}' is not valid JSON: ${error.message}`);
      continue;
    }
    if (!Array.isArray(blueprint.entities) || blueprint.entities.length === 0) {
      errors.push(`staged blueprint '${id}' must have a non-empty entities array`);
      continue;
    }
    authored.push({ id, yamlPath, jsonPath, module });
  }
  return { errors, authored };
}

/**
 * @param {object} args
 * @param {object} args.config
 * @param {object} args.epoch
 * @param {object} args.state          — from probe phase
 * @param {string} args.probeDir       — plans/<run>/probe/ (state.yaml lives here)
 * @param {string} args.outDir         — plans/<run>/design/
 * @param {string} [args.stagedDir]    — plans/<run>/staged-modules/ (created if epoch.allow_module_creation)
 * @param {Array<object>} [args.previousAttempts] — prior failed attempts in this run.
 *                  Each entry: {attempt, plan?, verdict?, authored?, error?}.
 *                  Used by the recovery loop to brief the LLM on what already
 *                  failed; absent on the first attempt.
 * @returns {Promise<{planPath: string, plan: object, raw: object, authored: object[]}>}
 */
export async function runDesign({ config, epoch, state, probeDir, outDir, stagedDir, previousAttempts = [], historyPath = null }) {
  await mkdir(outDir, { recursive: true });
  await copyFile(join(probeDir, "state.yaml"), join(outDir, "state.yaml"));
  await copyFile(epoch._path, join(outDir, "epoch.yaml"));
  if (historyPath) {
    await copyFile(historyPath, join(outDir, "designer-history.yaml"));
  }
  // Surface the lib/ tree read-only inside the design cwd so the agent can
  // grep modules and read blueprints without being able to escape upward.
  await ensureSymlink(config.libDir, join(outDir, "lib"));

  // If the epoch allows module creation, surface a writable staged-modules/
  // directory inside the design cwd. The Designer writes new module yaml +
  // blueprint json there; this runner validates them after the pi exits and
  // the executor + audit treat them as first-class lib entries until the
  // outer epoch.js promotes them to lib/ on audit pass.
  const allowAuthor = !!epoch.allow_module_creation && !!stagedDir;
  if (allowAuthor) {
    await mkdir(stagedDir, { recursive: true });
    await ensureSymlink(stagedDir, join(outDir, "staged-modules"));
  }

  const systemPrompt = await readFile(resolve(config.rootDir, "prompts/design.md"), "utf8");
  const factorioApiDocsExt = resolve(config.rootDir, ".pi/extensions/factorio-api-docs/index.ts");

  const allowedModulesList = (epoch.allowed_modules || []).join(", ") || "(none)";

  // Determine which allowed_modules ids are absent from lib/ and therefore
  // need to be authored by this Designer run. We snapshot the lib once,
  // before pi runs, so the missing list is stable across attempts.
  let mustAuthorIds = [];
  if (allowAuthor) {
    const libModuleIds = await readdir(join(config.libDir, "modules")).catch(() => [])
      .then((ents) => new Set(ents
        .filter((e) => /\.(ya?ml)$/.test(e))
        .map((e) => e.replace(/\.(ya?ml)$/, ""))));
    mustAuthorIds = (epoch.allowed_modules || []).filter((id) => !libModuleIds.has(id));
  }

  const userMessageLines = [
    `Emit a placement specification for epoch ${epoch.id}.`,
    ``,
    `Inputs in your cwd:`,
    `  - state.yaml (probe output)`,
    `  - epoch.yaml`,
    `  - lib/modules/*.yaml, lib/blueprints/*.json (read-only)`,
    ...(allowAuthor ? [`  - staged-modules/ (writable: place new module files here)`] : []),
    ``,
    `Allowed modules: ${allowedModulesList}`,
  ];
  if (mustAuthorIds.length > 0) {
    userMessageLines.push(
      ``,
      `MODULE AUTHORING REQUIRED. The following allowed_modules ids are NOT`,
      `present in lib/modules/ and you MUST author them before plan.yaml:`,
      ...mustAuthorIds.map((id) => `  - ${id}`),
      ``,
      `For each id, write two files into staged-modules/:`,
      `  - staged-modules/<id>.yaml — module definition (use any existing`,
      `    lib/modules/*.yaml as a shape reference; declare id, version,`,
      `    inputs, outputs (with port name/side/rel_pos/throughput/item/kind),`,
      `    power, footprint (anchor-relative bbox covering all entities),`,
      `    preconditions (resource_patch with min_tiles), realization`,
      `    (blueprint: lib/blueprints/<id>.json — anticipates promotion),`,
      `    audits.`,
      `  - staged-modules/<id>.json — blueprint with anchor-relative dx/dy,`,
      `    direction per entity, optional fuel[] for pre-loaded burner items.`,
      `    Use existing lib/blueprints/*.json as a shape reference.`,
      ``,
      `After writing the staged files, write plan.yaml that places one (or`,
      `more) instance(s) of the new module at a viable anchor.`,
    );
  }
  userMessageLines.push(
    ``,
    `OUTPUT plan.yaml: write a single file plan.yaml in cwd. The validator`,
    `requires EXACTLY these 5 top-level keys, no more, no less:`,
    ``,
    `  epoch: ${epoch.id}`,
    `  placements:`,
    `    - id: p0                                # short string`,
    `      module: <one of the allowed modules>`,
    `      anchor: { x: <number>, y: <number> }`,
    `      direction: <north|east|south|west>    # lowercase only`,
    `  connections: []                           # use [] if single placement`,
    `  expected_throughput: <number>             # items/s of target item`,
    `  scaling_note: <one-sentence string>`,
    ``,
    `You are NOT writing a runbook. Do NOT add: id (top-level), created,`,
    `steps, kind, action, depends_on, formula, assert, entities, risks,`,
    `success_criteria, version, module (top-level), starter_fuel, anchor`,
    `(top-level), or any per-step structure. The runner walks, places,`,
    `seeds fuel, waits, audits, and saves on its own; your only job is to`,
    `pick which module to place and where (and, if required above, to`,
    `author the module first).`,
    ``,
    `Read state.yaml for world coordinates and lib/modules/ for module`,
    `footprints, then write plan.yaml and exit.`,
  );
  if (previousAttempts.length > 0) {
    userMessageLines.push(
      ``,
      `--- TASK HISTORY ---`,
      `This is attempt ${previousAttempts.length + 1}. Read \`designer-history.yaml\``,
      `in your working directory — it contains every prior attempt's placements,`,
      `expected_throughput, scaling_note, and audit result (measured vs threshold).`,
      `Use this history to reason about what strategy to change, not just which`,
      `anchor to move. Consider whether the throughput gap requires a different`,
      `number of placements, not just a different position.`,
      `--- END TASK HISTORY ---`,
    );
  }
  const userMessage = userMessageLines.join("\n");

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

  // Per-phase trace: every piInvoke() result is folded in (the schema-retry
  // path may add a second invocation). Includes previous_attempts so the
  // summary tool can highlight retried recovery attempts vs first tries.
  const trace = newTrace("design", { previous_attempts: previousAttempts.length });

  let result, text, parsed, validation, errors, authored = [];
  try {
    // First attempt.
    result = await piInvoke({ ...piOpts, prompt: userMessage });
    addPiCall(trace, result);

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

    text = await readFile(planPath, "utf8").catch(() => null);
    parsed = text ? parseYaml(text) : null;
    validation = parsed ? validatePlan(parsed, epoch.allowed_modules)
                            : { effective: null, errors: ["plan.yaml not produced"], warnings: [], unwrapped: false };
    errors = validation.errors;
    for (const w of validation.warnings || []) console.log(`[design normalize] ${w}`);
    if (validation.effective) parsed = validation.effective;

    // If module authoring was required, validate the staged artefacts. Errors
    // here join the plan errors so retry feedback covers both at once.
    if (mustAuthorIds.length > 0) {
      const stagedResult = await validateStagedModules(stagedDir, mustAuthorIds);
      authored = stagedResult.authored;
      errors = [...errors, ...stagedResult.errors];
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
        `  scaling_note: <one-sentence string>`,
        ``,
        `Do NOT add: steps, entities, risks, success_criteria, kind, action,`,
        `depends_on, formula, assert, version, starter_fuel, id (top-level),`,
        `created, or any other key. You are emitting a placement spec, not a`,
        `runbook.`,
      ].join("\n");
      console.log(`[design] schema validation failed; retrying with error feedback`);
      const retryResult = await piInvoke({ ...piOpts, prompt: retryMessage });
      addPiCall(trace, retryResult);
      trace.schema_retry = true;

      text = await readFile(planPath, "utf8").catch(() => null);
      parsed = text ? parseYaml(text) : null;
      validation = parsed ? validatePlan(parsed, epoch.allowed_modules)
                          : { effective: null, errors: ["plan.yaml not produced on retry"], warnings: [], unwrapped: false };
      errors = validation.errors;
      for (const w of validation.warnings || []) console.log(`[design normalize] ${w} (retry)`);
      if (validation.effective) parsed = validation.effective;
      if (mustAuthorIds.length > 0) {
        const stagedResult = await validateStagedModules(stagedDir, mustAuthorIds);
        authored = stagedResult.authored;
        errors = [...errors, ...stagedResult.errors];
      }
    }
  } finally {
    // Always persist trace so summary tooling sees actual wall time / tokens
    // even when piInvoke throws (e.g. timeout). Non-fatal if write fails.
    await writePiTrace(outDir, trace).catch((e) => console.log(`[design] trace write failed (non-fatal): ${e.message}`));
  }

  if (!text) throw new Error(`design phase did not produce plan.yaml in ${outDir}`);
  if (errors.length) {
    throw new Error(`design phase produced invalid plan.yaml or staged modules:\n  ${errors.join("\n  ")}`);
  }
  return { planPath, plan: parsed, raw: result, authored };
}
