// probe.js — Probe phase. Spawns `pi -p` with read-only Factorio tools to
// produce state.yaml. The pi process runs in plans/<run>/probe/ with the
// vendored extensions and prompts/probe.md pinned as its system prompt
// addendum. The Factorio service must already be running.
import { mkdir, readFile, writeFile, symlink, lstat, copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { piInvoke } from "../pi-invoke.js";
import { normalize, STATE_SCHEMA } from "./schema-norm.js";
import { probeCacheKey, readProbeCache, writeProbeCache } from "./probe-cache.js";

async function ensureSymlink(target, linkPath) {
  try {
    const info = await lstat(linkPath);
    if (info.isSymbolicLink() || info.isDirectory()) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await symlink(target, linkPath);
}

// validateState runs the unified normalizer against STATE_SCHEMA, then layers
// type checks on the required fields. The normalizer absorbs Pattern B/C
// drift (wrapper-nesting, surplus top-level keys) without forcing a retry;
// only Pattern A (required fields actually missing) and type mismatches
// produce errors that trigger the retry path.
function validateState(parsed) {
  const { normalized, errors, warnings, unwrapped } = normalize(parsed, STATE_SCHEMA);
  const allErrors = [...errors];
  if (normalized) {
    if (normalized.tick !== undefined && !Number.isFinite(normalized.tick)) {
      allErrors.push("tick must be a number");
    }
    if (normalized.worker && (!normalized.worker.position
        || !Number.isFinite(normalized.worker.position.x)
        || !Number.isFinite(normalized.worker.position.y))) {
      allErrors.push("worker.position must be {x,y}");
    }
  }
  return { effective: normalized, errors: allErrors, warnings, unwrapped };
}

/**
 * @param {object} args
 * @param {object} args.config
 * @param {object} args.epoch       — parsed epoch yaml
 * @param {string} args.outDir      — plans/<run>/probe/ (will be created)
 * @param {string} [args.inputSavePath] — absolute path to the input save zip
 *                  (for cache keying; if absent, cache is skipped entirely)
 * @returns {Promise<{stateYamlPath: string, state: object, raw: object, cacheHit: boolean}>}
 */
export async function runProbe({ config, epoch, outDir, inputSavePath }) {
  await mkdir(outDir, { recursive: true });
  // Surface lib/probes as `lib/` inside the phase cwd so the prompt's path
  // hints (`lib/find-coal-patch.lua`) resolve through pi's read tool.
  await mkdir(join(outDir, "lib"), { recursive: true });
  await ensureSymlink(join(config.libDir, "probes"), join(outDir, "lib", "probes"));
  // Stash the epoch definition so the model can read it via `read epoch.yaml`.
  await copyFile(epoch._path, join(outDir, "epoch.yaml"));

  const stateYamlPath = join(outDir, "state.yaml");
  const probePromptPath = resolve(config.rootDir, "prompts/probe.md");
  const probesDir = resolve(config.libDir, "probes");
  const cacheDir = resolve(config.rootDir, "state/cache/probe");

  // Cache lookup: key by (input save bytes, epoch.yaml bytes, probe.md
  // bytes, all probe lua scripts bytes). A hit means we can skip the pi
  // call entirely and reuse a previously-validated state.yaml. Misses fall
  // through to the normal pi flow; on success the result is cached.
  let cacheKey = null;
  if (inputSavePath) {
    cacheKey = await probeCacheKey({
      inputSavePath,
      epochYamlPath: epoch._path,
      probePromptPath,
      probesDir,
    });
    const hit = await readProbeCache(cacheDir, cacheKey);
    if (hit) {
      await writeFile(stateYamlPath, hit.stateYaml, "utf8");
      const parsed = parseYaml(hit.stateYaml);
      const validation = validateState(parsed);
      // Re-validation is defensive: a cached entry written by a buggy build
      // shouldn't be silently honored. If it fails today's validator, fall
      // through to a fresh pi run.
      if (!validation.errors.length) {
        console.log(`[probe] cache hit (${cacheKey}) — skipping pi`);
        return {
          stateYamlPath,
          state: validation.effective,
          raw: { cached: true, meta: hit.meta },
          cacheHit: true,
        };
      }
      console.log(`[probe] cache hit (${cacheKey}) but stale (validator rejected); re-running pi`);
    }
  }

  const systemPrompt = await readFile(probePromptPath, "utf8");

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

  // First attempt.
  const result = await piInvoke({ ...piOpts, prompt: userMessage });

  let text = await readFile(stateYamlPath, "utf8").catch(() => null);
  let parsed = text ? parseYaml(text) : null;
  let validation = parsed ? validateState(parsed) : { effective: null, errors: ["state.yaml not produced"], warnings: [], unwrapped: false };
  let errors = validation.errors;
  for (const w of validation.warnings || []) console.log(`[probe normalize] ${w}`);
  if (validation.effective) parsed = validation.effective;

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
    validation = parsed ? validateState(parsed) : { effective: null, errors: ["state.yaml not produced on retry"], warnings: [], unwrapped: false };
    errors = validation.errors;
    for (const w of validation.warnings || []) console.log(`[probe normalize] ${w} (retry)`);
    if (validation.effective) parsed = validation.effective;
  }

  if (!text) {
    throw new Error(`probe phase did not produce state.yaml in ${outDir}`);
  }
  if (errors.length) {
    throw new Error(`probe phase produced invalid state.yaml:\n  ${errors.join("\n  ")}`);
  }

  // Persist a successful probe to cache so subsequent epoch runs (or a
  // retry within this run) can skip the pi call. The cache write is keyed
  // on the same inputs as the lookup; we do this AFTER schema validation
  // so a buggy partial output never poisons the cache.
  if (cacheKey) {
    try {
      await writeProbeCache(cacheDir, cacheKey, text, {
        epoch_id: epoch.id,
        input_save: inputSavePath,
        tick: parsed.tick,
      });
      console.log(`[probe] cached state.yaml under key ${cacheKey}`);
    } catch (error) {
      console.log(`[probe] cache write failed (non-fatal): ${error.message}`);
    }
  }

  return { stateYamlPath, state: parsed, raw: result, cacheHit: false };
}
