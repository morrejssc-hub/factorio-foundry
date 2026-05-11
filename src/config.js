import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be an integer, got ${raw}`);
  }
  return parsed;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function envEnum(name, fallback, allowed) {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : raw;
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")}, got ${value}`);
  }
  return value;
}

function envPath(name, fallback) {
  return resolve(rootDir, process.env[name] || fallback);
}

function envRequired(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

export function loadConfig() {
  const runtimeDir = envPath("FACTORIO_RUNTIME_DIR", "runtime");
  // factorio-server.js was written against an "agentWorkspace" with subdirs
  // blueprints/, scripts/{lib,runs}/, state/, capabilities/. We keep that
  // layout under runtime/factorio-workspace/ so the vendored module needs no
  // changes; lib/blueprints and lib/probes are symlinked in at startup.
  const agentWorkspace = envPath("FACTORIO_FOUNDRY_FACTORIO_WORKSPACE", "runtime/factorio-workspace");
  const servicePort = envInt("FACTORIO_AGENT_PORT", 4317);
  const serviceHost = process.env.FACTORIO_AGENT_HOST || "127.0.0.1";
  const serviceUrl = process.env.FACTORIO_AGENT_SERVICE_URL || `http://${serviceHost}:${servicePort}`;

  return {
    rootDir,
    agentWorkspace,
    runtimeDir,
    libDir: envPath("FACTORIO_FOUNDRY_LIB", "lib"),
    apiDocsDir: envPath("FACTORIO_API_DOCS_DIR", "lib/api-docs/factorio-api"),
    wikiApiUrl: process.env.FACTORIO_WIKI_API_URL || "https://wiki.factorio.com/api.php",
    wikiCacheDir: envPath("FACTORIO_WIKI_CACHE_DIR", "runtime/wiki-cache"),
    archivePath: envPath("FACTORIO_ARCHIVE", "factorio-headless_linux_2.0.76.tar.xz"),
    factorioDir: resolve(runtimeDir, "factorio"),
    savesDir: resolve(runtimeDir, "saves"),
    configDir: resolve(runtimeDir, "config"),
    logsDir: resolve(runtimeDir, "logs"),
    modsDir: resolve(runtimeDir, "mods"),
    saveName: process.env.FACTORIO_SAVE_NAME || "main.zip",
    rconHost: process.env.FACTORIO_RCON_HOST || "127.0.0.1",
    rconPort: envInt("FACTORIO_RCON_PORT", 27016),
    rconPassword: envRequired("FACTORIO_RCON_PASSWORD"),
    gamePort: envInt("FACTORIO_GAME_PORT", 34197),
    allowMutationWithConnectedPlayers: envBool("FACTORIO_AGENT_ALLOW_MUTATION_WITH_CONNECTED_PLAYERS", true),
    materialPolicy: envEnum("FACTORIO_AGENT_MATERIAL_POLICY", "strict", ["strict", "virtual"]),
    serviceHost,
    servicePort,
    serviceUrl,
    parallelCandidates: envInt("FOUNDRY_PARALLEL_CANDIDATES", 1),
  };
}
