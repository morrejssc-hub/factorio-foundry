// pi-invoke.js — wraps `pi -p` (one-shot, non-interactive) with per-phase
// tool/extension/prompt/cwd config. Each invocation is a brand-new session
// (--no-session) so phases never share LLM context.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * @param {object} opts
 * @param {string} opts.prompt          — final user message
 * @param {string} [opts.systemPrompt]  — appended via temp file (--append-system-prompt @file)
 * @param {string[]} [opts.tools]       — `--tools a,b,c` allowlist
 * @param {string[]} [opts.extensions]  — absolute paths, each as `-e <path>`
 * @param {boolean} [opts.noExtensions] — `--no-extensions` (default true; explicit -e still loaded)
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
 * @returns {Promise<{stdout: string, stderr: string, code: number, signal: string|null}>}
 */
export async function piInvoke(opts) {
  const {
    prompt,
    systemPrompt,
    tools,
    extensions = [],
    noExtensions = true,
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

  const args = ["-p", "--no-session"];
  if (noExtensions) args.push("--no-extensions");
  if (noContextFiles) args.push("--no-context-files");
  if (noSkills) args.push("--no-skills");
  if (noBuiltinTools) args.push("--no-builtin-tools");
  for (const ext of extensions) args.push("-e", resolve(ext));
  if (tools && tools.length) args.push("--tools", tools.join(","));
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
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
    const child = spawn("pi", args, {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutLine = "";
    let stderrLine = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`piInvoke: timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (onStdout) {
        stdoutLine += text;
        let idx;
        while ((idx = stdoutLine.indexOf("\n")) !== -1) {
          onStdout(stdoutLine.slice(0, idx));
          stdoutLine = stdoutLine.slice(idx + 1);
        }
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
      if (stdoutLine && onStdout) onStdout(stdoutLine);
      if (stderrLine && onStderr) onStderr(stderrLine);
      resolvePromise({ stdout, stderr, code: code ?? -1, signal });
    });
  });
}
