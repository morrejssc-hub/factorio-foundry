// probe.js — Probe phase. Spawns `pi -p` with read-only Factorio tools to
// produce state.yaml. The pi process runs in plans/<run>/probe/ with the
// vendored extensions and prompts/probe.md pinned as its system prompt
// addendum. The Factorio service must already be running.
import { mkdir, readFile, writeFile, symlink, lstat, copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { piInvoke } from "../pi-invoke.js";

const REQUIRED_FIELDS = ["tick", "worker", "inventory_summary", "coal_patches", "iron_patches"];

async function ensureSymlink(target, linkPath) {
  try {
    const info = await lstat(linkPath);
    if (info.isSymbolicLink() || info.isDirectory()) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await symlink(target, linkPath);
}

function validateState(parsed) {
  const errors = [];
  for (const f of REQUIRED_FIELDS) {
    if (!(f in parsed)) errors.push(`missing field: ${f}`);
  }
  if (parsed.tick !== undefined && !Number.isFinite(parsed.tick)) errors.push("tick must be a number");
  if (parsed.worker && (!parsed.worker.position
      || !Number.isFinite(parsed.worker.position.x)
      || !Number.isFinite(parsed.worker.position.y))) {
    errors.push("worker.position must be {x,y}");
  }
  return errors;
}

/**
 * @param {object} args
 * @param {object} args.config
 * @param {object} args.epoch       — parsed epoch yaml
 * @param {string} args.outDir      — plans/<run>/probe/ (will be created)
 * @returns {Promise<{stateYamlPath: string, state: object, raw: object}>}
 */
export async function runProbe({ config, epoch, outDir }) {
  await mkdir(outDir, { recursive: true });
  // Surface lib/probes as `lib/` inside the phase cwd so the prompt's path
  // hints (`lib/find-coal-patch.lua`) resolve through pi's read tool.
  await mkdir(join(outDir, "lib"), { recursive: true });
  await ensureSymlink(join(config.libDir, "probes"), join(outDir, "lib", "probes"));
  // Stash the epoch definition so the model can read it via `read epoch.yaml`.
  await copyFile(epoch._path, join(outDir, "epoch.yaml"));

  const systemPrompt = await readFile(resolve(config.rootDir, "prompts/probe.md"), "utf8");

  const factorioServerExt = resolve(config.rootDir, ".pi/extensions/factorio-server/index.ts");
  const factorioApiDocsExt = resolve(config.rootDir, ".pi/extensions/factorio-api-docs/index.ts");

  const userMessage = [
    `Run the Probe phase for epoch ${epoch.id}.`,
    `Epoch goal: ${epoch.goal || "see epoch.yaml"}.`,
    `Target metric: ${JSON.stringify(epoch.target_metric)}.`,
    `Allowed modules: ${(epoch.allowed_modules || []).join(", ") || "none"}.`,
    `Write state.yaml to the current working directory and exit.`,
  ].join("\n");

  const piOpts = {
    systemPrompt,
    tools: ["read", "write", "ls", "grep", "find", "factorio_read", "factorio_api_docs"],
    extensions: [factorioServerExt, factorioApiDocsExt],
    cwd: outDir,
    serviceUrl: config.serviceUrl,
    timeoutMs: epoch.budgets?.probe_timeout_ms ?? 600_000,
    onStdout: (line) => console.log(`[probe pi] ${line}`),
    onStderr: (line) => process.stderr.write(`[probe pi err] ${line}\n`),
  };

  const stateYamlPath = join(outDir, "state.yaml");

  // First attempt.
  const result = await piInvoke({ ...piOpts, prompt: userMessage });

  let text = await readFile(stateYamlPath, "utf8").catch(() => null);
  let parsed = text ? parseYaml(text) : null;
  let errors = parsed ? validateState(parsed) : ["state.yaml not produced"];

  // One retry: if the first attempt failed schema (or didn't write the file),
  // feed the previous attempt's content + validator errors back to a fresh
  // pi session so the model can correct it. Bounded to one retry — if the
  // model can't recover from explicit error feedback, escalate to user.
  if (errors.length) {
    const previousYaml = text ?? "(no state.yaml was written)";
    const errorList = errors.map((e) => `  - ${e}`).join("\n");
    const retryMessage = [
      `Your previous Probe phase output failed schema validation.`,
      ``,
      `Errors from the deterministic validator:`,
      errorList,
      ``,
      `Your previous state.yaml content (truncated to 4000 chars):`,
      "```yaml",
      previousYaml.slice(0, 4000),
      "```",
      ``,
      `Re-emit a corrected state.yaml at the bare relative path \`state.yaml\``,
      `(no absolute paths, no \`..\`, no subdirectories). The required schema`,
      `is in your system prompt — re-read it. The validator only accepts the`,
      `keys: tick, worker, inventory_summary, coal_patches, iron_patches,`,
      `notes (optional). No other top-level keys.`,
      ``,
      `Use factorio_read again only if you need to re-confirm a value; you`,
      `may also reuse facts from your previous attempt above.`,
    ].join("\n");
    console.log(`[probe] schema validation failed; retrying with error feedback`);
    await piInvoke({ ...piOpts, prompt: retryMessage });

    text = await readFile(stateYamlPath, "utf8").catch(() => null);
    parsed = text ? parseYaml(text) : null;
    errors = parsed ? validateState(parsed) : ["state.yaml not produced on retry"];
  }

  if (!text) {
    throw new Error(`probe phase did not produce state.yaml in ${outDir}`);
  }
  if (errors.length) {
    throw new Error(`probe phase produced invalid state.yaml:\n  ${errors.join("\n  ")}`);
  }
  return { stateYamlPath, state: parsed, raw: result };
}
