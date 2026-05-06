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

async function ensureSymlink(target, linkPath) {
  try {
    const info = await lstat(linkPath);
    if (info.isSymbolicLink() || info.isDirectory()) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await symlink(target, linkPath);
}

function validatePlan(parsed, allowedModules) {
  const errors = [];
  for (const f of ["epoch", "placements", "connections", "expected_throughput", "why_not_replicate"]) {
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

  const userMessage = [
    `Run the Design phase for epoch ${epoch.id}.`,
    `Read state.yaml, epoch.yaml, and lib/ to understand inputs.`,
    `Write plan.yaml using only modules from epoch.allowed_modules.`,
    `You have NO factorio tools — only file tools and factorio_api_docs.`,
  ].join("\n");

  const result = await piInvoke({
    prompt: userMessage,
    systemPrompt,
    tools: ["read", "write", "ls", "grep", "find", "factorio_api_docs"],
    extensions: [factorioApiDocsExt],
    cwd: outDir,
    serviceUrl: config.serviceUrl,
    timeoutMs: epoch.budgets?.design_timeout_ms ?? 600_000,
    onStdout: (line) => console.log(`[design pi] ${line}`),
    onStderr: (line) => process.stderr.write(`[design pi err] ${line}\n`),
  });

  // Hard verification of the architectural invariant: design phase stdout
  // must contain zero factorio_action / factorio_read tool invocations.
  for (const pattern of FORBIDDEN_TOOL_PATTERNS) {
    if (pattern.test(result.stdout)) {
      throw new Error(
        `design phase violated tool boundary: stdout contains '${pattern}' — `
        + `the LLM tried to invoke a Factorio world tool. This is the bug `
        + `the architecture is supposed to prevent.`,
      );
    }
  }

  const planPath = join(outDir, "plan.yaml");
  const text = await readFile(planPath, "utf8").catch(() => null);
  if (!text) throw new Error(`design phase did not produce plan.yaml in ${outDir}`);
  const parsed = parseYaml(text);
  const errors = validatePlan(parsed, epoch.allowed_modules);
  if (errors.length) {
    throw new Error(`design phase produced invalid plan.yaml:\n  ${errors.join("\n  ")}`);
  }
  return { planPath, plan: parsed, raw: result };
}
