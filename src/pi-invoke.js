// pi-invoke.js — wraps `pi -p` (one-shot, non-interactive) with per-phase
// tool/extension/prompt/cwd config. Each invocation is a brand-new session
// (--no-session) so phases never share LLM context.
//
// Runs pi with `--mode json` and parses the stdout event stream so callers
// receive structured `usage` (token counts) and `cost` (USD) data. The full
// event stream is NOT persisted by piInvoke — only a per-call summary is
// returned. Callers wanting the human-readable assistant text continue to
// receive it via `onStdout` (the parser feeds back text_delta events as
// newline-flushed lines, preserving the legacy logging shape).
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * @typedef {object} PiUsage
 * @property {number} input
 * @property {number} output
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number} totalTokens
 */
/**
 * @typedef {object} PiCost
 * @property {number} input
 * @property {number} output
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number} total
 */

/**
 * @param {object} opts
 * @param {string} opts.prompt          — final user message
 * @param {string} [opts.systemPrompt]  — appended via temp file (--append-system-prompt @file)
 * @param {string[]} [opts.tools]       — `--tools a,b,c` allowlist
 * @param {string[]} [opts.extensions]  — absolute paths, each as `-e <path>`
 * @param {boolean} [opts.noExtensions] — `--no-extensions` (default false; auto-discovery is required so the parent `.pi/agent/settings.json` can register `packages` like the bailian model router. Pass true only for tests that intentionally isolate pi from project config.)
 * @param {boolean} [opts.noBuiltinTools] — `--no-builtin-tools`
 * @param {boolean} [opts.noContextFiles] — `--no-context-files` (default true; we drive prompts ourselves)
 * @param {boolean} [opts.noSkills]     — `--no-skills` (default true)
 * @param {string} [opts.cwd]           — pi process cwd (phase workdir)
 * @param {string} [opts.provider]
 * @param {string} [opts.model]
 * @param {string} [opts.thinking]
 * @param {object} [opts.env]
 * @param {number} [opts.timeoutMs]     — default 600_000 (10 min)
 * @param {string} [opts.serviceUrl]    — passed as FACTORIO_AGENT_SERVICE_URL
 * @param {(line: string) => void} [opts.onStderr]
 * @param {(line: string) => void} [opts.onStdout]
 * @returns {Promise<{stdout: string, stderr: string, code: number, signal: string|null,
 *                    usage: PiUsage, cost: PiCost, wall_ms: number,
 *                    model: string|null, provider: string|null, turns: number}>}
 */
export async function piInvoke(opts) {
  const {
    prompt,
    systemPrompt,
    tools,
    extensions = [],
    noExtensions = false,
    noBuiltinTools = false,
    noContextFiles = true,
    noSkills = true,
    cwd,
    provider,
    model,
    thinking,
    env = {},
    timeoutMs = 600_000,
    serviceUrl,
    onStderr,
    onStdout,
  } = opts;

  if (!prompt) throw new Error("piInvoke: prompt is required");
  if (!cwd) throw new Error("piInvoke: cwd is required");

  const args = ["-p", "--mode", "json", "--no-session"];
  if (noExtensions) args.push("--no-extensions");
  if (noContextFiles) args.push("--no-context-files");
  if (noSkills) args.push("--no-skills");
  if (noBuiltinTools) args.push("--no-builtin-tools");
  // Per-phase explicit extensions (factorio tools, etc.). These are required
  // because pi only auto-discovers `.pi/extensions/` from cwd, and runner
  // phases use cwd=plans/<run>/<phase>/ which doesn't have one. Provider
  // routers like bailian come from `packages` in `.pi/agent/settings.json`,
  // which IS walked up from cwd.
  for (const ext of extensions) args.push("-e", resolve(ext));
  // FOUNDRY_PI_EXTENSIONS: per-machine extension injection channel for
  // experiments. Use this when the extension lives at an absolute path
  // tied to the operator's machine (e.g. ~/factorio-agent/.pi/extensions/
  // local-openai-provider for trying a local llama.cpp endpoint). Use the
  // `packages` list in `.pi/agent/settings.json` instead when the
  // extension is portable (npm:foo or a path relative to the repo).
  // Comma-separated absolute paths.
  const extraExt = (process.env.FOUNDRY_PI_EXTENSIONS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const ext of extraExt) args.push("-e", resolve(ext));
  if (tools && tools.length) args.push("--tools", tools.join(","));
  // FOUNDRY_PI_MODEL / FOUNDRY_PI_PROVIDER let an operator pin the LLM for
  // every phase from one place (e.g. `FOUNDRY_PI_MODEL=glm-5 npm run epoch
  // e1-first-coal`). Per-call opts.{provider,model} still win when set. The
  // foundry-local `.pi/agent/settings.json` is the normal source of truth;
  // these env vars are an override channel.
  const effectiveProvider = provider ?? process.env.FOUNDRY_PI_PROVIDER;
  const effectiveModel = model ?? process.env.FOUNDRY_PI_MODEL;
  if (effectiveProvider) args.push("--provider", effectiveProvider);
  if (effectiveModel) args.push("--model", effectiveModel);
  if (thinking) args.push("--thinking", thinking);

  let scratchDir = null;
  if (systemPrompt) {
    scratchDir = await mkdtemp(join(tmpdir(), "pi-invoke-"));
    const promptFile = join(scratchDir, "system-append.md");
    await writeFile(promptFile, systemPrompt, "utf8");
    args.push("--append-system-prompt", `@${promptFile}`);
  }
  args.push(prompt);

  const childEnv = { ...process.env, ...env };
  if (serviceUrl) childEnv.FACTORIO_AGENT_SERVICE_URL = serviceUrl;

  return await new Promise((resolvePromise, reject) => {
    const startedAt = Date.now();
    const child = spawn("pi", args, {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutLine = "";
    let stderrLine = "";
    // Cap in-memory accumulation to prevent RangeError on long-running
    // agents (e.g. qwen3.6-plus with high thinking). stdout is only used
    // for the forbidden-tool pattern check in design.js, which fires early.
    const STDOUT_CAP = 8 * 1024 * 1024; // 8 MB

    // Aggregated metrics. Each `turn_end` event in the JSON stream contributes
    // its message.usage / message.cost; the last seen model + provider win.
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let model = null;
    let provider = null;
    let turns = 0;

    // Buffer to reconstruct the assistant's human-readable output from
    // text_delta events. Flushed line-by-line to onStdout so callers' logs
    // continue to look like "[probe pi] <human text>" instead of raw JSON.
    let textBuffer = "";
    const flushText = (final = false) => {
      if (!onStdout) return;
      let idx;
      while ((idx = textBuffer.indexOf("\n")) !== -1) {
        onStdout(textBuffer.slice(0, idx));
        textBuffer = textBuffer.slice(idx + 1);
      }
      if (final && textBuffer) {
        onStdout(textBuffer);
        textBuffer = "";
      }
    };

    const handleEvent = (event) => {
      if (!event || typeof event !== "object") return;
      switch (event.type) {
        case "message_update": {
          const ame = event.assistantMessageEvent;
          if (ame?.type === "text_delta" && typeof ame.delta === "string") {
            textBuffer += ame.delta;
            flushText(false);
          }
          break;
        }
        case "turn_end": {
          turns += 1;
          const u = event.message?.usage;
          const c = event.message?.cost;
          if (u) {
            usage.input += u.input || 0;
            usage.output += u.output || 0;
            usage.cacheRead += u.cacheRead || 0;
            usage.cacheWrite += u.cacheWrite || 0;
            usage.totalTokens += u.totalTokens || 0;
          }
          if (c) {
            cost.input += c.input || 0;
            cost.output += c.output || 0;
            cost.cacheRead += c.cacheRead || 0;
            cost.cacheWrite += c.cacheWrite || 0;
            cost.total += c.total || 0;
          }
          if (event.message?.model) model = event.message.model;
          if (event.message?.provider) provider = event.message.provider;
          break;
        }
        // Other event types (session/agent_start/message_start/tool_*, etc.)
        // are ignored — we don't persist the full stream.
        default:
          break;
      }
    };

    const consumeLine = (line) => {
      if (!line) return;
      // Try to JSON.parse; if it fails, the line is non-event noise (e.g.
      // a stray println from pi or an extension). Forward to onStdout so
      // operators see anomalies surface in the logs.
      try {
        handleEvent(JSON.parse(line));
      } catch {
        if (onStdout) onStdout(line);
      }
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`piInvoke: timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      if (stdout.length < STDOUT_CAP) stdout += text;
      stdoutLine += text;
      let idx;
      while ((idx = stdoutLine.indexOf("\n")) !== -1) {
        consumeLine(stdoutLine.slice(0, idx));
        stdoutLine = stdoutLine.slice(idx + 1);
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (onStderr) {
        stderrLine += text;
        let idx;
        while ((idx = stderrLine.indexOf("\n")) !== -1) {
          onStderr(stderrLine.slice(0, idx));
          stderrLine = stderrLine.slice(idx + 1);
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (stdoutLine) consumeLine(stdoutLine);
      flushText(true);
      if (stderrLine && onStderr) onStderr(stderrLine);
      const wall_ms = Date.now() - startedAt;
      resolvePromise({
        stdout, stderr, code: code ?? -1, signal,
        usage, cost, wall_ms, model, provider, turns,
      });
    });
  });
}
