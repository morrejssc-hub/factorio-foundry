// factorio-process.js — boots the Factorio sidecar HTTP service used by the
// vendored .pi extensions (factorio_read / factorio_action / factorio_api_docs
// / factorio_wiki). Replaces the original ~/factorio-agent index.js without
// the TaskQueue, PiRpc, and AdvisorPi services.
//
// The phase runners (probe / design / execute / audit) talk to Factorio
// through this HTTP service indirectly: they spawn `pi -p` processes whose
// vendored extensions POST /tool/factorio_action etc. Audit also opens its
// own RCON connection for deterministic Lua probes.
import { mkdir, symlink, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { FactorioServer } from "./factorio-server.js";
import { FactorioApiDocs } from "./factorio-api-docs.js";
import { FactorioWiki } from "./factorio-wiki.js";
import { createApi } from "./http-api.js";

async function ensureSymlink(target, linkPath) {
  try {
    const info = await lstat(linkPath);
    if (info.isSymbolicLink() || info.isDirectory()) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await symlink(target, linkPath);
}

async function writeIfMissing(path, content) {
  await writeFile(path, content, { flag: "wx" }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
}

async function ensureWorkspace(config) {
  // The vendored factorio-server.js expects an agent-workspace style layout
  // with blueprints/, scripts/{lib,runs}, state/, capabilities/. We mirror
  // that under runtime/factorio-workspace and symlink the durable lib/ assets
  // into it so we don't have to touch the 3500-line vendored module.
  const ws = config.agentWorkspace;
  const dirs = [
    ws,
    join(ws, "scripts"),
    join(ws, "scripts", "runs"),
    join(ws, "scripts", "archive"),
    join(ws, "state"),
    join(ws, "capabilities"),
    join(ws, "data"),
    config.wikiCacheDir,
  ];
  for (const dir of dirs) await mkdir(dir, { recursive: true });
  await ensureSymlink(join(config.libDir, "blueprints"), join(ws, "blueprints"));
  await ensureSymlink(join(config.libDir, "probes"), join(ws, "scripts", "lib"));
  await writeIfMissing(
    join(ws, "capabilities", "index.json"),
    JSON.stringify({ version: 1, capabilities: [] }, null, 2),
  );
}

export async function bootFactorioService({ check = false } = {}) {
  const config = loadConfig();
  await ensureWorkspace(config);

  const factorio = new FactorioServer(config);
  const apiDocs = new FactorioApiDocs(config);
  const wiki = new FactorioWiki(config);
  await factorio.ensureLayout();

  if (check) {
    const docsSummary = await apiDocs.summary();
    const wikiSummary = await wiki.summary();
    return {
      ok: true,
      rootDir: config.rootDir,
      agentWorkspace: config.agentWorkspace,
      runtimeDir: config.runtimeDir,
      libDir: config.libDir,
      apiDocs: docsSummary,
      wiki: wikiSummary,
      serviceUrl: config.serviceUrl,
      materialPolicy: config.materialPolicy,
      factorioBinary: factorio.binaryPath(),
      factorioArchive: config.archivePath,
    };
  }

  const api = createApi(config, factorio, apiDocs, wiki);
  await new Promise((resolvePromise) => api.listen(config.servicePort, config.serviceHost, resolvePromise));

  async function shutdown() {
    api.close();
    await factorio.stop().catch(() => {});
  }

  return { config, factorio, apiDocs, wiki, api, shutdown };
}
