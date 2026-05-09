// design.js — Design phase. Spawns `pi -p` with read-only Factorio access
// (factorio_read via the foundry-read extension) but WITHOUT factorio_action.
// The designer can probe the live game for targeted queries (tile info,
// placement validation, resource scans) but cannot place anything.
// Output: plan.yaml.
//
// This is the architectural lever that prevents the "4-miner copy" bug seen
// in ~/factorio-agent: the agent literally cannot place anything, so its
// only output channel is a written plan. Composition replaces improvisation.
import { mkdir, readFile, copyFile, symlink, lstat, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { piInvoke } from "../pi-invoke.js";
import { normalize, PLAN_SCHEMA, DECOMPOSITION_SCHEMA } from "./schema-norm.js";
import { loadModule, loadAllModulesWithStaged } from "../lib-loader.js";
import { worldMdPath, readWorldMd } from "./world-md.js";
import { newTrace, addPiCall, writePiTrace } from "./pi-trace.js";
import { runSubDesigners } from "./sub-designer.js";
import { injectConnectors } from "./connector-injector.js";

const FORBIDDEN_TOOL_PATTERNS = [
  /tool[_-]?name["']?\s*[:=]\s*["']?factorio_action/i,
  /\bfactorio_action\s*\(/,
  // pi --mode json tool-call events serialize the tool name as a JSON string.
  // factorio_action is forbidden; factorio_read is allowed (read-only probes).
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

// validatePlan runs the unified normalizer against PLAN_SCHEMA, then layers
// per-placement type checks (id/module/anchor/direction). The normalizer
// absorbs Pattern B/C drift; only Pattern A (required fields actually
// missing) triggers retry.
export function validatePlan(parsed, allowedModules) {
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
  // preparation is optional, but if present every entry must be well-formed
  // so the executor doesn't have to defend against shape drift at runtime.
  if (normalized && normalized.preparation !== undefined) {
    if (!Array.isArray(normalized.preparation)) {
      allErrors.push("preparation must be an array");
    } else {
      for (const [i, op] of normalized.preparation.entries()) {
        if (!op || typeof op !== "object") {
          allErrors.push(`preparation[${i}] must be a mapping`);
          continue;
        }
        if (op.kind !== "deconstruct") {
          allErrors.push(`preparation[${i}].kind '${op.kind}' unsupported (only 'deconstruct' is implemented)`);
          continue;
        }
        if (!op.position || !Number.isFinite(op.position.x) || !Number.isFinite(op.position.y)) {
          allErrors.push(`preparation[${i}].position must be {x, y} with finite numbers`);
        }
        if (op.entity !== undefined && (typeof op.entity !== "string" || !op.entity)) {
          allErrors.push(`preparation[${i}].entity must be a non-empty string when present`);
        }
      }
    }
  }
  return { effective: normalized, errors: allErrors, warnings, unwrapped };
}

// Validate the parent designer's decomposition output. Runs DECOMPOSITION_SCHEMA
// normalization, then deeper structural checks (region non-overlap, paired_with
// references resolve to declared inputs). Per-fragment validation lives in
// sub-designer.js; per-pairing routeBelt feasibility lives in connector-injector.js.
function validateDecomposition(parsed) {
  const { normalized, errors, warnings, unwrapped } = normalize(parsed, DECOMPOSITION_SCHEMA);
  const allErrors = [...errors];
  if (!normalized) return { effective: null, errors: allErrors, warnings, unwrapped };

  if (normalized.mode !== "decompose") {
    allErrors.push(`mode must be "decompose" (got "${normalized.mode}")`);
  }
  if (typeof normalized.epoch !== "string") {
    allErrors.push(`epoch must be a string`);
  }
  if (!Array.isArray(normalized.subs)) {
    allErrors.push(`subs must be an array`);
    return { effective: normalized, errors: allErrors, warnings, unwrapped };
  }
  if (normalized.subs.length < 2) {
    allErrors.push(`decomposition with fewer than 2 subs is not useful — use single-mode plan.yaml instead`);
  }

  const subIds = new Set();
  for (const [i, s] of normalized.subs.entries()) {
    if (!s || typeof s !== "object") {
      allErrors.push(`subs[${i}] must be a mapping`);
      continue;
    }
    if (!s.id || typeof s.id !== "string") {
      allErrors.push(`subs[${i}].id missing or not a string`);
      continue;
    }
    if (subIds.has(s.id)) allErrors.push(`subs[${i}].id "${s.id}" is duplicated`);
    else subIds.add(s.id);
    if (!s.region
        || !Number.isFinite(s.region.x_min) || !Number.isFinite(s.region.x_max)
        || !Number.isFinite(s.region.y_min) || !Number.isFinite(s.region.y_max)) {
      allErrors.push(`subs[${i}].region must be {x_min, x_max, y_min, y_max} all numbers`);
    }
    if (s.contract && typeof s.contract === "object") {
      for (const [j, o] of (s.contract.outputs || []).entries()) {
        if (!o || !o.id || !o.item || !o.paired_with) {
          allErrors.push(`subs[${i}].contract.outputs[${j}] must have id, item, paired_with`);
        }
      }
      for (const [j, p] of (s.contract.inputs || []).entries()) {
        if (!p || !p.id || !p.item || !p.paired_with) {
          allErrors.push(`subs[${i}].contract.inputs[${j}] must have id, item, paired_with`);
        }
      }
    }
  }

  // Pairwise region non-overlap (entities in two subs would collide).
  for (let i = 0; i < normalized.subs.length; i++) {
    for (let j = i + 1; j < normalized.subs.length; j++) {
      const a = normalized.subs[i].region;
      const b = normalized.subs[j].region;
      if (!a || !b) continue;
      if (a.x_min < b.x_max && b.x_min < a.x_max
          && a.y_min < b.y_max && b.y_min < a.y_max) {
        allErrors.push(
          `subs[${i}] (${normalized.subs[i].id}) and subs[${j}] (${normalized.subs[j].id}) regions overlap`,
        );
      }
    }
  }

  // paired_with references resolve to declared inputs/outputs on the other sub.
  for (const sub of normalized.subs) {
    for (const o of (sub.contract?.outputs || [])) {
      if (typeof o.paired_with === "string" && o.paired_with.includes(".")) {
        const [otherId, otherPort] = o.paired_with.split(".", 2);
        const otherSub = normalized.subs.find((s) => s.id === otherId);
        if (!otherSub) {
          allErrors.push(`sub ${sub.id}: contract.outputs.${o.id}.paired_with references unknown sub "${otherId}"`);
        } else if (!(otherSub.contract?.inputs || []).find((p) => p.id === otherPort)) {
          allErrors.push(`sub ${sub.id}: contract.outputs.${o.id}.paired_with references unknown input "${otherPort}" on sub ${otherId}`);
        }
      }
    }
    for (const inp of (sub.contract?.inputs || [])) {
      if (typeof inp.paired_with === "string" && inp.paired_with.includes(".")) {
        const [otherId, otherPort] = inp.paired_with.split(".", 2);
        const otherSub = normalized.subs.find((s) => s.id === otherId);
        if (!otherSub) {
          allErrors.push(`sub ${sub.id}: contract.inputs.${inp.id}.paired_with references unknown sub "${otherId}"`);
        } else if (!(otherSub.contract?.outputs || []).find((p) => p.id === otherPort)) {
          allErrors.push(`sub ${sub.id}: contract.inputs.${inp.id}.paired_with references unknown output "${otherPort}" on sub ${otherId}`);
        }
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
    // Module-creation epochs may need a fresh audit lua too. Any audits[]
    // entry whose script path starts with `staged-modules/` must resolve to
    // a real .lua file inside stagedDir; we record those for promotion.
    const stagedAudits = [];
    let auditError = false;
    for (const a of (module.audits || [])) {
      const rel = a.script || "";
      if (!rel.startsWith("staged-modules/")) continue;
      const base = rel.slice("staged-modules/".length);
      if (!entries.includes(base)) {
        errors.push(`staged module '${id}' audit '${a.id}' references ${rel} but file not found in staged-modules/`);
        auditError = true;
        continue;
      }
      stagedAudits.push({ auditId: a.id, basename: base, stagedPath: join(stagedDir, base) });
    }
    if (auditError) continue;
    authored.push({ id, yamlPath, jsonPath, stagedAudits, module });
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

  // Surface state/world.md — cross-epoch agent notebook. Contains the
  // deployed-modules fence (which probe also uses to derive
  // world_inventory) plus free-form prose annotations from prior
  // attempts. Symlinked so any prose edits the Designer makes land back
  // in the canonical file.
  const wmPath = worldMdPath(config);
  // Ensure the file exists before symlinking — readWorldMd creates from
  // template on first access.
  await readWorldMd(wmPath);
  await ensureSymlink(wmPath, join(outDir, "world.md"));

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

  // Test seam: when epoch._fixture.attempts[i] is set, copy the fixture's
  // plan.yaml + staged-modules into the design cwd and skip the LLM call.
  // Production epochs never set this key. Used by epochs/e_test_proposal-loop.yaml
  // to deterministically force a known-bad plan and exercise the executor
  // proposal-loop end-to-end without depending on LLM cooperation.
  const fixtureBase = epoch._fixture?.attempts?.[previousAttempts.length];
  if (fixtureBase) {
    const fixtureDir = resolve(config.rootDir, fixtureBase);
    const planPath = join(outDir, "plan.yaml");
    const planText = await readFile(join(fixtureDir, "plan.yaml"), "utf8");
    await writeFile(planPath, planText, "utf8");
    if (allowAuthor) {
      const fixtureStaged = join(fixtureDir, "staged-modules");
      const entries = await readdir(fixtureStaged).catch(() => []);
      for (const e of entries) await copyFile(join(fixtureStaged, e), join(stagedDir, e));
    }
    const parsed = parseYaml(planText);
    const validation = validatePlan(parsed, epoch.allowed_modules);
    if (validation.errors.length) {
      throw new Error(`fixture ${fixtureBase} plan invalid: ${validation.errors.join("; ")}`);
    }
    console.log(`[design] fixture mode: loaded ${fixtureBase} (skipping LLM)`);
    return { planPath, plan: validation.effective, raw: { fixture: fixtureBase }, authored: [] };
  }

  const systemPrompt = await readFile(resolve(config.rootDir, "prompts/design.md"), "utf8");
  const factorioApiDocsExt = resolve(config.rootDir, ".pi/extensions/factorio-api-docs/index.ts");
  const foundryReadExt     = resolve(config.rootDir, ".pi/extensions/foundry-read/index.ts");

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
    `  - state.yaml (probe output: worker inv, resource patches,`,
    `    world_inventory — live counts of every chest registered in`,
    `    world.md's deployed-modules fence)`,
    `  - world.md (cross-epoch agent notebook: deployed-modules yaml fence`,
    `    plus free-form prose. The fence is what the probe enumerates;`,
    `    the prose is yours to read for context and edit if you want to`,
    `    leave notes for future epochs. Reference items in world_inventory`,
    `    before designing fresh mining — reuse beats re-extract.)`,
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
      `For each id, write two (or three) files into staged-modules/:`,
      `  - staged-modules/<id>.yaml — module definition (use any existing`,
      `    lib/modules/*.yaml as a shape reference; declare id, version,`,
      `    inputs, outputs (with port name/side/rel_pos/throughput/item/kind),`,
      `    power, footprint (anchor-relative bbox covering all entities),`,
      `    preconditions, realization (blueprint: lib/blueprints/<id>.json`,
      `    — anticipates promotion), audits.`,
      `    audits[].metric MUST match the epoch.target_metric.metric when`,
      `    the epoch uses goal-only target_metric. See prompts/design.md`,
      `    "Authoring new modules" → "Choosing the audit script".`,
      `  - staged-modules/<id>-audit.lua — ONLY when the metric is not an`,
      `    item rate (e.g. power_kw, pollution_per_s). For item rates reuse`,
      `    lib/audits/throughput-window.lua; do NOT write a new lua. The`,
      `    custom audit script returns JSON {ok, tick, measured, ...}.`,
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
    `OUTPUT plan.yaml: write a single file plan.yaml in cwd.`,
    ``,
    `Two modes are accepted — pick ONE based on the epoch goal:`,
    ``,
    `(A) Single mode — DEFAULT for most epochs. Validator requires EXACTLY`,
    `these 5 top-level keys, no more, no less:`,
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
    `(B) Decomposition mode — OPT-IN, only when the epoch goal asks for it`,
    `or the target naturally splits into multiple regions connected by`,
    `belts (>30 tiles apart). See the system prompt section "Decomposition`,
    `mode" for the full schema. Briefly, write THESE 3 top-level keys instead:`,
    ``,
    `  mode: decompose`,
    `  epoch: ${epoch.id}`,
    `  subs:                                      # array of {id, region, contract, allowed_modules?}`,
    `    - id: <region-id>`,
    `      region: { x_min, x_max, y_min, y_max }`,
    `      contract:`,
    `        inputs: [{ id, item, rate, paired_with: "<other_sub_id>.<port_id>" }]`,
    `        outputs: [{ id, item, rate, paired_with: "<other_sub_id>.<port_id>" }]`,
    ``,
    `In decomposition mode, the runner spawns one sub-designer per \`subs\``,
    `entry to fill placements; YOU do not write \`placements\` / \`connections\``,
    `/ \`expected_throughput\` / \`scaling_note\` at the top level — those are`,
    `synthesised. If the epoch yaml strongly suggests decomposition (e.g.`,
    `"this epoch verifies decomposition"), choose mode (B). Otherwise default`,
    `to (A).`,
    ``,
    `In EITHER mode you are NOT writing a runbook. Do NOT add: id (top-level),`,
    `created, steps, kind, action, depends_on, formula, assert, entities,`,
    `risks, success_criteria, version, module (top-level), starter_fuel,`,
    `anchor (top-level), or any per-step structure. The runner walks,`,
    `places, seeds fuel, waits, audits, and saves on its own.`,
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
    tools: ["read", "write", "ls", "grep", "find", "factorio_api_docs", "factorio_read"],
    extensions: [factorioApiDocsExt, foundryReadExt],
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

    if (parsed && parsed.mode === "decompose") {
      // ===== Decomposition path =====
      // Parent designer chose to split the epoch into N spatially independent
      // regions. Validate the decomposition output, spawn sub-designers in
      // parallel, then merge their fragments + inject inter-region connectors
      // algorithmically. The synthesized plan overwrites plan.yaml so the
      // downstream phases (dry-validate / execute / audit) consume the same
      // shape they always have. No in-call retry: errors throw and the outer
      // recovery_attempts loop in epoch.js retries the whole epoch with the
      // failure surfaced via designer-history.yaml.
      const dval = validateDecomposition(parsed);
      for (const w of dval.warnings || []) console.log(`[design normalize] ${w}`);
      if (dval.errors.length) {
        throw new Error(
          `decomposition output failed validation:\n  ` + dval.errors.join("\n  "),
        );
      }
      await writeFile(join(outDir, "decomposition.yaml"), stringifyYaml(dval.effective), "utf8");

      // Parent's authored modules need to be ratified before sub-designers
      // (and the connector injector's module map) consume them.
      if (mustAuthorIds.length > 0) {
        const stagedResult = await validateStagedModules(stagedDir, mustAuthorIds);
        authored = stagedResult.authored;
        if (stagedResult.errors.length) {
          throw new Error(
            `parent designer staged modules failed validation:\n  ` +
            stagedResult.errors.join("\n  "),
          );
        }
      }

      const subResults = await runSubDesigners({
        config, epoch,
        decomposition: dval.effective,
        probeDir,
        parentDesignDir: outDir,
        parentStagedDir: allowAuthor ? stagedDir : null,
        log: (m) => console.log(m),
      });
      await writeFile(
        join(outDir, "sub-designer-summary.json"),
        JSON.stringify(subResults.map((r) => ({
          sub_id: r.sub_id,
          ok: r.fragment != null && r.errors.length === 0,
          errors: r.errors,
          placements: r.fragment ? (r.fragment.placements || []).length : 0,
          ports: r.fragment ? Object.keys(r.fragment.ports || {}).length : 0,
          pi_call: r.raw ? {
            wall_ms: r.raw.wall_ms,
            usage: r.raw.usage,
            cost_usd: r.raw.cost?.total ?? 0,
            model: r.raw.model,
            provider: r.raw.provider,
            turns: r.raw.turns,
          } : null,
        })), null, 2),
        "utf8",
      );

      const modules = await loadAllModulesWithStaged(config.libDir, allowAuthor ? stagedDir : null);
      const ci = await injectConnectors({
        decomposition: dval.effective,
        subResults,
        modules,
        rootDir: config.rootDir,
      });
      if (ci.errors.length) {
        throw new Error(
          `connector injection failed:\n  ` + ci.errors.join("\n  "),
        );
      }

      // Overwrite plan.yaml with the synthesized plan, then run the same
      // PLAN_SCHEMA validator the single-mode path uses as a final guard.
      await writeFile(planPath, stringifyYaml(ci.plan), "utf8");
      text = stringifyYaml(ci.plan);
      validation = validatePlan(ci.plan, epoch.allowed_modules);
      errors = validation.errors;
      for (const w of validation.warnings || []) console.log(`[design normalize] ${w}`);
      if (validation.effective) parsed = validation.effective;
      if (errors.length) {
        throw new Error(
          `synthesized plan failed PLAN_SCHEMA:\n  ` + errors.join("\n  "),
        );
      }
      trace.decomposition = true;
      trace.subs_count = dval.effective.subs.length;
    } else {
      // ===== Single-mode path (existing behaviour) =====
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
