import { createWriteStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { exists, ensureDir } from "./fs-util.js";
import { getLuaLibPreamble } from "./lua-lib.js";
import { buildLuaCommand, buildLuaCommandFromWorkspace, rconExec } from "./rcon.js";
import { directionName, loadEntityGeometries, solveLayout } from "./geometry/index.js";

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: options.stdio || ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr, code, signal });
      } else {
        const error = new Error(`${command} ${args.join(" ")} failed with code ${code}, signal ${signal}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

async function latestZip(dir) {
  if (!(await exists(dir))) return null;
  const entries = await readdir(dir);
  let latest = null;
  for (const entry of entries) {
    if (!entry.endsWith(".zip")) continue;
    const path = join(dir, entry);
    const info = await stat(path);
    if (!latest || info.mtimeMs > latest.mtimeMs) {
      latest = { path, mtimeMs: info.mtimeMs, size: info.size };
    }
  }
  return latest;
}

const READ_ONLY_FORBIDDEN = [
  /\bcreate_entity\b/,
  /\bdestroy\s*\(/,
  /\.destroy\s*\(/,
  /\binsert\s*\(/,
  /\.insert\s*\(/,
  /\bremove\s*\(/,
  /\.remove\s*\(/,
  /\bclear\s*\(/,
  /\.clear\s*\(/,
  /\bteleport\s*\(/,
  /\.teleport\s*\(/,
  /\bspill_item_stack\b/,
  /\bset_stack\b/,
  /\bgame\.tick\s*=/,
  /\btick_paused\s*=/,
  /\bdaytime\s*=/,
  /\.enabled\s*=/,
  /\.researched\s*=/,
  /\.amount\s*=/,
  /\bforce\.technologies\b.*=/,
  /\bforce\.recipes\b.*=/,
];

const RESOURCE_ITEMS = new Set(["iron-ore", "copper-ore", "coal", "stone", "wood"]);
const WORKER_TAG = "factorio-agent-worker";
const WORKER_ACTION_REACH = 8;
const MUTATING_ACTIONS = new Set([
  "move_to",
  "mine_resource",
  "craft",
  "place_from_inventory",
  "mine_entity_to_inventory",
  "transfer_inventory",
  "execute_blueprint",
  "connect_belt",
  "connect_power",
  "wait_ticks",
]);
const PLACEABLE_ITEMS = new Map([
  ["stone-furnace", "stone-furnace"],
  ["burner-mining-drill", "burner-mining-drill"],
  ["electric-mining-drill", "electric-mining-drill"],
  ["transport-belt", "transport-belt"],
  ["underground-belt", "underground-belt"],
  ["burner-inserter", "burner-inserter"],
  ["inserter", "inserter"],
  ["wooden-chest", "wooden-chest"],
  ["iron-chest", "iron-chest"],
  ["steel-chest", "steel-chest"],
  ["small-electric-pole", "small-electric-pole"],
  ["medium-electric-pole", "medium-electric-pole"],
  ["offshore-pump", "offshore-pump"],
  ["boiler", "boiler"],
  ["steam-engine", "steam-engine"],
  ["pipe", "pipe"],
  ["solar-panel", "solar-panel"],
  ["accumulator", "accumulator"],
  ["assembling-machine-1", "assembling-machine-1"],
]);
const ENTITY_TO_ITEM = new Map([...PLACEABLE_ITEMS.entries()].map(([item, entity]) => [entity, item]));

// Per-entity runtime settings applied after placement. Each setting key
// names the action; the value is the per-entity item allowlist. Adding a
// new setting kind = one entry here + a normaliser branch in
// normaliseEntitySettings + one dispatch case in the Lua executor block.
const SETTING_APPLICABILITY = {
  fuel: new Set([
    "burner-mining-drill",
    "stone-furnace",
    "steel-furnace",
    "burner-inserter",
    "boiler",
  ]),
  recipe: new Set([
    "assembling-machine-1",
  ]),
};

function normaliseEntitySettings(rawSettings, item, label) {
  if (rawSettings == null) return null;
  if (typeof rawSettings !== "object" || Array.isArray(rawSettings)) {
    throw new Error(`${label}.settings must be an object`);
  }
  const out = {};
  for (const [key, value] of Object.entries(rawSettings)) {
    const allow = SETTING_APPLICABILITY[key];
    if (!allow) throw new Error(`${label}.settings has unknown key: ${key}`);
    if (!allow.has(item)) {
      throw new Error(`${label}.settings.${key} not applicable to item ${item}`);
    }
    if (key === "fuel") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label}.settings.fuel must be an object`);
      }
      out.fuel = {
        item: String(value.item || "coal"),
        count: clampCount(value.count, 1, 1000),
        inventory: String(value.inventory || "fuel"),
      };
    } else if (key === "recipe") {
      if (typeof value !== "string" || !value) {
        throw new Error(`${label}.settings.recipe must be a non-empty string`);
      }
      out.recipe = value;
    }
  }
  return Object.keys(out).length ? out : null;
}

const RECIPES = new Map([
  ["stone-furnace", { count: 1, ingredients: { stone: 5 } }],
  ["iron-gear-wheel", { count: 1, ingredients: { "iron-plate": 2 } }],
  ["pipe", { count: 1, ingredients: { "iron-plate": 1 } }],
  ["transport-belt", { count: 2, ingredients: { "iron-plate": 1, "iron-gear-wheel": 1 } }],
  ["burner-inserter", { count: 1, ingredients: { "iron-plate": 1, "iron-gear-wheel": 1 } }],
  ["burner-mining-drill", { count: 1, ingredients: { "iron-plate": 3, "iron-gear-wheel": 3, "stone-furnace": 1 } }],
  ["offshore-pump", { count: 1, ingredients: { "iron-gear-wheel": 2, pipe: 3 } }],
  ["boiler", { count: 1, ingredients: { pipe: 4, "stone-furnace": 1 } }],
  ["steam-engine", { count: 1, ingredients: { "iron-gear-wheel": 8, "iron-plate": 10, pipe: 5 } }],
  ["wooden-chest", { count: 1, ingredients: { wood: 2 } }],
  ["iron-chest", { count: 1, ingredients: { "iron-plate": 8 } }],
  ["copper-cable", { count: 2, ingredients: { "copper-plate": 1 } }],
  ["electronic-circuit", { count: 1, ingredients: { "iron-plate": 1, "copper-cable": 3 } }],
  ["small-electric-pole", { count: 2, ingredients: { wood: 1, "copper-cable": 2 } }],
  ["assembling-machine-1", { count: 1, ingredients: { "iron-plate": 9, "iron-gear-wheel": 5, "electronic-circuit": 3 } }],
  ["inserter", { count: 1, ingredients: { "iron-gear-wheel": 1, "iron-plate": 1, "electronic-circuit": 1 } }],
  ["automation-science-pack", { count: 1, ingredients: { "copper-plate": 1, "iron-gear-wheel": 1 } }],
]);

const BLUEPRINT_NAME_RE = /^[A-Za-z0-9_.-]+$/;
const FLOW_PRECISIONS = new Set([
  "five_seconds",
  "one_minute",
  "ten_minutes",
  "one_hour",
  "ten_hours",
  "fifty_hours",
  "two_hundred_fifty_hours",
  "one_thousand_hours",
]);
const DEFAULT_PRODUCTION_ITEMS = [
  "iron-plate",
  "copper-plate",
  "steel-plate",
  "iron-gear-wheel",
  "transport-belt",
  "burner-inserter",
  "automation-science-pack",
  "iron-ore",
  "copper-ore",
  "coal",
  "stone",
];
const DEFAULT_EARLY_GAME_ITEMS = [
  "wood",
  "coal",
  "stone",
  "iron-ore",
  "copper-ore",
  "iron-plate",
  "copper-plate",
  "iron-gear-wheel",
  "copper-cable",
  "electronic-circuit",
  "stone-furnace",
  "burner-mining-drill",
  "electric-mining-drill",
  "transport-belt",
  "burner-inserter",
  "inserter",
  "wooden-chest",
  "iron-chest",
  "small-electric-pole",
  "pipe",
  "offshore-pump",
  "boiler",
  "steam-engine",
];
const DEFAULT_EARLY_GAME_ENTITIES = [
  "stone-furnace",
  "burner-mining-drill",
  "electric-mining-drill",
  "transport-belt",
  "burner-inserter",
  "inserter",
  "wooden-chest",
  "iron-chest",
  "small-electric-pole",
  "pipe",
  "offshore-pump",
  "boiler",
  "steam-engine",
  "iron-ore",
  "copper-ore",
  "coal",
  "stone",
];
const DEFAULT_EARLY_GAME_RECIPES = [
  "stone-furnace",
  "burner-mining-drill",
  "electric-mining-drill",
  "transport-belt",
  "burner-inserter",
  "inserter",
  "wooden-chest",
  "iron-chest",
  "iron-gear-wheel",
  "copper-cable",
  "electronic-circuit",
  "small-electric-pole",
  "pipe",
  "offshore-pump",
  "boiler",
  "steam-engine",
];

function parseKeyValueOutput(output) {
  const result = {};
  for (const line of String(output || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([A-Za-z0-9_.-]+)=(.*)$/);
    if (!match) continue;
    const [, key, raw] = match;
    if (raw === "true") result[key] = true;
    else if (raw === "false") result[key] = false;
    else if (/^-?\d+(\.\d+)?$/.test(raw)) result[key] = Number(raw);
    else result[key] = raw;
  }
  return result;
}

function parseJsonObjectOutput(output, label = "Lua output") {
  const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      return JSON.parse(line);
    } catch {
      // Keep looking; Factorio may have printed diagnostic lines before JSON.
    }
  }
  throw new Error(`${label} did not contain a JSON object: ${output || "(empty response)"}`);
}

function requirePosition(position, label = "position") {
  let value = position;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error(`${label} must have numeric x and y`);
    }
  }
  if (Array.isArray(value)) {
    value = { x: value[0], y: value[1] };
  }
  if (!value || !Number.isFinite(Number(value.x)) || !Number.isFinite(Number(value.y))) {
    throw new Error(`${label} must have numeric x and y`);
  }
  return { x: Number(value.x), y: Number(value.y) };
}

function tileCenter(position) {
  return {
    x: Math.floor(position.x) + 0.5,
    y: Math.floor(position.y) + 0.5,
  };
}

function directionBetween(from, to) {
  if (!from || !to) return null;
  if (to.x > from.x) return "east";
  if (to.x < from.x) return "west";
  if (to.y > from.y) return "south";
  if (to.y < from.y) return "north";
  return null;
}

function buildBeltPath(from, to, options = {}) {
  const start = tileCenter(from);
  const end = tileCenter(to);
  const mode = String(options.mode || "x_then_y");
  if (!["x_then_y", "y_then_x"].includes(mode)) {
    throw new Error(`unsupported belt route mode: ${mode}`);
  }
  const maxLength = clampCount(options.maxLength ?? options.max_length, 256, 2000);
  const points = [{ ...start }];
  const current = { ...start };

  const stepAxis = (axis) => {
    const target = end[axis];
    while (current[axis] !== target) {
      current[axis] += current[axis] < target ? 1 : -1;
      points.push({ ...current });
      if (points.length > maxLength) {
        throw new Error(`belt route exceeds maxLength=${maxLength}`);
      }
    }
  };

  if (mode === "x_then_y") {
    stepAxis("x");
    stepAxis("y");
  } else {
    stepAxis("y");
    stepAxis("x");
  }

  const explicitEndDirection = options.endDirection || options.end_direction || options.direction;
  return points.map((position, index) => {
    const next = points[index + 1];
    const previous = points[index - 1];
    const direction = next
      ? directionBetween(position, next)
      : (explicitEndDirection ? String(explicitEndDirection) : directionBetween(previous, position) || "north");
    return { position, direction };
  });
}

function buildPowerPath(from, to, options = {}) {
  const start = tileCenter(from);
  const end = tileCenter(to);
  const mode = String(options.mode || "x_then_y");
  if (!["x_then_y", "y_then_x"].includes(mode)) {
    throw new Error(`unsupported power route mode: ${mode}`);
  }
  const maxLength = clampCount(options.maxLength ?? options.max_length, 256, 2000);
  const spacingValue = Number(options.maxSpacing ?? options.max_spacing ?? 7);
  if (!Number.isFinite(spacingValue) || spacingValue <= 0 || spacingValue > 30) {
    throw new Error(`maxSpacing must be between 0 and 30, got ${spacingValue}`);
  }
  const spacing = Math.max(1, Math.floor(spacingValue));
  const points = [{ ...start }];
  const current = { ...start };

  const pushPoint = () => {
    if (points.length && points[points.length - 1].x === current.x && points[points.length - 1].y === current.y) {
      return;
    }
    points.push({ ...current });
    if (points.length > maxLength) {
      throw new Error(`power route exceeds maxLength=${maxLength}`);
    }
  };

  const stepAxis = (axis) => {
    const target = end[axis];
    while (current[axis] !== target) {
      const delta = target - current[axis];
      const step = Math.sign(delta) * Math.min(Math.abs(delta), spacing);
      current[axis] += step;
      pushPoint();
    }
  };

  if (mode === "x_then_y") {
    stepAxis("x");
    stepAxis("y");
  } else {
    stepAxis("y");
    stepAxis("x");
  }

  return points.map((position, index) => ({ index: index + 1, position }));
}

function parseToolJson(value, label = "value") {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${label} must be valid JSON when provided as a string: ${error.message}`);
  }
}

function parseStringList(value, label = "value") {
  const parsed = parseToolJson(value, label);
  if (parsed === undefined || parsed === null || parsed === "") return [];
  if (Array.isArray(parsed)) return parsed.map((item) => String(item)).filter(Boolean);
  return String(parsed).split(",").map((item) => item.trim()).filter(Boolean);
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(text)) return true;
  if (["false", "0", "no", "n"].includes(text)) return false;
  return fallback;
}

function clampCount(value, fallback = 1, max = 1000) {
  const count = Number.parseInt(value ?? fallback, 10);
  if (!Number.isFinite(count) || count <= 0) throw new Error(`count must be a positive integer, got ${value}`);
  return Math.min(count, max);
}

function validateReadOnlyLua(lua, script) {
  const stripped = lua
    .replace(/--\[\[[\s\S]*?\]\]/g, "")
    .replace(/--.*$/gm, "");
  const violations = [];
  for (const pattern of READ_ONLY_FORBIDDEN) {
    if (pattern.test(stripped)) violations.push(String(pattern));
  }
  if (violations.length) {
    throw new Error(`query_script rejected mutating Lua in ${script}: ${violations.join(", ")}`);
  }
}

function luaValue(value) {
  if (value === null || value === undefined) return "nil";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`cannot encode non-finite Lua number: ${value}`);
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `{ ${value.map((item) => luaValue(item)).join(", ")} }`;
  if (typeof value === "object") {
    return `{ ${Object.entries(value).map(([key, item]) => {
      const encodedKey = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : `[${JSON.stringify(key)}]`;
      return `${encodedKey} = ${luaValue(item)}`;
    }).join(", ")} }`;
  }
  throw new Error(`cannot encode Lua value of type ${typeof value}`);
}

function actionId() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}`;
}

function parseInventoryOutput(output) {
  const inventory = {};
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.trim().match(/^item\.([^=]+)=(\d+)$/);
    if (!match) continue;
    inventory[match[1]] = Number.parseInt(match[2], 10);
  }
  return inventory;
}

function normalizeActionState(value = {}) {
  const worker = value.worker || {};
  const rawPosition = worker.position || { x: 0, y: 0 };
  let position = { x: 0, y: 0 };
  try {
    position = requirePosition(rawPosition, "worker.position");
  } catch {
    position = { x: 0, y: 0 };
  }
  return {
    version: 2,
    worker: {
      tag: String(worker.tag || WORKER_TAG),
      unitNumber: worker.unitNumber ?? worker.unit_number ?? null,
      position,
    },
    journal: Array.isArray(value.journal) ? value.journal : [],
  };
}

function workerFromParsed(parsed, fallback = {}) {
  const fallbackWorker = normalizeActionState(fallback).worker;
  const unitNumber = parsed["worker.unit_number"] ?? parsed["worker.unitNumber"] ?? fallbackWorker.unitNumber;
  const x = Number(parsed["worker.x"] ?? fallbackWorker.position.x);
  const y = Number(parsed["worker.y"] ?? fallbackWorker.position.y);
  return {
    tag: String(parsed["worker.tag"] || fallbackWorker.tag),
    unitNumber: unitNumber === "" ? null : unitNumber,
    position: {
      x: Number.isFinite(x) ? x : fallbackWorker.position.x,
      y: Number.isFinite(y) ? y : fallbackWorker.position.y,
    },
  };
}

function workerLuaPrelude() {
  return `
local worker_tag = ${luaValue(WORKER_TAG)}
local surface = game.surfaces[1]
local force = game.forces["player"]

local function find_worker()
  local characters = surface.find_entities_filtered{name = "character"}
  for _, entity in ipairs(characters) do
    if entity.valid and entity.name_tag == worker_tag then
      return entity
    end
  end
  return nil
end

local function worker_inventory(worker)
  local inv = worker.get_inventory(defines.inventory.character_main)
  if not inv or not inv.valid then
    rcon.print("ok=false")
    rcon.print("error=worker_inventory_missing")
    return nil
  end
  return inv
end

local function print_worker(worker)
  rcon.print("worker.tag=" .. tostring(worker.name_tag or ""))
  rcon.print("worker.unit_number=" .. tostring(worker.unit_number or ""))
  rcon.print("worker.x=" .. tostring(worker.position.x))
  rcon.print("worker.y=" .. tostring(worker.position.y))
end

local function print_inventory(inv)
  local contents = inv.get_contents()
  for key, value in pairs(contents) do
    local name = nil
    local count = nil
    local quality = nil
    if type(value) == "number" then
      name = tostring(key)
      count = value
    elseif type(value) == "table" then
      name = value.name or tostring(key)
      count = value.count or value[1] or 0
      quality = value.quality
    end
    if name and count and count > 0 then
      local suffix = ""
      if quality then
        local quality_name = type(quality) == "table" and quality.name or tostring(quality)
        if quality_name and quality_name ~= "" and quality_name ~= "normal" then
          suffix = "@" .. quality_name
        end
      end
      rcon.print("item." .. name .. suffix .. "=" .. tostring(count))
    end
  end
end

local function entity_inventory(entity, kind)
  if kind == "chest" then return entity.get_inventory(defines.inventory.chest) end
  if kind == "fuel" then return entity.get_inventory(defines.inventory.fuel) end
  if kind == "furnace_source" then return entity.get_inventory(defines.inventory.furnace_source) end
  if kind == "furnace_result" then return entity.get_inventory(defines.inventory.furnace_result) end
  if kind == "crafter_input" then return entity.get_inventory(defines.inventory.crafter_input) end
  if kind == "crafter_output" then return entity.get_inventory(defines.inventory.crafter_output) end
  if kind == "burnt_result" then return entity.get_inventory(defines.inventory.burnt_result) end
  return nil
end

local function find_ref_entity(ref)
  local entities = surface.find_entities_filtered{area = {{ref.x - 0.4, ref.y - 0.4}, {ref.x + 0.4, ref.y + 0.4}}, name = ref.name}
  if #entities == 0 then return nil end
  return entities[1]
end
`;
}

export class FactorioServer {
  constructor(config) {
    this.config = config;
    this.process = null;
    this.logStream = null;
    this.currentLogPath = join(config.logsDir, "factorio-current.log");
  }

  binaryPath() {
    return join(this.config.factorioDir, "bin", "x64", "factorio");
  }

  savePath() {
    return join(this.config.savesDir, this.config.saveName);
  }

  async ensureLayout() {
    await Promise.all([
      ensureDir(this.config.runtimeDir),
      ensureDir(this.config.savesDir),
      ensureDir(this.config.configDir),
      ensureDir(this.config.logsDir),
      ensureDir(this.config.modsDir),
    ]);
    await this.writeServerSettings();
    await writeFile(join(this.config.configDir, "rconpw"), this.config.rconPassword, { mode: 0o600 });
  }

  async writeServerSettings() {
    const settings = {
      name: "factorio-agent-local",
      description: "Local Factorio server for factorio-agent",
      tags: [],
      max_players: 0,
      visibility: { public: false, lan: false },
      username: "",
      password: "",
      token: "",
      game_password: "",
      require_user_verification: false,
      max_upload_in_kilobytes_per_second: 0,
      max_upload_slots: 5,
      minimum_latency_in_ticks: 0,
      max_heartbeats_per_second: 60,
      ignore_player_limit_for_returning_players: false,
      allow_commands: "admins-only",
      autosave_interval: 10,
      autosave_slots: 5,
      afk_autokick_interval: 0,
      auto_pause: false,
      auto_pause_when_players_connect: false,
      only_admins_can_pause_the_game: true,
      autosave_only_on_server: true,
      non_blocking_saving: false,
      minimum_segment_size: 25,
      minimum_segment_size_peer_count: 20,
      maximum_segment_size: 100,
      maximum_segment_size_peer_count: 10
    };
    await writeFile(
      join(this.config.configDir, "server-settings.json"),
      `${JSON.stringify(settings, null, 2)}\n`,
    );
  }

  async ensureInstalled() {
    await this.ensureLayout();
    if (await exists(this.binaryPath())) return;
    if (!(await exists(this.config.archivePath))) {
      throw new Error(`Factorio archive not found: ${this.config.archivePath}`);
    }
    await run("tar", ["-xf", this.config.archivePath, "-C", this.config.runtimeDir]);
  }

  async ensureSave() {
    if (await exists(this.savePath())) return;
    await this.ensureInstalled();
    await run(this.binaryPath(), [
      "--create",
      this.savePath(),
      "--mod-directory",
      this.config.modsDir,
    ], { cwd: this.config.runtimeDir });
  }

  isRunning() {
    return Boolean(this.process && !this.process.killed && this.process.exitCode === null);
  }

  async start() {
    if (this.isRunning()) return;
    await this.ensureSave();
    this.logStream = createWriteStream(this.currentLogPath, { flags: "a" });
    const args = [
      ...(this.config.configFile ? ["-c", this.config.configFile] : []),
      "--start-server",
      this.savePath(),
      "--server-settings",
      join(this.config.configDir, "server-settings.json"),
      "--server-id",
      join(this.config.configDir, "server-id.json"),
      "--mod-directory",
      this.config.modsDir,
      "--port",
      String(this.config.gamePort),
      "--rcon-port",
      String(this.config.rconPort),
      "--rcon-password",
      this.config.rconPassword,
    ];
    this.process = spawn(this.binaryPath(), args, {
      cwd: this.config.runtimeDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process.stdout.pipe(this.logStream, { end: false });
    this.process.stderr.pipe(this.logStream, { end: false });
    this.process.once("exit", (code, signal) => {
      this.logStream?.write(`\n[factorio-agent] factorio exited code=${code} signal=${signal}\n`);
    });
    await this.waitReady();
    await this.confirmLuaConsole();
    await this.ensureSimulationAdvances();
  }

  async waitReady(timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      if (this.process && this.process.exitCode !== null) {
        const logs = await this.logs(60).catch(() => "");
        throw new Error(`Factorio exited before RCON became ready with code ${this.process.exitCode}\n${logs}`);
      }
      try {
        await this.rcon("/help", 5000);
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
      }
    }
    throw new Error(`Factorio RCON did not become ready: ${lastError?.message || "unknown error"}`);
  }

  async confirmLuaConsole() {
    const command = "/silent-command rcon.print('factorio-agent-ready')";
    await this.rcon(command, 5000).catch(() => "");
    await this.rcon(command, 5000).catch(() => "");
  }

  async ensureSimulationAdvances() {
    await this.rcon("/silent-command game.tick_paused = false", 5000);
    const before = await this.readTick();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
    const after = await this.readTick();
    if (after <= before) {
      throw new Error(`Factorio simulation did not advance: before=${before}, after=${after}`);
    }
    return after;
  }

  async readTick() {
    const output = await this.rcon("/silent-command rcon.print(game.tick)", 5000);
    const match = output.match(/\d+/);
    if (!match) throw new Error(`game.tick response contained no integer: ${output}`);
    return Number.parseInt(match[0], 10);
  }

  async rcon(command, timeoutMs = 15000) {
    return rconExec({
      host: this.config.rconHost,
      port: this.config.rconPort,
      password: this.config.rconPassword,
      command,
      timeoutMs,
    });
  }

  async save() {
    const before = await latestZip(this.config.savesDir);
    await this.rcon("/server-save", 30000);
    const deadline = Date.now() + 30000;
    let latest = null;
    while (Date.now() < deadline) {
      latest = await latestZip(this.config.savesDir);
      if (latest && (!before || latest.mtimeMs > before.mtimeMs)) return latest;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
    }
    if (latest) return latest;
    throw new Error(`No Factorio save found in ${this.config.savesDir}`);
  }

  async runLua(workspaceDir, script, params = {}) {
    const built = await buildLuaCommandFromWorkspace(workspaceDir, script, params);
    const output = await this.rcon(built.command, 60000);
    return {
      script: built.relative,
      output: output || "(empty response)",
    };
  }

  async runTemplateLua(label, body, timeoutMs = 60000) {
    const lua = `return { query = function()\n${body}\nend }`;
    const command = buildLuaCommand(label, lua, {});
    return this.rcon(command, timeoutMs);
  }

  actionStatePath() {
    return join(this.config.agentWorkspace, "state", "action-state.json");
  }

  proposalDir() {
    return join(this.config.agentWorkspace, "state", "capability-proposals");
  }

  async loadActionState() {
    const text = await readFile(this.actionStatePath(), "utf8").catch(() => null);
    if (text) {
      try {
        return normalizeActionState(JSON.parse(text));
      } catch (e) {
        // Corrupted state files (e.g., concatenated JSON from a crashed
        // earlier run) should not block executor calls — reset and warn.
        console.log(`[factorio] action-state.json corrupt (${e.message}); resetting`);
        return normalizeActionState();
      }
    }
    return normalizeActionState();
  }

  async writeActionState(state) {
    const next = normalizeActionState(state);
    await ensureDir(join(this.config.agentWorkspace, "state"));
    await writeFile(this.actionStatePath(), `${JSON.stringify(next, null, 2)}\n`);
  }

  async persistWorkerOutput(output, journalEntry = null) {
    const state = await this.loadActionState();
    const parsed = parseKeyValueOutput(output);
    state.worker = workerFromParsed(parsed, state);
    if (journalEntry) state.journal.push(journalEntry);
    await this.writeActionState(state);
    return { parsed, worker: state.worker, inventory: parseInventoryOutput(output), output };
  }

  async ensureWorkerCharacter() {
    const state = await this.loadActionState();
    const position = state.worker.position || { x: 0, y: 0 };
    const body = `
${workerLuaPrelude()}
local worker = find_worker()
local created = false
if not worker then
  local spawn = surface.find_non_colliding_position("character", {${position.x}, ${position.y}}, 32, 0.5) or {${position.x}, ${position.y}}
  worker = surface.create_entity{name = "character", position = spawn, force = force, raise_built = false}
  if not worker then
    rcon.print("ok=false")
    rcon.print("error=worker_create_failed")
    return
  end
  worker.name_tag = worker_tag
  local created_inv = worker.get_inventory(defines.inventory.character_main)
  if created_inv and created_inv.valid then created_inv.clear() end
  created = true
end
local inv = worker_inventory(worker)
if not inv then return end
rcon.print("ok=true")
rcon.print("created=" .. tostring(created))
print_worker(worker)
print_inventory(inv)
`;
    const output = await this.runTemplateLua("ensure_worker_character.lua", body);
    const result = await this.persistWorkerOutput(output);
    if (!result.parsed.ok) throw new Error(`ensure_worker_character failed: ${result.parsed.error || output}`);
    return {
      created: Boolean(result.parsed.created),
      worker: result.worker,
      inventory: result.inventory,
      output,
    };
  }

  async runReadScript(script, params = {}) {
    const built = await buildLuaCommandFromWorkspace(this.config.agentWorkspace, script, params);
    validateReadOnlyLua(built.lua, built.relative);
    const output = await this.rcon(built.command, 60000);
    return {
      script: built.relative,
      output: output || "(empty response)",
      readonly: true,
    };
  }

  // Like runReadScript but accepts raw Lua content instead of a workspace path.
  // Used by the foundry-probe pi extension so the designer can run scripts from
  // its own cwd (lib/probes/ symlink + any script it writes itself).
  async runProbeScript(lua, params = {}) {
    const preamble = await getLuaLibPreamble(this.config.agentWorkspace);
    const combined = preamble ? `${preamble}\n${lua}` : lua;
    validateReadOnlyLua(combined, "<designer-probe>");
    const command = buildLuaCommand("designer-probe.lua", combined, params);
    const output = await this.rcon(command, 60000);
    return { output: output || "(empty response)", readonly: true };
  }

  async validatePlacement(entities) {
    const { output } = await this.runReadScript("lib/validate_placement.lua", { entities });
    return parseJsonObjectOutput(output, "validate_placement");
  }

  async inspectArea(input) {
    const area = input.area || {};
    const leftTop = requirePosition(area.leftTop || area.left_top || area.min || { x: input.x1, y: input.y1 }, "area.leftTop");
    const rightBottom = requirePosition(area.rightBottom || area.right_bottom || area.max || { x: input.x2, y: input.y2 }, "area.rightBottom");
    const limit = clampCount(input.limit, 30, 200);
    const body = `
local surface = game.surfaces[1]
local area = {{${leftTop.x}, ${leftTop.y}}, {${rightBottom.x}, ${rightBottom.y}}}
local entities = surface.find_entities_filtered{area = area}
local counts = {}
for _, entity in ipairs(entities) do
  counts[entity.name] = (counts[entity.name] or 0) + 1
end
rcon.print("total=" .. #entities)
for name, count in pairs(counts) do
  rcon.print("count." .. name .. "=" .. count)
end
local printed = 0
for _, entity in ipairs(entities) do
  if printed >= ${limit} then break end
  local unit = entity.unit_number or ""
  local ok_amount, amount = pcall(function() return entity.amount end)
  if not ok_amount or amount == nil then amount = "" end
  local ok_status, status = pcall(function() return entity.status end)
  if not ok_status or status == nil then status = "" end
  rcon.print("entity=" .. entity.name .. "|type=" .. entity.type .. "|x=" .. entity.position.x .. "|y=" .. entity.position.y .. "|unit=" .. tostring(unit) .. "|amount=" .. tostring(amount) .. "|status=" .. tostring(status))
  printed = printed + 1
end
`;
    const output = await this.runTemplateLua("inspect_area.lua", body);
    return { output: output || "(empty response)" };
  }

  async inspectPosition(input) {
    const position = requirePosition(input.position || input, "position");
    await this.ensureWorkerCharacter();
    const body = `
${workerLuaPrelude()}
local requested = {x = ${position.x}, y = ${position.y}}

local function pos(value)
  if not value then return nil end
  return {x = value.x or value[1], y = value.y or value[2]}
end

local function bbox(value)
  if not value then return nil end
  return {
    leftTop = pos(value.left_top or value.leftTop or value[1]),
    rightBottom = pos(value.right_bottom or value.rightBottom or value[2])
  }
end

local function point_detail(value, origin, box)
  local point = pos(value)
  if not point then return nil end
  local tile = {x = math.floor(point.x), y = math.floor(point.y)}
  local offset_in_tile = {x = point.x - tile.x, y = point.y - tile.y}
  local third_x = math.max(0, math.min(2, math.floor(offset_in_tile.x * 3)))
  local third_y = math.max(0, math.min(2, math.floor(offset_in_tile.y * 3)))
  local x_names = {"left", "center", "right"}
  local y_names = {"top", "middle", "bottom"}
  local out = {
    position = point,
    tile = tile,
    tileCenter = {x = tile.x + 0.5, y = tile.y + 0.5},
    tileKey = tostring(tile.x) .. "," .. tostring(tile.y),
    offsetInTile = offset_in_tile,
    subtile3x3 = {
      xIndex = third_x + 1,
      yIndex = third_y + 1,
      xName = x_names[third_x + 1],
      yName = y_names[third_y + 1],
      key = y_names[third_y + 1] .. "-" .. x_names[third_x + 1]
    },
    concise = "tile(" .. tostring(tile.x) .. "," .. tostring(tile.y) .. ") " .. y_names[third_y + 1] .. "-" .. x_names[third_x + 1]
  }
  if origin then
    out.offsetFromEntityPosition = {x = point.x - origin.x, y = point.y - origin.y}
  end
  if box and box.leftTop then
    out.offsetFromSelectionBox = {x = point.x - box.leftTop.x, y = point.y - box.leftTop.y}
  end
  return out
end

local function safe(fn)
  local ok, value = pcall(fn)
  if ok then return value end
  return nil
end

local function direction_name(value)
  if value == nil then return nil end
  local ok, name = pcall(function() return helpers.direction_to_string(value) end)
  if ok and name then return name end
  for key, dir in pairs(defines.direction or {}) do
    if dir == value then return key end
  end
  return tostring(value)
end

local function direction_arrow(value)
  if value == defines.direction.north then return "^" end
  if value == defines.direction.east then return ">" end
  if value == defines.direction.south then return "v" end
  if value == defines.direction.west then return "<" end
  return direction_name(value)
end

local function direction_vector(value)
  if value == defines.direction.north then return {x = 0, y = -1} end
  if value == defines.direction.east then return {x = 1, y = 0} end
  if value == defines.direction.south then return {x = 0, y = 1} end
  if value == defines.direction.west then return {x = -1, y = 0} end
  return nil
end

local function status_name(value)
  if value == nil then return nil end
  for key, status in pairs(defines.entity_status or {}) do
    if status == value then return key end
  end
  return tostring(value)
end

local function contents(inv)
  if not inv or not inv.valid then return nil end
  local out = {}
  local ok, raw = pcall(function() return inv.get_contents() end)
  if ok and raw then
    for key, value in pairs(raw) do
      local name = nil
      local count = nil
      local quality = nil
      if type(value) == "number" and type(key) == "string" then
        name = key
        count = value
      elseif type(value) == "table" then
        name = value.name or (type(key) == "string" and key or nil)
        count = value.count or value[1]
        quality = value.quality
      end
      if name and count and count > 0 then
        local suffix = ""
        if quality then
          local quality_name = type(quality) == "table" and quality.name or tostring(quality)
          if quality_name and quality_name ~= "" and quality_name ~= "normal" then suffix = "@" .. quality_name end
        end
        out[name .. suffix] = count
      end
    end
  end
  return out
end

local function inv_summary(inv)
  if not inv or not inv.valid then return nil end
  return {
    valid = true,
    size = safe(function() return #inv end),
    empty = safe(function() return inv.is_empty() end),
    contents = contents(inv) or {}
  }
end

local function inventory_by_index(entity, index)
  if not index then return nil end
  local inv = safe(function() return entity.get_inventory(index) end)
  return inv_summary(inv)
end

local function add_inventory(out, key, inv)
  local summary = inv_summary(inv)
  if summary then out[key] = summary end
end

local function stack_summary(entity)
  if not entity or entity.type ~= "item-entity" then return nil end
  local stack = safe(function() return entity.stack end)
  if not stack or not stack.valid_for_read then return nil end
  return {
    name = stack.name,
    count = stack.count,
    quality = stack.quality and stack.quality.name or nil
  }
end

local function entities_at_point(point)
  if not point then return nil end
  local area = {{point.x - 0.45, point.y - 0.45}, {point.x + 0.45, point.y + 0.45}}
  local found = {}
  for _, e in ipairs(surface.find_entities_filtered{area = area}) do
    if e.valid then
      table.insert(found, {
        name = e.name,
        type = e.type,
        unitNumber = e.unit_number,
        position = pos(e.position),
        stack = stack_summary(e)
      })
    end
  end
  return found
end

local function port_summary(kind, detail, dir, entities)
  if not detail then return nil end
  return {
    kind = kind,
    side = direction_name(dir),
    arrow = direction_arrow(dir),
    position = detail.position,
    tile = detail.tile,
    tileCenter = detail.tileCenter,
    tileKey = detail.tileKey,
    subtile = detail.subtile3x3,
    concise = detail.concise,
    offsetFromEntityPosition = detail.offsetFromEntityPosition,
    offsetFromSelectionBox = detail.offsetFromSelectionBox,
    entities = entities
  }
end

local function resource_list(area)
  if not area then return nil end
  local totals = {}
  local resources = {}
  for _, resource in ipairs(surface.find_entities_filtered{area = area, type = "resource"}) do
    if resource.valid then
      local amount = safe(function() return resource.amount end) or 0
      totals[resource.name] = (totals[resource.name] or 0) + amount
      table.insert(resources, {
        name = resource.name,
        amount = amount,
        position = pos(resource.position)
      })
    end
  end
  return {totalAmountByName = totals, resources = resources}
end

local function prototype_summary(entity)
  local proto = safe(function() return entity.prototype end)
  if not proto then return nil end
  local out = {
    name = proto.name,
    type = proto.type,
    miningSpeed = safe(function() return proto.mining_speed end),
    miningDrillRadius = safe(function() return proto.mining_drill_radius end),
    energyUsage = safe(function() return proto.energy_usage end),
    maxEnergyUsage = safe(function() return proto.get_max_energy_usage() end),
    emissionsPerSecond = safe(function() return proto.emissions_per_second end)
  }
  return out
end

local function burner_summary(entity)
  local burner = safe(function() return entity.burner end)
  if not burner or not burner.valid then return nil end
  local current = safe(function() return burner.currently_burning end)
  local current_name = nil
  if type(current) == "table" then current_name = current.name end
  return {
    currentlyBurning = current_name,
    remainingBurningFuel = safe(function() return burner.remaining_burning_fuel end),
    heat = safe(function() return burner.heat end),
    heatCapacity = safe(function() return burner.heat_capacity end),
    fuelCategories = safe(function() return burner.fuel_categories end),
    inventory = inv_summary(safe(function() return burner.inventory end)),
    burntResultInventory = inv_summary(safe(function() return burner.burnt_result_inventory end))
  }
end

local function entity_summary(entity, selected_by)
  local direction = safe(function() return entity.direction end)
  local status = safe(function() return entity.status end)
  local selection_box = bbox(safe(function() return entity.selection_box end))
  local drop = point_detail(safe(function() return entity.drop_position end), entity.position, selection_box)
  local pickup = point_detail(safe(function() return entity.pickup_position end), entity.position, selection_box)
  local drop_entities = entities_at_point(drop and drop.position or nil)
  local pickup_entities = entities_at_point(pickup and pickup.position or nil)
  local mining_area = bbox(safe(function() return entity.mining_area end))
  local target = safe(function() return entity.mining_target end)
  local target_summary = nil
  if target and target.valid then
    target_summary = {
      name = target.name,
      type = target.type,
      amount = safe(function() return target.amount end),
      position = pos(target.position)
    }
  end

  local inventories = {}
  add_inventory(inventories, "fuel", safe(function() return entity.get_fuel_inventory() end))
  if entity.type == "container" or entity.type == "logistic-container" or entity.type == "infinity-container" then
    inventories.chest = inventory_by_index(entity, defines.inventory.chest)
  end
  if entity.type == "furnace" then
    inventories.source = inventory_by_index(entity, defines.inventory.furnace_source)
    inventories.result = inventory_by_index(entity, defines.inventory.furnace_result)
    add_inventory(inventories, "output", safe(function() return entity.get_output_inventory() end))
  end
  if entity.type == "assembling-machine" or entity.type == "rocket-silo" then
    inventories.input = inventory_by_index(entity, defines.inventory.crafter_input)
    inventories.output = inventory_by_index(entity, defines.inventory.crafter_output)
    add_inventory(inventories, "outputDirect", safe(function() return entity.get_output_inventory() end))
  end
  if entity.type == "lab" then
    inventories.input = inventory_by_index(entity, defines.inventory.lab_input)
  end

  local recipe = safe(function()
    local current = entity.get_recipe()
    if current then return current.name end
    return nil
  end)
  local status_text = status_name(status)
  local summary = {
    label = entity.name .. (entity.unit_number and ("#" .. tostring(entity.unit_number)) or ""),
    position = pos(entity.position),
    direction = direction_name(direction),
    status = status_text,
    output = drop and {
      tile = drop.tile,
      tileCenter = drop.tileCenter,
      point = drop.position,
      subtile = drop.subtile3x3.key,
      concise = drop.concise
    } or nil,
    input = pickup and {
      tile = pickup.tile,
      tileCenter = pickup.tileCenter,
      point = pickup.position,
      subtile = pickup.subtile3x3.key,
      concise = pickup.concise
    } or nil,
    blocked = status_text ~= nil and status_text ~= "working",
    blockedReason = status_text
  }

  return {
    summary = summary,
    selectedBy = selected_by,
    name = entity.name,
    type = entity.type,
    unitNumber = entity.unit_number,
    position = pos(entity.position),
    surface = entity.surface and entity.surface.name or nil,
    force = entity.force and entity.force.name or nil,
    direction = {
      value = direction,
      name = direction_name(direction),
      arrow = direction_arrow(direction),
      vector = direction_vector(direction)
    },
    orientation = safe(function() return entity.orientation end),
    supportsDirection = safe(function() return entity.supports_direction end),
    status = {value = status, name = status_text},
    health = safe(function() return entity.health end),
    maxHealth = safe(function() return entity.prototype.max_health end),
    amount = safe(function() return entity.amount end),
    energy = safe(function() return entity.energy end),
    selectionBox = selection_box,
    boundingBox = bbox(safe(function() return entity.bounding_box end)),
    miningArea = mining_area,
    miningTarget = target_summary,
    resourcesInMiningArea = resource_list(mining_area),
    dropPosition = drop and drop.position or nil,
    drop = drop,
    pickupPosition = pickup and pickup.position or nil,
    pickup = pickup,
    ports = {
      output = port_summary("output", drop, direction, drop_entities),
      input = port_summary("input", pickup, direction, pickup_entities)
    },
    dropEntities = drop_entities,
    prototype = prototype_summary(entity),
    burner = burner_summary(entity),
    inventories = inventories,
    recipe = recipe,
    craftingProgress = safe(function() return entity.crafting_progress end),
    miningProgress = safe(function() return entity.mining_progress end),
    bonusMiningProgress = safe(function() return entity.bonus_mining_progress end)
  }
end

local function tile_summary()
  local tile = surface.get_tile(requested.x, requested.y)
  local left = math.floor(requested.x)
  local top = math.floor(requested.y)
  local area = {{left, top}, {left + 1, top + 1}}
  return {
    name = tile and tile.name or nil,
    position = tile and pos(tile.position) or {x = left, y = top},
    resources = resource_list(area)
  }
end

local worker = find_worker()
local result = {
  query = "inspect_position",
  position = requested,
  tile = tile_summary(),
  selected = nil,
  selection = {method = "worker.update_selected_entity", ok = false}
}

if worker then
  local previous = safe(function() return worker.selected end)
  local ok, err = pcall(function() worker.update_selected_entity(requested) end)
  result.selection.ok = ok
  if not ok then result.selection.error = tostring(err) end
  local selected = safe(function() return worker.selected end)
  if selected and selected.valid then
    result.selected = entity_summary(selected, "worker.update_selected_entity")
  else
    result.selection.miss = true
  end
  if previous and previous.valid then
    pcall(function() worker.selected = previous end)
  else
    pcall(function() worker.clear_selected_entity() end)
  end
end

if not result.selected then
  local tiny = {{requested.x - 0.01, requested.y - 0.01}, {requested.x + 0.01, requested.y + 0.01}}
  for _, entity in ipairs(surface.find_entities_filtered{area = tiny}) do
    if entity.valid then
      result.selected = entity_summary(entity, "area_fallback")
      break
    end
  end
end

rcon.print(helpers.table_to_json(result))
`;
    const output = await this.runTemplateLua("inspect_position.lua", body);
    return parseJsonObjectOutput(output, "inspect_position");
  }

  async countInventorySources(sources, item) {
    const body = `
local surface = game.surfaces[1]
local item = ${luaValue(item)}
local sources = ${luaValue(sources)}
local function inventory_for(entity, kind)
  if kind == "chest" then return entity.get_inventory(defines.inventory.chest) end
  if kind == "fuel" then return entity.get_inventory(defines.inventory.fuel) end
  if kind == "furnace_source" then return entity.get_inventory(defines.inventory.furnace_source) end
  if kind == "furnace_result" then return entity.get_inventory(defines.inventory.furnace_result) end
  if kind == "crafter_input" then return entity.get_inventory(defines.inventory.crafter_input) end
  if kind == "crafter_output" then return entity.get_inventory(defines.inventory.crafter_output) end
  if kind == "burnt_result" then return entity.get_inventory(defines.inventory.burnt_result) end
  return nil
end
local total = 0
local index = 0
for _, source in ipairs(sources) do
  index = index + 1
  local area = {{source.x - 0.4, source.y - 0.4}, {source.x + 0.4, source.y + 0.4}}
  local entities = surface.find_entities_filtered{area = area, name = source.name}
  local count = 0
  if #entities > 0 then
    local inv = inventory_for(entities[1], source.inventory)
    if inv then count = inv.get_item_count(item) end
  end
  total = total + count
  rcon.print("source." .. index .. "=" .. count)
end
rcon.print("total=" .. total)
`;
    const output = await this.runTemplateLua("count_inventory_sources.lua", body);
    const parsed = parseKeyValueOutput(output);
    return { output: output || "(empty response)", total: parsed.total || 0 };
  }

  async inspectInventory(input) {
    const target = parseToolJson(input.target || {}, "target");
    if (!target.type || target.type === "worker") {
      const worker = await this.ensureWorkerCharacter();
      return {
        target: "worker",
        worker: worker.worker,
        position: worker.worker.position,
        inventory: worker.inventory,
      };
    }
    const ref = this.entityRef(target.entity || target);
    const inventory = String(target.inventory || input.inventory || "chest");
    const { output } = await this.countInventorySources([{ ...ref, inventory }], input.item || "");
    return { output };
  }

  async measureProductionWindow(input) {
    const item = String(input.item || "iron-plate");
    const ticks = clampCount(input.ticks, 600, 216000);
    const sources = Array.isArray(input.sources) ? input.sources.map((source, index) => {
      const ref = this.entityRef(source.entity || source, `sources[${index}]`);
      return { ...ref, inventory: String(source.inventory || "chest") };
    }) : [];
    if (sources.length === 0) {
      throw new Error("measure_production_window requires sources with entity name, position, and inventory");
    }
    const beforeTick = await this.readTick();
    const before = await this.countInventorySources(sources, item);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.ceil((ticks / 60) * 1000)));
    const afterTick = await this.readTick();
    const after = await this.countInventorySources(sources, item);
    const elapsedTicks = Math.max(1, afterTick - beforeTick);
    const delta = after.total - before.total;
    return {
      item,
      beforeTick,
      afterTick,
      elapsedTicks,
      before: before.total,
      after: after.total,
      delta,
      perSecond: delta / (elapsedTicks / 60),
      beforeOutput: before.output,
      afterOutput: after.output,
    };
  }

  // Returns the local hand-craft RECIPES table — the actual subset that
  // the `craft` action accepts. Distinct from earlyGameCatalog, which
  // reflects the in-game force.recipes superset and can mislead an agent
  // into asking for crafts the executor will reject.
  craftCatalog() {
    return {
      type: "craft_catalog",
      description: "Items the worker can hand-craft via factorio_action craft. Subset of the in-game recipe set; if an item is not listed here, do not call craft for it.",
      recipes: [...RECIPES.entries()].map(([item, recipe]) => ({
        item,
        count: recipe.count,
        ingredients: { ...recipe.ingredients },
      })),
    };
  }

  async earlyGameCatalog(input) {
    const requestedItems = parseStringList(input.items ?? input.item, "items");
    const requestedEntities = parseStringList(input.entities ?? input.entity, "entities");
    const requestedRecipes = parseStringList(input.recipes ?? input.recipe, "recipes");
    const itemNames = requestedItems.length ? requestedItems : DEFAULT_EARLY_GAME_ITEMS;
    const entityNames = requestedEntities.length ? requestedEntities : DEFAULT_EARLY_GAME_ENTITIES;
    const recipeNames = requestedRecipes.length ? requestedRecipes : DEFAULT_EARLY_GAME_RECIPES;
    const forceName = String(input.force || "player");
    const surfaceName = input.surface ? String(input.surface) : "nauvis";
    const limit = clampCount(input.limit, 60, 500);
    let area = null;
    if (input.area || input.x1 !== undefined || input.y1 !== undefined || input.x2 !== undefined || input.y2 !== undefined) {
      const areaInput = input.area || {};
      const leftTop = requirePosition(
        areaInput.leftTop || areaInput.left_top || areaInput.min || { x: input.x1, y: input.y1 },
        "area.leftTop",
      );
      const rightBottom = requirePosition(
        areaInput.rightBottom || areaInput.right_bottom || areaInput.max || { x: input.x2, y: input.y2 },
        "area.rightBottom",
      );
      area = { leftTop, rightBottom };
    }

    const body = `
local force_name = ${luaValue(forceName)}
local surface_name = ${luaValue(surfaceName)}
local item_names = ${luaValue(itemNames)}
local entity_names = ${luaValue(entityNames)}
local recipe_names = ${luaValue(recipeNames)}
local area = ${luaValue(area)}
local limit = ${limit}

local function safe(fn, fallback)
  local ok, value = pcall(fn)
  if ok then return value end
  return fallback
end

local function pos(value)
  if not value then return nil end
  return {x = value.x or value[1], y = value.y or value[2]}
end

local function bbox(value)
  if not value then return nil end
  return safe(function()
    return {
      leftTop = pos(value.left_top or value.leftTop or value[1]),
      rightBottom = pos(value.right_bottom or value.rightBottom or value[2])
    }
  end, nil)
end

local function sorted_names(table_like)
  local names = {}
  if not table_like then return names end
  for name, enabled in pairs(table_like) do
    if enabled then table.insert(names, tostring(name)) end
  end
  table.sort(names)
  return names
end

local function stack_list(list)
  local out = {}
  if not list then return out end
  for _, entry in pairs(list) do
    table.insert(out, {
      name = entry.name,
      type = entry.type,
      amount = entry.amount,
      amountMin = entry.amount_min,
      amountMax = entry.amount_max,
      probability = entry.probability
    })
  end
  table.sort(out, function(a, b) return tostring(a.name or "") < tostring(b.name or "") end)
  return out
end

local function first_item_to_place(entity_proto)
  local items = safe(function() return entity_proto.items_to_place_this end, nil)
  if not items then return nil end
  for _, stack in pairs(items) do
    if stack and stack.name then return stack.name end
  end
  return nil
end

local function fluidbox_count(entity_proto)
  local boxes = safe(function() return entity_proto.fluidbox_prototypes end, nil)
  if not boxes then return 0 end
  local count = 0
  for _, _ in pairs(boxes) do count = count + 1 end
  return count
end

local function item_info(name)
  local proto = prototypes.item[name]
  if not proto then return {exists = false, name = name} end
  return {
    exists = true,
    name = proto.name,
    type = proto.type,
    stackSize = safe(function() return proto.stack_size end, nil),
    placeResult = safe(function() return proto.place_result and proto.place_result.name or nil end, nil),
    fuelCategory = safe(function() return proto.fuel_category end, nil),
    fuelValue = safe(function() return proto.fuel_value end, nil),
    subgroup = safe(function() return proto.subgroup and proto.subgroup.name or nil end, nil),
    order = safe(function() return proto.order end, nil)
  }
end

local function entity_info(name)
  local proto = prototypes.entity[name]
  if not proto then
    local item = prototypes.item[name]
    proto = safe(function() return item and item.place_result or nil end, nil)
  end
  if not proto then return {exists = false, name = name} end
  local burner = safe(function()
    if not proto.burner_prototype then return nil end
    return {
      fuelCategories = sorted_names(proto.burner_prototype.fuel_categories),
      effectivity = proto.burner_prototype.effectivity,
      fuelInventorySize = proto.burner_prototype.fuel_inventory_size
    }
  end, nil)
  local mineable = safe(function()
    local props = proto.mineable_properties
    if not props then return nil end
    return {
      miningTime = props.mining_time,
      products = stack_list(props.products)
    }
  end, nil)
  return {
    exists = true,
    name = proto.name,
    type = proto.type,
    itemToPlace = first_item_to_place(proto),
    collisionBox = bbox(proto.collision_box),
    selectionBox = bbox(proto.selection_box),
    tileWidth = safe(function() return proto.tile_width end, nil),
    tileHeight = safe(function() return proto.tile_height end, nil),
    maxHealth = safe(function() return proto.max_health end, nil),
    energyUsage = safe(function() return proto.energy_usage end, nil),
    maxEnergyUsage = safe(function() return proto.max_energy_usage end, nil),
    miningSpeed = safe(function() return proto.mining_speed end, nil),
    miningDrillRadius = safe(function() return proto.mining_drill_radius end, nil),
    resourceCategories = sorted_names(safe(function() return proto.resource_categories end, nil)),
    craftingCategories = sorted_names(safe(function() return proto.crafting_categories end, nil)),
    fluidboxCount = fluidbox_count(proto),
    supplyAreaDistance = safe(function() return proto.supply_area_distance end, nil),
    maximumWireDistance = safe(function() return proto.maximum_wire_distance end, nil),
    burner = burner,
    mineable = mineable
  }
end

local function recipe_info(force, name)
  local proto = prototypes.recipe[name]
  if not proto then return {exists = false, name = name} end
  local force_recipe = safe(function() return force and force.recipes[name] or nil end, nil)
  return {
    exists = true,
    name = proto.name,
    category = safe(function() return proto.category end, nil),
    enabled = force_recipe and force_recipe.enabled or false,
    energy = safe(function() return proto.energy end, nil),
    ingredients = stack_list(safe(function() return proto.ingredients end, nil)),
    products = stack_list(safe(function() return proto.products end, nil))
  }
end

local force = game.forces[force_name]
local surface = game.surfaces[surface_name] or game.surfaces[1]
local result = {
  query = "early_game_catalog",
  ok = false,
  tick = game.tick,
  force = force_name,
  surface = surface and surface.name or surface_name,
  items = {},
  entities = {},
  recipes = {},
  notes = {
    "Prototype and recipe facts come from the running save.",
    "Use this before planner-created early-game blueprints to catch missing entity, recipe, and area assumptions."
  }
}

if not force then
  result.error = "force_not_found"
  rcon.print(helpers.table_to_json(result))
  return
end
if not surface then
  result.error = "surface_not_found"
  rcon.print(helpers.table_to_json(result))
  return
end

for _, name in ipairs(item_names) do
  result.items[name] = item_info(name)
end
for _, name in ipairs(entity_names) do
  result.entities[name] = entity_info(name)
end
for _, name in ipairs(recipe_names) do
  result.recipes[name] = recipe_info(force, name)
end

if area then
  local area_box = {{area.leftTop.x, area.leftTop.y}, {area.rightBottom.x, area.rightBottom.y}}
  local interesting = {}
  for _, name in ipairs(entity_names) do interesting[name] = true end
  local entities = safe(function() return surface.find_entities_filtered{area = area_box} end, {}) or {}
  local entity_counts = {}
  local resources = {}
  local samples = {}
  for _, entity in ipairs(entities) do
    entity_counts[entity.name] = (entity_counts[entity.name] or 0) + 1
    if entity.type == "resource" then
      local amount = safe(function() return entity.amount end, nil)
      local row = resources[entity.name] or {count = 0, totalAmount = 0}
      row.count = row.count + 1
      row.totalAmount = row.totalAmount + (tonumber(amount) or 0)
      resources[entity.name] = row
    end
    if #samples < limit and (entity.type == "resource" or interesting[entity.name]) then
      table.insert(samples, {
        name = entity.name,
        type = entity.type,
        position = {x = entity.position.x, y = entity.position.y},
        amount = safe(function() return entity.amount end, nil),
        status = safe(function() return entity.status and tostring(entity.status) or nil end, nil)
      })
    end
  end
  local tile_counts = {}
  local water_tile_count = 0
  local tiles = safe(function() return surface.find_tiles_filtered{area = area_box} end, {}) or {}
  for _, tile in ipairs(tiles) do
    tile_counts[tile.name] = (tile_counts[tile.name] or 0) + 1
    if string.find(tile.name, "water", 1, true) then water_tile_count = water_tile_count + 1 end
  end
  result.areaSummary = {
    area = area,
    entityCount = #entities,
    entityCounts = entity_counts,
    resources = resources,
    tileCounts = tile_counts,
    waterTileCount = water_tile_count,
    samples = samples,
    sampleLimit = limit
  }
end

result.ok = true
rcon.print(helpers.table_to_json(result))
`;
    const output = await this.runTemplateLua("early_game_catalog.lua", body);
    const result = parseJsonObjectOutput(output, "early_game_catalog");
    result.supportedPlaceableItems = Object.fromEntries(PLACEABLE_ITEMS.entries());
    result.supportedCraftRecipes = Object.fromEntries(
      [...RECIPES.entries()].map(([name, recipe]) => [name, {
        count: recipe.count,
        ingredients: { ...recipe.ingredients },
      }]),
    );
    result.localCraftMissing = Object.fromEntries(
      Object.entries(result.recipes || {})
        .filter(([name, recipe]) => recipe?.exists && recipe?.enabled && !RECIPES.has(name))
        .map(([name, recipe]) => [name, {
          enabled: recipe.enabled,
          ingredients: recipe.ingredients || [],
          products: recipe.products || [],
        }]),
    );
    return result;
  }

  async productionStats(input) {
    const forceName = String(input.force || "player");
    const surfaceName = input.surface ? String(input.surface) : "nauvis";
    const precision = String(input.precision || "one_minute");
    if (!FLOW_PRECISIONS.has(precision)) {
      throw new Error(`unsupported production precision: ${precision}`);
    }
    const requestedItems = parseStringList(input.items ?? input.item, "items");
    const limit = clampCount(input.limit, requestedItems.length || 20, 200);
    const includeZero = parseBoolean(input.includeZero ?? input.include_zero, requestedItems.length > 0);
    const body = `
local force_name = ${luaValue(forceName)}
local surface_name = ${luaValue(surfaceName)}
local requested_items = ${luaValue(requestedItems)}
local default_items = ${luaValue(DEFAULT_PRODUCTION_ITEMS)}
local limit = ${limit}
local precision_name = ${luaValue(precision)}
local include_zero = ${includeZero ? "true" : "false"}

local function safe(fn, fallback)
  local ok, value = pcall(fn)
  if ok then return value end
  return fallback
end

local function add_name(names, seen, name)
  if name and name ~= "" and not seen[name] then
    seen[name] = true
    table.insert(names, name)
  end
end

local force = game.forces[force_name]
local surface = game.surfaces[surface_name] or game.surfaces[1]
local result = {
  query = "production_stats",
  api = "LuaForce.get_item_production_statistics(surface)",
  force = force_name,
  surface = surface and surface.name or surface_name,
  precision = precision_name,
  tick = game.tick,
  ok = false,
  items = {}
}

if not force then
  result.error = "force_not_found"
  rcon.print(helpers.table_to_json(result))
  return
end
if not surface then
  result.error = "surface_not_found"
  rcon.print(helpers.table_to_json(result))
  return
end

local stats = safe(function() return force.get_item_production_statistics(surface) end, nil)
if not stats then
  result.error = "item_production_statistics_unavailable"
  rcon.print(helpers.table_to_json(result))
  return
end

local precision = defines.flow_precision_index and defines.flow_precision_index[precision_name]
if precision == nil then
  result.error = "precision_not_found"
  rcon.print(helpers.table_to_json(result))
  return
end

local names = {}
local seen = {}
if #requested_items > 0 then
  for _, name in ipairs(requested_items) do add_name(names, seen, name) end
else
  local input_counts = safe(function() return stats.input_counts end, {}) or {}
  local output_counts = safe(function() return stats.output_counts end, {}) or {}
  for name, count in pairs(input_counts) do
    if include_zero or (tonumber(count) or 0) ~= 0 then add_name(names, seen, name) end
  end
  for name, count in pairs(output_counts) do
    if include_zero or (tonumber(count) or 0) ~= 0 then add_name(names, seen, name) end
  end
  for _, name in ipairs(default_items) do add_name(names, seen, name) end
end

local function total(category, name)
  if category == "input" then return safe(function() return stats.get_input_count(name) end, 0) or 0 end
  if category == "output" then return safe(function() return stats.get_output_count(name) end, 0) or 0 end
  return 0
end

local function flow(category, name, count)
  return safe(function()
    return stats.get_flow_count{
      category = category,
      name = name,
      precision_index = precision,
      count = count
    }
  end, nil)
end

for _, name in ipairs(names) do
  local total_produced = total("input", name)
  local total_consumed = total("output", name)
  local produced_per_min = flow("input", name, false)
  local consumed_per_min = flow("output", name, false)
  local produced_window_count = flow("input", name, true)
  local consumed_window_count = flow("output", name, true)
  local activity = math.abs(total_produced or 0) + math.abs(total_consumed or 0) +
    math.abs(produced_per_min or 0) + math.abs(consumed_per_min or 0)
  if include_zero or activity > 0 then
    table.insert(result.items, {
      name = name,
      totalProduced = total_produced,
      totalConsumed = total_consumed,
      totalNet = total_produced - total_consumed,
      producedPerMinute = produced_per_min,
      consumedPerMinute = consumed_per_min,
      netPerMinute = produced_per_min and consumed_per_min and (produced_per_min - consumed_per_min) or nil,
      windowProduced = produced_window_count,
      windowConsumed = consumed_window_count,
      windowNet = produced_window_count and consumed_window_count and (produced_window_count - consumed_window_count) or nil
    })
  end
end

table.sort(result.items, function(a, b)
  local a_activity = math.abs(a.producedPerMinute or 0) + math.abs(a.consumedPerMinute or 0) +
    math.abs(a.totalProduced or 0) + math.abs(a.totalConsumed or 0)
  local b_activity = math.abs(b.producedPerMinute or 0) + math.abs(b.consumedPerMinute or 0) +
    math.abs(b.totalProduced or 0) + math.abs(b.totalConsumed or 0)
  if a_activity == b_activity then return a.name < b.name end
  return a_activity > b_activity
end)

while #result.items > limit do table.remove(result.items) end
result.ok = true
result.count = #result.items
result.note = "For item production statistics, input maps to produced and output maps to consumed, matching the production GUI sides."
rcon.print(helpers.table_to_json(result))
`;
    const output = await this.runTemplateLua("production_stats.lua", body);
    return parseJsonObjectOutput(output, "production_stats");
  }

  entityRef(ref, label = "entity") {
    const value = parseToolJson(ref, label);
    if (!value || !value.name) throw new Error(`${label}.name is required`);
    const position = requirePosition(value.position || value, `${label}.position`);
    return { name: String(value.name), x: position.x, y: position.y };
  }

  blueprintsDir() {
    return join(this.config.agentWorkspace, "blueprints");
  }

  blueprintPath(name) {
    const value = String(name || "").replace(/\.json$/i, "");
    if (!BLUEPRINT_NAME_RE.test(value)) {
      throw new Error(`invalid blueprint name: ${name}`);
    }
    return join(this.blueprintsDir(), `${value}.json`);
  }

  async loadBlueprint(input) {
    const direct = parseToolJson(input.blueprint, "blueprint");
    if (direct && typeof direct === "object") {
      return this.normalizeBlueprint(direct, "blueprint");
    }
    const name = String(input.blueprint || input.name || input.blueprintName || input.blueprint_name || "");
    if (!name) throw new Error("execute_blueprint requires blueprint, name, blueprintName, or blueprint_name");
    const text = await readFile(this.blueprintPath(name), "utf8");
    return this.normalizeBlueprint(JSON.parse(text), name);
  }

  normalizeBlueprint(spec, label = "blueprint") {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      throw new Error(`${label} must be a JSON object`);
    }
    if (!Array.isArray(spec.entities) || spec.entities.length === 0) {
      throw new Error(`${label}.entities must be a non-empty array`);
    }
    const keys = new Set();
    const entities = spec.entities.map((raw, index) => {
      const type = String(raw.item || raw.type || raw.name || "");
      const item = PLACEABLE_ITEMS.has(type) ? type : ENTITY_TO_ITEM.get(type);
      const entityName = item ? PLACEABLE_ITEMS.get(item) : null;
      if (!item || !entityName) {
        throw new Error(`${label}.entities[${index}] has unsupported placeable item/entity: ${type}`);
      }
      const key = String(raw.key || raw.id || `${entityName}_${index + 1}`);
      if (keys.has(key)) throw new Error(`${label}.entities[${index}] duplicates key: ${key}`);
      keys.add(key);
      const dx = Number(raw.dx ?? raw.offset?.x ?? raw.position?.x ?? raw.x ?? 0);
      const dy = Number(raw.dy ?? raw.offset?.y ?? raw.position?.y ?? raw.y ?? 0);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
        throw new Error(`${label}.entities[${index}] dx/dy must be numeric`);
      }
      const entityLabel = `${label}.entities[${index}]`;
      const settings = normaliseEntitySettings(raw.settings, item, entityLabel);
      return {
        key,
        item,
        entity: entityName,
        dx,
        dy,
        direction: String(raw.direction || raw.dir || "north"),
        settings,
      };
    });
    if (spec.fuel !== undefined) {
      throw new Error(`${label}.fuel is no longer supported; move per-entity fuel into entity.settings.fuel`);
    }
    // Flatten settings into a single ordered action list so the Lua
    // executor can iterate once and dispatch by action.kind.
    const settingsActions = [];
    for (const ent of entities) {
      if (!ent.settings) continue;
      if (ent.settings.fuel) {
        settingsActions.push({
          kind: "fuel",
          target: ent.key,
          item: ent.settings.fuel.item,
          count: ent.settings.fuel.count,
          inventory: this.inventoryKind(ent.settings.fuel.inventory),
        });
      }
      if (ent.settings.recipe) {
        settingsActions.push({
          kind: "recipe",
          target: ent.key,
          recipe: ent.settings.recipe,
        });
      }
    }
    return {
      version: Number(spec.version || 1),
      name: String(spec.name || label),
      description: spec.description ? String(spec.description) : "",
      anchor: spec.anchor ? String(spec.anchor) : null,
      entities,
      settingsActions,
      assertions: Array.isArray(spec.assertions) ? spec.assertions.map((item) => String(item)) : [],
    };
  }

  async executeBlueprint(input) {
    const blueprint = await this.loadBlueprint(input);
    const anchor = requirePosition(input.anchor || input.position || { x: 0, y: 0 }, "anchor");
    const dryRun = parseBoolean(input.dryRun ?? input.dry_run, false);
    const materialPolicy = this.config.materialPolicy || "strict";
    await this.ensureWorkerCharacter();
    const body = `
${workerLuaPrelude()}
local blueprint = ${luaValue(blueprint)}
local anchor = ${luaValue(anchor)}
local dry_run = ${dryRun ? "true" : "false"}
local material_policy = ${luaValue(materialPolicy)}
local surface = game.surfaces[1]
local force = game.forces["player"]

local worker = find_worker()
if not worker then rcon.print("ok=false"); rcon.print("error=worker_not_found"); return end
local inv = worker_inventory(worker)
if not inv then return end

local result = {
  query = "execute_blueprint",
  blueprint = blueprint.name,
  dryRun = dry_run,
  materialPolicy = material_policy,
  inventoryEnforced = material_policy == "strict",
  anchor = anchor,
  ok = false,
  requiredItems = {},
  missingItems = {},
  consumedItems = {},
  virtualItems = {},
  placement = {},
  blockedPlacements = {},
  placed = {},
  fuelTransfers = {},
  recipesSet = {}
}

local function finish(ok, error_name)
  result.ok = ok
  if error_name then result.error = error_name end
  rcon.print("ok=" .. tostring(ok))
  if error_name then rcon.print("error=" .. tostring(error_name)) end
  print_worker(worker)
  print_inventory(inv)
  rcon.print(helpers.table_to_json(result))
end

local function add_required(item, count)
  result.requiredItems[item] = (result.requiredItems[item] or 0) + count
end

for _, entity in ipairs(blueprint.entities) do
  add_required(entity.item, 1)
end
for _, action in ipairs(blueprint.settingsActions or {}) do
  if action.kind == "fuel" then
    add_required(action.item, action.count)
  end
end

for item, count in pairs(result.requiredItems) do
  local available = inv.get_item_count(item)
  if material_policy == "virtual" then
    result.virtualItems[item] = count
  elseif available < count then
    result.missingItems[item] = {available = available, required = count, missing = count - available}
  end
end

for index, entity in ipairs(blueprint.entities) do
  local position = {x = anchor.x + entity.dx, y = anchor.y + entity.dy}
  local direction = defines.direction[entity.direction] or defines.direction.north
  local can_place = surface.can_place_entity{
    name = entity.entity,
    position = position,
    direction = direction,
    force = force
  }
  local entry = {
    key = entity.key,
    item = entity.item,
    entity = entity.entity,
    position = position,
    direction = entity.direction,
    canPlace = can_place
  }
  table.insert(result.placement, entry)
  if not can_place then table.insert(result.blockedPlacements, entry) end
end

if next(result.missingItems) ~= nil or #result.blockedPlacements > 0 then
  finish(false, "precondition_failed")
  return
end
if dry_run then
  finish(true, nil)
  return
end

local removed = {}
local created = {}
local created_by_key = {}

local function consume_item(item, count)
  if material_policy == "virtual" then
    return true
  end
  local actual = inv.remove{name = item, count = count}
  removed[item] = (removed[item] or 0) + actual
  result.consumedItems[item] = (result.consumedItems[item] or 0) + actual
  return actual == count
end

local function rollback()
  for _, entity in ipairs(created) do
    if entity and entity.valid then entity.destroy() end
  end
  for item, count in pairs(removed) do
    if count > 0 then inv.insert{name = item, count = count} end
  end
  result.consumedItems = {}
end

for _, entity in ipairs(blueprint.entities) do
  if not consume_item(entity.item, 1) then
    rollback()
    result.failedItem = entity.item
    finish(false, "worker_remove_failed")
    return
  end
  local position = {x = anchor.x + entity.dx, y = anchor.y + entity.dy}
  local direction = defines.direction[entity.direction] or defines.direction.north
  local placed = surface.create_entity{
    name = entity.entity,
    position = position,
    direction = direction,
    force = force,
    raise_built = false
  }
  if not placed then
    rollback()
    result.failedEntity = entity.entity
    finish(false, "create_entity_failed")
    return
  end
  table.insert(created, placed)
  created_by_key[entity.key] = placed
  table.insert(result.placed, {
    key = entity.key,
    item = entity.item,
    entity = placed.name,
    unitNumber = placed.unit_number,
    position = {x = placed.position.x, y = placed.position.y},
    direction = entity.direction
  })
end

for _, action in ipairs(blueprint.settingsActions or {}) do
  local target = created_by_key[action.target]
  if not target or not target.valid then
    rollback()
    result.failedSettingsTarget = action.target
    finish(false, "settings_target_not_found")
    return
  end
  if action.kind == "fuel" then
    local target_inv = entity_inventory(target, action.inventory)
    if not target_inv or not target_inv.valid then
      rollback()
      result.failedSettingsTarget = action.target
      finish(false, "fuel_inventory_not_found")
      return
    end
    if target_inv.get_insertable_count(action.item) < action.count then
      rollback()
      result.failedSettingsTarget = action.target
      finish(false, "fuel_inventory_full")
      return
    end
    if not consume_item(action.item, action.count) then
      rollback()
      result.failedItem = action.item
      finish(false, "worker_remove_failed")
      return
    end
    local inserted = target_inv.insert{name = action.item, count = action.count}
    if inserted ~= action.count then
      rollback()
      result.failedSettingsTarget = action.target
      result.inserted = inserted
      finish(false, "fuel_insert_failed")
      return
    end
    table.insert(result.fuelTransfers, {
      target = action.target,
      entity = target.name,
      unitNumber = target.unit_number,
      inventory = action.inventory,
      item = action.item,
      count = action.count
    })
  elseif action.kind == "recipe" then
    local ok_set, err = pcall(function() target.set_recipe(action.recipe) end)
    if not ok_set or target.get_recipe() == nil then
      rollback()
      result.failedSettingsTarget = action.target
      result.recipeError = tostring(err)
      finish(false, "recipe_set_failed")
      return
    end
    table.insert(result.recipesSet, {
      target = action.target,
      entity = target.name,
      unitNumber = target.unit_number,
      recipe = action.recipe
    })
  end
end

finish(true, nil)
`;
    const output = await this.runTemplateLua("execute_blueprint.lua", body);
    const result = parseJsonObjectOutput(output, "execute_blueprint");
    const persisted = await this.persistWorkerOutput(output, result.ok && !dryRun ? {
      id: actionId(),
      type: "execute_blueprint",
      blueprint: blueprint.name,
      materialPolicy,
      anchor,
      placed: result.placed || [],
      fuelTransfers: result.fuelTransfers || [],
      at: new Date().toISOString(),
    } : null);
    if (!dryRun && !result.ok) {
      throw new Error(`execute_blueprint failed: ${result.error || "unknown_error"} ${JSON.stringify({
        missingItems: result.missingItems,
        blockedPlacements: result.blockedPlacements,
      })}`);
    }
    return {
      ...result,
      worker: persisted.worker,
      inventory: persisted.inventory,
    };
  }

  async composeChain(input) {
    const chain = parseToolJson(input.chain || input, "chain");
    if (!chain || typeof chain !== "object" || !chain.origin) {
      throw new Error("compose_chain requires chain.origin");
    }
    const loaded = await loadEntityGeometries(this.config.agentWorkspace);
    const solved = await solveLayout(
      chain,
      loaded.geometries,
      (entities) => this.validatePlacement(entities),
    );
    if (!solved.ok) return solved;

    const anchor = solved.entities[0]?.pose?.center;
    if (!anchor) {
      return {
        ok: false,
        code: "compose_chain_invalid_result",
        reason: "solver returned no origin entity",
      };
    }
    const name = String(input.name || input.blueprintName || input.blueprint_name || "compose_chain");
    const blueprint = {
      version: 1,
      name,
      description: "Generated by Geometry Layer v1 compose_chain",
      anchor: "origin entity center",
      entities: solved.entities.map((entity, index) => ({
        key: entity.ref === "origin" ? "origin" : `step_${index}`,
        item: entity.prototype,
        dx: entity.pose.center.x - anchor.x,
        dy: entity.pose.center.y - anchor.y,
        direction: directionName(entity.pose.direction),
      })),
      assertions: [
        "geometry_layer_v1_compose_chain",
        "engine_oracle_validated",
      ],
    };
    this.normalizeBlueprint(blueprint, name);
    return {
      ...solved,
      anchor,
      blueprint_json: blueprint,
    };
  }

  async loadCapabilityIndex() {
    const path = join(this.config.agentWorkspace, "capabilities", "index.json");
    const text = await readFile(path, "utf8");
    return JSON.parse(text);
  }

  resolveCapabilityModule(entry) {
    if (!entry?.module || typeof entry.module !== "string") {
      throw new Error("capability index entry requires module");
    }
    const capabilitiesDir = resolve(this.config.agentWorkspace, "capabilities");
    const modulePath = resolve(capabilitiesDir, entry.module);
    const rel = relative(capabilitiesDir, modulePath);
    if (rel.startsWith("..") || rel === "" || resolve(rel) === rel) {
      throw new Error(`capability module must stay under capabilities/: ${entry.module}`);
    }
    return modulePath;
  }

  capabilityExportName(id) {
    return String(id).replace(/_([a-z0-9])/g, (_match, chr) => chr.toUpperCase());
  }

  buildInlineBlueprintFromEntities({ name, description, entities, assertions }) {
    const anchor = entities[0]?.pose?.center;
    if (!anchor) {
      return {
        ok: false,
        code: "compose_capability_invalid_result",
        reason: "capability returned no origin entity",
      };
    }
    const blueprint = {
      version: 1,
      name,
      description,
      anchor: "origin entity center",
      entities: entities.map((entity, index) => ({
        key: entity.ref === "origin" ? "origin" : `step_${index}`,
        item: entity.prototype,
        dx: entity.pose.center.x - anchor.x,
        dy: entity.pose.center.y - anchor.y,
        direction: directionName(entity.pose.direction),
      })),
      assertions,
    };
    this.normalizeBlueprint(blueprint, name);
    return { anchor, blueprint_json: blueprint };
  }

  async composeCapability(input) {
    const capabilityId = String(input.capability || input.capability_id || input.id || "").trim();
    if (!capabilityId) throw new Error("compose_capability requires capability");
    const params = parseToolJson(input.params || input.capabilityParams || input.capability_params || {}, "params");
    const index = await this.loadCapabilityIndex();
    const entry = (index.capabilities || []).find((item) => item.id === capabilityId);
    if (!entry) {
      return {
        ok: false,
        code: "unknown_capability",
        reason: `capability not found: ${capabilityId}`,
      };
    }

    const modulePath = this.resolveCapabilityModule(entry);
    const moduleInfo = await stat(modulePath);
    const moduleUrl = `${pathToFileURL(modulePath).href}?mtime=${Math.trunc(moduleInfo.mtimeMs)}`;
    const module = await import(moduleUrl);
    const exportName = entry.export || this.capabilityExportName(capabilityId);
    const factory = module[exportName] || module.default;
    if (typeof factory !== "function") {
      throw new Error(`capability ${capabilityId} does not export ${exportName}`);
    }

    const loaded = await loadEntityGeometries(this.config.agentWorkspace);
    const result = await factory(
      params,
      loaded.geometries,
      (entities) => this.validatePlacement(entities),
    );
    if (!result.ok) return result;

    const name = String(input.name || input.blueprintName || input.blueprint_name || capabilityId);
    const built = this.buildInlineBlueprintFromEntities({
      name,
      description: `Generated by Geometry Layer v1 capability ${capabilityId}`,
      entities: result.entities,
      assertions: [
        "geometry_layer_v1_compose_capability",
        `capability:${capabilityId}`,
        "engine_oracle_validated",
      ],
    });
    if (built.ok === false) return built;
    return {
      ...result,
      capability: capabilityId,
      anchor: built.anchor,
      blueprint_json: built.blueprint_json,
    };
  }

  async connectBelt(input) {
    const from = requirePosition(parseToolJson(input.from || input.start || input.position, "from"), "from");
    const to = requirePosition(parseToolJson(input.to || input.end || input.target, "to"), "to");
    const dryRun = parseBoolean(input.dryRun ?? input.dry_run, false);
    const materialPolicy = this.config.materialPolicy || "strict";
    const path = buildBeltPath(from, to, input);
    await this.ensureWorkerCharacter();
    const body = `
${workerLuaPrelude()}
local path = ${luaValue(path)}
local from = ${luaValue(from)}
local to = ${luaValue(to)}
local dry_run = ${dryRun ? "true" : "false"}
local material_policy = ${luaValue(materialPolicy)}
local surface = game.surfaces[1]
local force = game.forces["player"]

local worker = find_worker()
if not worker then rcon.print("ok=false"); rcon.print("error=worker_not_found"); return end
local inv = worker_inventory(worker)
if not inv then return end

local result = {
  query = "connect_belt",
  dryRun = dry_run,
  materialPolicy = material_policy,
  inventoryEnforced = material_policy == "strict",
  from = from,
  to = to,
  path = path,
  pathLength = #path,
  bypassedInventory = material_policy == "virtual",
  ok = false,
  requiredItems = {},
  missingItems = {},
  consumedItems = {},
  virtualItems = {},
  placement = {},
  blockedPlacements = {},
  created = {},
  updated = {}
}

local function direction_value(name)
  return defines.direction[name] or defines.direction.north
end

local function tile_area(position)
  return {{position.x - 0.45, position.y - 0.45}, {position.x + 0.45, position.y + 0.45}}
end

local function existing_belt(position)
  local belts = surface.find_entities_filtered{
    area = tile_area(position),
    name = "transport-belt",
    force = force
  }
  for _, belt in ipairs(belts) do
    if math.abs(belt.position.x - position.x) < 0.1 and math.abs(belt.position.y - position.y) < 0.1 then
      return belt
    end
  end
  return nil
end

local function blocker_names(position)
  local names = {}
  for _, entity in ipairs(surface.find_entities_filtered{area = tile_area(position)}) do
    if entity.name ~= "transport-belt" and entity.type ~= "resource" then
      table.insert(names, {
        name = entity.name,
        type = entity.type,
        unitNumber = entity.unit_number,
        position = {x = entity.position.x, y = entity.position.y}
      })
    end
  end
  return names
end

local function finish(ok, error_name)
  result.ok = ok
  if error_name then result.error = error_name end
  rcon.print("ok=" .. tostring(ok))
  if error_name then rcon.print("error=" .. tostring(error_name)) end
  print_worker(worker)
  print_inventory(inv)
  rcon.print(helpers.table_to_json(result))
end

for index, entry in ipairs(path) do
  local direction = direction_value(entry.direction)
  local existing = existing_belt(entry.position)
  local can_place = existing ~= nil
  if not existing then
    can_place = surface.can_place_entity{
      name = "transport-belt",
      position = entry.position,
      direction = direction,
      force = force
    }
  end
  local placement = {
    index = index,
    position = entry.position,
    direction = entry.direction,
    canPlace = can_place,
    existing = existing and {
      name = existing.name,
      unitNumber = existing.unit_number,
      direction = existing.direction
    } or nil
  }
  table.insert(result.placement, placement)
  if not existing then
    result.requiredItems["transport-belt"] = (result.requiredItems["transport-belt"] or 0) + 1
  end
  if not can_place then
    placement.blockers = blocker_names(entry.position)
    table.insert(result.blockedPlacements, placement)
  end
end

for item, count in pairs(result.requiredItems) do
  local available = inv.get_item_count(item)
  if material_policy == "virtual" then
    result.virtualItems[item] = count
  elseif available < count then
    result.missingItems[item] = {available = available, required = count, missing = count - available}
  end
end

if next(result.missingItems) ~= nil or #result.blockedPlacements > 0 then
  finish(false, "precondition_failed")
  return
end
if dry_run then
  finish(true, nil)
  return
end

local function consume_item(item, count)
  if material_policy == "virtual" then
    return true
  end
  local actual = inv.remove{name = item, count = count}
  result.consumedItems[item] = (result.consumedItems[item] or 0) + actual
  return actual == count
end

local function restore_item(item, count)
  if material_policy ~= "virtual" and count > 0 then
    inv.insert{name = item, count = count}
    result.consumedItems[item] = math.max((result.consumedItems[item] or 0) - count, 0)
  end
end

for index, entry in ipairs(path) do
  local direction = direction_value(entry.direction)
  local existing = existing_belt(entry.position)
  if existing then
    local old_direction = existing.direction
    existing.direction = direction
    table.insert(result.updated, {
      index = index,
      unitNumber = existing.unit_number,
      position = {x = existing.position.x, y = existing.position.y},
      oldDirection = old_direction,
      direction = entry.direction
    })
  else
    if not consume_item("transport-belt", 1) then
      result.failedItem = "transport-belt"
      result.failedIndex = index
      finish(false, "worker_remove_failed")
      return
    end
    local placed = surface.create_entity{
      name = "transport-belt",
      position = entry.position,
      direction = direction,
      force = force,
      raise_built = false
    }
    if not placed then
      restore_item("transport-belt", 1)
      result.failedIndex = index
      result.failedPosition = entry.position
      finish(false, "create_entity_failed")
      return
    end
    table.insert(result.created, {
      index = index,
      unitNumber = placed.unit_number,
      position = {x = placed.position.x, y = placed.position.y},
      direction = entry.direction
    })
  end
end

finish(true, nil)
`;
    const output = await this.runTemplateLua("connect_belt.lua", body);
    const result = parseJsonObjectOutput(output, "connect_belt");
    const persisted = await this.persistWorkerOutput(output, result.ok && !dryRun ? {
      id: actionId(),
      type: "connect_belt",
      from,
      to,
      materialPolicy,
      pathLength: result.pathLength,
      created: result.created || [],
      updated: result.updated || [],
      bypassedInventory: result.bypassedInventory,
      at: new Date().toISOString(),
    } : null);
    if (!dryRun && !result.ok) {
      throw new Error(`connect_belt failed: ${result.error || "unknown_error"} ${JSON.stringify({
        missingItems: result.missingItems,
        blockedPlacements: result.blockedPlacements,
      })}`);
    }
    return {
      ...result,
      worker: persisted.worker,
      inventory: persisted.inventory,
    };
  }

  async connectPower(input) {
    const from = requirePosition(parseToolJson(input.from || input.start || input.position, "from"), "from");
    const to = requirePosition(parseToolJson(input.to || input.end || input.target, "to"), "to");
    const dryRun = parseBoolean(input.dryRun ?? input.dry_run, false);
    const materialPolicy = this.config.materialPolicy || "strict";
    const poleItem = String(input.item || input.pole || "small-electric-pole");
    const poleEntity = PLACEABLE_ITEMS.get(poleItem) || ENTITY_TO_ITEM.has(poleItem) && poleItem;
    if (!poleEntity || !["small-electric-pole", "medium-electric-pole"].includes(poleEntity)) {
      throw new Error(`unsupported power pole: ${poleItem}`);
    }
    const path = buildPowerPath(from, to, input);
    await this.ensureWorkerCharacter();
    const body = `
${workerLuaPrelude()}
local path = ${luaValue(path)}
local from = ${luaValue(from)}
local to = ${luaValue(to)}
local pole_entity = ${luaValue(poleEntity)}
local dry_run = ${dryRun ? "true" : "false"}
local material_policy = ${luaValue(materialPolicy)}
local surface = game.surfaces[1]
local force = game.forces["player"]

local worker = find_worker()
if not worker then rcon.print("ok=false"); rcon.print("error=worker_not_found"); return end
local inv = worker_inventory(worker)
if not inv then return end

local result = {
  query = "connect_power",
  dryRun = dry_run,
  materialPolicy = material_policy,
  inventoryEnforced = material_policy == "strict",
  from = from,
  to = to,
  pole = pole_entity,
  path = path,
  pathLength = #path,
  bypassedInventory = material_policy == "virtual",
  ok = false,
  requiredItems = {},
  missingItems = {},
  consumedItems = {},
  virtualItems = {},
  placement = {},
  blockedPlacements = {},
  created = {},
  reused = {}
}

local function tile_area(position)
  return {{position.x - 0.45, position.y - 0.45}, {position.x + 0.45, position.y + 0.45}}
end

local function existing_pole(position)
  local entities = surface.find_entities_filtered{area = tile_area(position), force = force}
  for _, entity in ipairs(entities) do
    if entity.type == "electric-pole" then
      return entity
    end
  end
  return nil
end

local function blocker_names(position)
  local names = {}
  for _, entity in ipairs(surface.find_entities_filtered{area = tile_area(position)}) do
    if entity.type ~= "resource" and entity.type ~= "electric-pole" then
      table.insert(names, {
        name = entity.name,
        type = entity.type,
        unitNumber = entity.unit_number,
        position = {x = entity.position.x, y = entity.position.y}
      })
    end
  end
  return names
end

local function finish(ok, error_name)
  result.ok = ok
  if error_name then result.error = error_name end
  rcon.print("ok=" .. tostring(ok))
  if error_name then rcon.print("error=" .. tostring(error_name)) end
  print_worker(worker)
  print_inventory(inv)
  rcon.print(helpers.table_to_json(result))
end

for index, entry in ipairs(path) do
  local existing = existing_pole(entry.position)
  local can_place = existing ~= nil
  if not existing then
    can_place = surface.can_place_entity{
      name = pole_entity,
      position = entry.position,
      force = force
    }
  end
  local placement = {
    index = index,
    position = entry.position,
    canPlace = can_place,
    existing = existing and {
      name = existing.name,
      unitNumber = existing.unit_number,
      position = {x = existing.position.x, y = existing.position.y}
    } or nil
  }
  table.insert(result.placement, placement)
  if not existing then
    result.requiredItems[pole_entity] = (result.requiredItems[pole_entity] or 0) + 1
  end
  if not can_place then
    placement.blockers = blocker_names(entry.position)
    table.insert(result.blockedPlacements, placement)
  end
end

for item, count in pairs(result.requiredItems) do
  local available = inv.get_item_count(item)
  if material_policy == "virtual" then
    result.virtualItems[item] = count
  elseif available < count then
    result.missingItems[item] = {available = available, required = count, missing = count - available}
  end
end

if next(result.missingItems) ~= nil or #result.blockedPlacements > 0 then
  finish(false, "precondition_failed")
  return
end
if dry_run then
  finish(true, nil)
  return
end

local function consume_item(item, count)
  if material_policy == "virtual" then
    return true
  end
  local actual = inv.remove{name = item, count = count}
  result.consumedItems[item] = (result.consumedItems[item] or 0) + actual
  return actual == count
end

local function restore_item(item, count)
  if material_policy ~= "virtual" and count > 0 then
    inv.insert{name = item, count = count}
    result.consumedItems[item] = math.max((result.consumedItems[item] or 0) - count, 0)
  end
end

local previous = nil
for index, entry in ipairs(path) do
  local pole = existing_pole(entry.position)
  if pole then
    table.insert(result.reused, {
      index = index,
      entity = pole.name,
      unitNumber = pole.unit_number,
      position = {x = pole.position.x, y = pole.position.y}
    })
  else
    if not consume_item(pole_entity, 1) then
      result.failedItem = pole_entity
      result.failedIndex = index
      finish(false, "worker_remove_failed")
      return
    end
    pole = surface.create_entity{
      name = pole_entity,
      position = entry.position,
      force = force,
      raise_built = false
    }
    if not pole then
      restore_item(pole_entity, 1)
      result.failedIndex = index
      result.failedPosition = entry.position
      finish(false, "create_entity_failed")
      return
    end
    table.insert(result.created, {
      index = index,
      entity = pole.name,
      unitNumber = pole.unit_number,
      position = {x = pole.position.x, y = pole.position.y}
    })
  end
  previous = pole
end

finish(true, nil)
`;
    const output = await this.runTemplateLua("connect_power.lua", body);
    const result = parseJsonObjectOutput(output, "connect_power");
    const persisted = await this.persistWorkerOutput(output, result.ok && !dryRun ? {
      id: actionId(),
      type: "connect_power",
      from,
      to,
      pole: poleEntity,
      materialPolicy,
      pathLength: result.pathLength,
      created: result.created || [],
      reused: result.reused || [],
      bypassedInventory: result.bypassedInventory,
      at: new Date().toISOString(),
    } : null);
    if (!dryRun && !result.ok) {
      throw new Error(`connect_power failed: ${result.error || "unknown_error"} ${JSON.stringify({
        missingItems: result.missingItems,
        blockedPlacements: result.blockedPlacements,
      })}`);
    }
    return {
      ...result,
      worker: persisted.worker,
      inventory: persisted.inventory,
    };
  }

  async routeBelt(input) {
    const from = requirePosition(parseToolJson(input.from || input.start, "from"), "from");
    const to = requirePosition(parseToolJson(input.to || input.end || input.target, "to"), "to");
    const allowUnderground = parseBoolean(input.allowUnderground ?? input.allow_underground, false);
    const undergroundMaxDistance = clampCount(input.undergroundMaxDistance ?? input.max_underground_distance, 2, 10);

    // Parse occupied tiles if provided
    const occupiedInput = input.occupied || input.blocked || [];
    const occupied = Array.isArray(occupiedInput)
      ? occupiedInput.map(t => ({ x: Math.floor(t.x ?? t.position?.x ?? 0), y: Math.floor(t.y ?? t.position?.y ?? 0) }))
      : [];

    // Import routeBelt function
    const { routeBelt } = await import("./geometry/belt_routing.js");
    const { DIRECTION } = await import("./geometry/schema.js");

    // Convert direction names to DIRECTION constants if provided
    const fromDir = input.fromDirection ?? from.direction;
    const toDir = input.toDirection ?? to.direction;
    const fromDirection = typeof fromDir === "string"
      ? { north: DIRECTION.NORTH, east: DIRECTION.EAST, south: DIRECTION.SOUTH, west: DIRECTION.WEST }[fromDir.toLowerCase()]
      : fromDir;
    const toDirection = typeof toDir === "string"
      ? { north: DIRECTION.NORTH, east: DIRECTION.EAST, south: DIRECTION.SOUTH, west: DIRECTION.WEST }[toDir.toLowerCase()]
      : toDir;

    const result = routeBelt(
      { x: from.x, y: from.y, direction: fromDirection },
      { x: to.x, y: to.y, direction: toDirection },
      occupied,
      { allowUnderground, undergroundMaxDistance },
    );

    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        reason: result.reason,
        from,
        to,
        allowUnderground,
      };
    }

    return {
      ok: true,
      from,
      to,
      path: result.path,
      entities: result.entities,
      length: result.length,
      allowUnderground,
      undergroundUsed: result.entities.some(e => e.prototype === "underground-belt"),
    };
  }

  async moveTo(input) {
    const position = requirePosition(input.position || input, "position");
    await this.ensureWorkerCharacter();
    const body = `
${workerLuaPrelude()}
local worker = find_worker()
if not worker then rcon.print("ok=false"); rcon.print("error=worker_not_found"); return end
local ok = worker.teleport({${position.x}, ${position.y}}, surface, false)
if not ok then
  rcon.print("ok=false")
  rcon.print("error=worker_teleport_failed")
  return
end
local inv = worker_inventory(worker)
if not inv then return end
rcon.print("ok=true")
print_worker(worker)
print_inventory(inv)
`;
    const output = await this.runTemplateLua("worker_move_to.lua", body);
    const result = await this.persistWorkerOutput(output, {
      id: actionId(),
      type: "move_to",
      position,
      at: new Date().toISOString(),
    });
    if (!result.parsed.ok) throw new Error(`move_to failed: ${result.parsed.error || output}`);
    return { moved: true, worker: result.worker, position: result.worker.position, inventory: result.inventory, output };
  }

  async mineResource(input) {
    const resource = String(input.resource || input.item || "");
    if (!RESOURCE_ITEMS.has(resource)) throw new Error(`unsupported manual mining resource: ${resource}`);
    const position = requirePosition(input.position, "position");
    const count = clampCount(input.count, 1, 1000);
    await this.ensureWorkerCharacter();
    const body = `
${workerLuaPrelude()}
local surface = game.surfaces[1]
local resource = ${luaValue(resource)}
local x = ${position.x}
local y = ${position.y}
local requested = ${count}
local reach = ${WORKER_ACTION_REACH}
local worker = find_worker()
if not worker then rcon.print("ok=false"); rcon.print("error=worker_not_found"); return end
local inv = worker_inventory(worker)
if not inv then return end
local dx = worker.position.x - x
local dy = worker.position.y - y
local distance = math.sqrt(dx * dx + dy * dy)
if distance > reach then
  rcon.print("ok=false")
  rcon.print("error=worker_out_of_range")
  rcon.print("distance=" .. distance)
  rcon.print("reach=" .. reach)
  return
end
-- Trees are named "tree-09" etc, not "wood"; search by type when resource is wood.
if resource == "wood" then
  local trees = surface.find_entities_filtered{area = {{x - 0.75, y - 0.75}, {x + 0.75, y + 0.75}}, type = "tree"}
  if #trees == 0 then
    rcon.print("ok=false")
    rcon.print("error=resource_not_found")
    return
  end
  local tree = trees[1]
  local yield = 1
  local ok2, mp = pcall(function() return tree.prototype.mineable_properties end)
  if ok2 and mp and mp.products then
    for _, p in ipairs(mp.products) do
      if p.name == "wood" then yield = p.amount or p.amount_max or 1; break end
    end
  end
  local to_insert = math.min(requested, yield)
  local before = inv.get_item_count("wood")
  local inserted = inv.insert{name = "wood", count = to_insert}
  tree.destroy()
  local after = inv.get_item_count("wood")
  rcon.print("ok=true")
  rcon.print("mined=" .. inserted)
  rcon.print("remaining=0")
  print_worker(worker)
  print_inventory(inv)
  return
end
local entities = surface.find_entities_filtered{area = {{x - 0.75, y - 0.75}, {x + 0.75, y + 0.75}}, name = resource}
if #entities == 0 then
  rcon.print("ok=false")
  rcon.print("error=resource_not_found")
  return
end
local entity = entities[1]
local amount = entity.amount or 0
local mined = math.min(requested, amount)
if mined <= 0 then
  rcon.print("ok=false")
  rcon.print("error=resource_empty")
  return
end
local remaining = amount - mined
if inv.get_insertable_count(resource) < mined then
  rcon.print("ok=false")
  rcon.print("error=worker_inventory_full")
  return
end
local before = inv.get_item_count(resource)
local inserted = inv.insert{name = resource, count = mined}
if inserted ~= mined then
  if inserted > 0 then inv.remove{name = resource, count = inserted} end
  rcon.print("ok=false")
  rcon.print("error=worker_insert_failed")
  rcon.print("inserted=" .. inserted)
  return
end
if remaining <= 0 then
  entity.destroy()
else
  entity.amount = remaining
end
local after = inv.get_item_count(resource)
if after - before ~= mined then
  inv.remove{name = resource, count = inserted}
  rcon.print("ok=false")
  rcon.print("error=worker_inventory_verification_failed")
  rcon.print("before=" .. before)
  rcon.print("after=" .. after)
  return
end
rcon.print("ok=true")
rcon.print("mined=" .. mined)
rcon.print("remaining=" .. remaining)
print_worker(worker)
print_inventory(inv)
`;
    const output = await this.runTemplateLua("manual_mine_resource.lua", body);
    const parsed = parseKeyValueOutput(output);
    const result = await this.persistWorkerOutput(output, parsed.ok ? {
      id: actionId(),
      type: "mine_resource",
      resource,
      position,
      count: parsed.mined,
      at: new Date().toISOString(),
    } : null);
    if (!parsed.ok) throw new Error(`mine_resource failed: ${parsed.error || output}`);
    return { resource, mined: parsed.mined, remaining: parsed.remaining, worker: result.worker, inventory: result.inventory, output };
  }

  async craft(input) {
    const item = String(input.item || "");
    const times = clampCount(input.count, 1, 1000);
    const recipe = RECIPES.get(item);
    if (!recipe) throw new Error(`unsupported craft recipe: ${item}`);
    await this.ensureWorkerCharacter();
    const produced = recipe.count * times;
    const body = `
${workerLuaPrelude()}
local worker = find_worker()
if not worker then rcon.print("ok=false"); rcon.print("error=worker_not_found"); return end
local inv = worker_inventory(worker)
if not inv then return end
local item = ${luaValue(item)}
local produced = ${produced}
local ingredients = ${luaValue(recipe.ingredients)}
local times = ${times}
for ingredient, count in pairs(ingredients) do
  local needed = count * times
  if inv.get_item_count(ingredient) < needed then
    rcon.print("ok=false")
    rcon.print("error=missing_ingredient")
    rcon.print("ingredient=" .. ingredient)
    rcon.print("available=" .. inv.get_item_count(ingredient))
    rcon.print("needed=" .. needed)
    return
  end
end
if inv.get_insertable_count(item) < produced then
  rcon.print("ok=false")
  rcon.print("error=worker_inventory_full")
  return
end
local removed = {}
for ingredient, count in pairs(ingredients) do
  local needed = count * times
  local actual = inv.remove{name = ingredient, count = needed}
  removed[ingredient] = actual
  if actual ~= needed then
    for rollback_item, rollback_count in pairs(removed) do
      if rollback_count > 0 then inv.insert{name = rollback_item, count = rollback_count} end
    end
    rcon.print("ok=false")
    rcon.print("error=ingredient_remove_failed")
    rcon.print("ingredient=" .. ingredient)
    rcon.print("removed=" .. actual)
    rcon.print("needed=" .. needed)
    return
  end
end
local inserted = inv.insert{name = item, count = produced}
if inserted ~= produced then
  if inserted > 0 then inv.remove{name = item, count = inserted} end
  for rollback_item, rollback_count in pairs(removed) do
    if rollback_count > 0 then inv.insert{name = rollback_item, count = rollback_count} end
  end
  rcon.print("ok=false")
  rcon.print("error=craft_insert_failed")
  rcon.print("inserted=" .. inserted)
  return
end
rcon.print("ok=true")
rcon.print("crafted=" .. produced)
print_worker(worker)
print_inventory(inv)
`;
    const output = await this.runTemplateLua("worker_craft.lua", body);
    const parsed = parseKeyValueOutput(output);
    const result = await this.persistWorkerOutput(output, parsed.ok ? {
      id: actionId(),
      type: "craft",
      item,
      count: produced,
      at: new Date().toISOString(),
    } : null);
    if (!parsed.ok) throw new Error(`craft failed: ${parsed.error || output}`);
    return { item, crafted: parsed.crafted, worker: result.worker, inventory: result.inventory, output };
  }

  async placeFromInventory(input) {
    const item = String(input.item || "");
    const entityName = PLACEABLE_ITEMS.get(item);
    if (!entityName) throw new Error(`unsupported placeable item: ${item}`);
    const position = requirePosition(input.position, "position");
    const direction = String(input.direction || "north");
    await this.ensureWorkerCharacter();
    const body = `
${workerLuaPrelude()}
local surface = game.surfaces[1]
local force = game.forces["player"]
local name = ${luaValue(entityName)}
local item = ${luaValue(item)}
local position = {${position.x}, ${position.y}}
local direction_name = ${luaValue(direction)}
local direction = defines.direction[direction_name] or defines.direction.north
local worker = find_worker()
if not worker then rcon.print("ok=false"); rcon.print("error=worker_not_found"); return end
local inv = worker_inventory(worker)
if not inv then return end
local before = inv.get_item_count(item)
if before < 1 then
  rcon.print("ok=false")
  rcon.print("error=worker_item_missing")
  rcon.print("available=" .. before)
  return
end
local can_place = surface.can_place_entity{name = name, position = position, direction = direction, force = force}
if not can_place then
  rcon.print("ok=false")
  rcon.print("error=cannot_place")
  return
end
local removed = inv.remove{name = item, count = 1}
if removed ~= 1 then
  rcon.print("ok=false")
  rcon.print("error=worker_remove_failed")
  rcon.print("removed=" .. removed)
  return
end
local entity = surface.create_entity{name = name, position = position, direction = direction, force = force, raise_built = false}
if not entity then
  inv.insert{name = item, count = removed}
  rcon.print("ok=false")
  rcon.print("error=create_entity_failed")
  return
end
local after = inv.get_item_count(item)
if before - after ~= 1 then
  entity.destroy()
  inv.insert{name = item, count = removed}
  rcon.print("ok=false")
  rcon.print("error=worker_inventory_verification_failed")
  rcon.print("before=" .. before)
  rcon.print("after=" .. after)
  return
end
rcon.print("ok=true")
rcon.print("name=" .. entity.name)
rcon.print("unit_number=" .. tostring(entity.unit_number or ""))
rcon.print("x=" .. entity.position.x)
rcon.print("y=" .. entity.position.y)
print_worker(worker)
print_inventory(inv)
`;
    const output = await this.runTemplateLua("place_from_inventory.lua", body);
    const parsed = parseKeyValueOutput(output);
    const id = actionId();
    const result = await this.persistWorkerOutput(output, parsed.ok ? {
        id,
        type: "place_from_inventory",
        item,
        entity: {
          name: parsed.name || entityName,
          unitNumber: parsed.unit_number || null,
          position: { x: parsed.x, y: parsed.y },
        },
        at: new Date().toISOString(),
    } : null);
    if (!parsed.ok) throw new Error(`place_from_inventory failed: ${parsed.error || output}`);
    return {
      placed: true,
      id,
      item,
      entity: {
        name: parsed.name || entityName,
        unitNumber: parsed.unit_number || null,
        position: { x: parsed.x, y: parsed.y },
      },
      worker: result.worker,
      inventory: result.inventory,
      output,
    };
  }

  async mineEntityToInventory(input) {
    const entity = parseToolJson(input.entity, "entity");
    const entityRef = parseToolJson(input.entityRef, "entityRef");
    const ref = this.entityRef(entity || entityRef || input);
    const item = ENTITY_TO_ITEM.get(ref.name);
    if (!item) throw new Error(`unsupported mineable entity: ${ref.name}`);
    await this.ensureWorkerCharacter();
    const body = `
${workerLuaPrelude()}
local surface = game.surfaces[1]
local name = ${luaValue(ref.name)}
local item = ${luaValue(item)}
local x = ${ref.x}
local y = ${ref.y}
local worker = find_worker()
if not worker then rcon.print("ok=false"); rcon.print("error=worker_not_found"); return end
local inv = worker_inventory(worker)
if not inv then return end
local entities = surface.find_entities_filtered{area = {{x - 0.4, y - 0.4}, {x + 0.4, y + 0.4}}, name = name}
if #entities == 0 then
  rcon.print("ok=false")
  rcon.print("error=entity_not_found")
  return
end
local entity = entities[1]
if entity.type == "resource" then
  rcon.print("ok=false")
  rcon.print("error=cannot_mine_resource_with_entity_action")
  return
end
if inv.get_insertable_count(item) < 1 then
  rcon.print("ok=false")
  rcon.print("error=worker_inventory_full")
  return
end
local before = inv.get_item_count(item)
local inserted = inv.insert{name = item, count = 1}
if inserted ~= 1 then
  if inserted > 0 then inv.remove{name = item, count = inserted} end
  rcon.print("ok=false")
  rcon.print("error=worker_insert_failed")
  rcon.print("inserted=" .. inserted)
  return
end
entity.destroy()
local remaining = surface.find_entities_filtered{area = {{x - 0.4, y - 0.4}, {x + 0.4, y + 0.4}}, name = name}
if #remaining > 0 then
  inv.remove{name = item, count = 1}
  rcon.print("ok=false")
  rcon.print("error=entity_destroy_failed")
  return
end
local after = inv.get_item_count(item)
if after - before ~= 1 then
  rcon.print("ok=false")
  rcon.print("error=worker_inventory_verification_failed")
  rcon.print("before=" .. before)
  rcon.print("after=" .. after)
  return
end
rcon.print("ok=true")
rcon.print("name=" .. name)
print_worker(worker)
print_inventory(inv)
`;
    const output = await this.runTemplateLua("mine_entity_to_inventory.lua", body);
    const parsed = parseKeyValueOutput(output);
    const result = await this.persistWorkerOutput(output, parsed.ok ? {
      id: actionId(),
      type: "mine_entity_to_inventory",
      entity: ref,
      item,
      at: new Date().toISOString(),
    } : null);
    if (!parsed.ok) throw new Error(`mine_entity_to_inventory failed: ${parsed.error || output}`);
    return { mined: true, item, entity: ref, worker: result.worker, inventory: result.inventory, output };
  }

  inventoryKind(kind) {
    const allowed = new Set(["chest", "fuel", "furnace_source", "furnace_result", "crafter_input", "crafter_output", "burnt_result"]);
    const value = String(kind || "chest");
    if (!allowed.has(value)) throw new Error(`unsupported inventory kind: ${value}`);
    return value;
  }

  isWorkerTransferEndpoint(endpoint, label) {
    const value = parseToolJson(endpoint, label);
    const type = value?.type ? String(value.type) : "";
    if (type === "worker") return true;
    if (type === "entity") return false;
    if (type) throw new Error(`unsupported ${label}.type: ${type}`);
    if (value?.entity || value?.name || value?.position || value?.x !== undefined || value?.y !== undefined) {
      return false;
    }
    return true;
  }

  async transferInventory(input) {
    const item = String(input.item || "");
    if (!item) throw new Error("item is required");
    const requested = clampCount(input.count, 1, 1000);
    const from = parseToolJson(input.from || {}, "from");
    const to = parseToolJson(input.to || {}, "to");
    const fromWorker = this.isWorkerTransferEndpoint(from, "from");
    const toWorker = this.isWorkerTransferEndpoint(to, "to");
    if (fromWorker === toWorker) throw new Error("transfer_inventory currently supports worker -> entity or entity -> worker");

    await this.ensureWorkerCharacter();
    const ref = fromWorker
      ? this.entityRef(to.entity || to, "to.entity")
      : this.entityRef(from.entity || from, "from.entity");
    const inventory = this.inventoryKind((fromWorker ? to.inventory : from.inventory) || input.inventory);
    const body = `
${workerLuaPrelude()}
local item = ${luaValue(item)}
local requested = ${requested}
local ref = ${luaValue(ref)}
local inventory_kind = ${luaValue(inventory)}
local from_worker = ${fromWorker ? "true" : "false"}
local worker = find_worker()
if not worker then rcon.print("ok=false"); rcon.print("error=worker_not_found"); return end
local worker_inv = worker_inventory(worker)
if not worker_inv then return end
local entity = find_ref_entity(ref)
if not entity then rcon.print("ok=false"); rcon.print("error=entity_not_found"); return end
local entity_inv = entity_inventory(entity, inventory_kind)
if not entity_inv or not entity_inv.valid then rcon.print("ok=false"); rcon.print("error=inventory_not_found"); return end
local source_inv = from_worker and worker_inv or entity_inv
local dest_inv = from_worker and entity_inv or worker_inv
local source_before = source_inv.get_item_count(item)
local dest_before = dest_inv.get_item_count(item)
if source_before < requested then
  rcon.print("ok=false")
  rcon.print("error=source_item_missing")
  rcon.print("available=" .. source_before)
  rcon.print("requested=" .. requested)
  return
end
if dest_inv.get_insertable_count(item) < requested then
  rcon.print("ok=false")
  rcon.print("error=destination_inventory_full")
  return
end
local removed = source_inv.remove{name = item, count = requested}
if removed ~= requested then
  if removed > 0 then source_inv.insert{name = item, count = removed} end
  rcon.print("ok=false")
  rcon.print("error=source_remove_failed")
  rcon.print("removed=" .. removed)
  return
end
local inserted = dest_inv.insert{name = item, count = requested}
if inserted ~= requested then
  if inserted > 0 then dest_inv.remove{name = item, count = inserted} end
  source_inv.insert{name = item, count = removed}
  rcon.print("ok=false")
  rcon.print("error=destination_insert_failed")
  rcon.print("inserted=" .. inserted)
  return
end
local source_after = source_inv.get_item_count(item)
local dest_after = dest_inv.get_item_count(item)
if source_before - source_after ~= requested or dest_after - dest_before ~= requested then
  dest_inv.remove{name = item, count = inserted}
  source_inv.insert{name = item, count = removed}
  rcon.print("ok=false")
  rcon.print("error=transfer_verification_failed")
  rcon.print("source_before=" .. source_before)
  rcon.print("source_after=" .. source_after)
  rcon.print("dest_before=" .. dest_before)
  rcon.print("dest_after=" .. dest_after)
  return
end
rcon.print("ok=true")
rcon.print("moved=" .. requested)
print_worker(worker)
print_inventory(worker_inv)
`;
    const output = await this.runTemplateLua("transfer_inventory.lua", body);
    const parsed = parseKeyValueOutput(output);
    const result = await this.persistWorkerOutput(output, parsed.ok ? {
      id: actionId(),
      type: "transfer_inventory",
      item,
      count: parsed.moved,
      from: fromWorker ? "worker" : ref,
      to: toWorker ? "worker" : ref,
      inventory,
      at: new Date().toISOString(),
    } : null);
    if (!parsed.ok) throw new Error(`transfer_inventory failed: ${parsed.error || output}`);
    return { moved: parsed.moved, item, worker: result.worker, inventory: result.inventory, output };
  }

  async waitTicks(input) {
    const ticks = clampCount(input.ticks, 60, 216000);
    const beforeTick = await this.readTick();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.ceil((ticks / 60) * 1000)));
    const afterTick = await this.readTick();
    return { beforeTick, afterTick, elapsedTicks: afterTick - beforeTick };
  }

  async proposeCapability(input) {
    const id = actionId();
    await ensureDir(this.proposalDir());
    const proposal = {
      id,
      name: String(input.name || "unnamed-capability"),
      useCase: String(input.useCase || input.use_case || ""),
      missingReason: String(input.missingReason || input.missing_reason || ""),
      desiredSchema: input.desiredSchema || input.desired_schema || null,
      validationPlan: String(input.validationPlan || input.validation_plan || ""),
      createdAt: new Date().toISOString(),
    };
    const path = join(this.proposalDir(), `${id}-${proposal.name.replace(/[^A-Za-z0-9_.-]/g, "-")}.json`);
    await writeFile(path, `${JSON.stringify(proposal, null, 2)}\n`);
    return { proposed: true, path, proposal };
  }

  async logs(lines = 120) {
    if (!(await exists(this.currentLogPath))) return "";
    const text = await readFile(this.currentLogPath, "utf8");
    return text.split(/\r?\n/).slice(-Math.max(1, lines)).join("\n");
  }

  async connectedPlayers() {
    const body = `
local players = game.connected_players
rcon.print("connected_count=" .. tostring(#players))
for index, player in ipairs(players) do
  rcon.print("player." .. index .. ".name=" .. tostring(player.name or ""))
  rcon.print("player." .. index .. ".index=" .. tostring(player.index or ""))
end
`;
    const output = await this.runTemplateLua("connected_players.lua", body, 10000);
    const parsed = parseKeyValueOutput(output);
    const count = Number(parsed.connected_count || 0);
    const players = [];
    for (let index = 1; index <= count; index += 1) {
      players.push({
        name: String(parsed[`player.${index}.name`] || ""),
        index: parsed[`player.${index}.index`] ?? null,
      });
    }
    return { count, players, output };
  }

  async mutationBlocker(action) {
    if (!MUTATING_ACTIONS.has(action) || this.config.allowMutationWithConnectedPlayers) return null;
    const connected = await this.connectedPlayers();
    if (connected.count === 0) return null;
    return {
      blocked: true,
      blocker: "connected_players_present",
      action,
      connectedPlayers: connected.players,
      message: "World-changing factorio_action calls are blocked while real players are connected. Set FACTORIO_AGENT_ALLOW_MUTATION_WITH_CONNECTED_PLAYERS=true to override.",
    };
  }

  async status() {
    let tick = null;
    let rconReady = false;
    let rconError = null;
    let connectedPlayers = [];
    let connectedPlayerError = null;
    try {
      tick = await this.readTick();
      rconReady = true;
    } catch (error) {
      rconError = error.message;
    }
    if (rconReady) {
      try {
        connectedPlayers = (await this.connectedPlayers()).players;
      } catch (error) {
        connectedPlayerError = error.message;
      }
    } else {
      connectedPlayerError = rconError;
    }
    const latest = await latestZip(this.config.savesDir);
    return {
      running: this.isRunning(),
      pid: this.process?.pid || null,
      rconReady,
      rconError,
      connectedPlayers,
      connectedPlayerCount: connectedPlayers.length,
      connectedPlayerError,
      allowMutationWithConnectedPlayers: this.config.allowMutationWithConnectedPlayers,
      materialPolicy: this.config.materialPolicy || "strict",
      gameTick: tick,
      rconPort: this.config.rconPort,
      gamePort: this.config.gamePort,
      save: latest ? { path: latest.path, name: basename(latest.path), size: latest.size, mtimeMs: latest.mtimeMs } : null,
      logPath: this.currentLogPath,
    };
  }

  async handleRead(input) {
    const action = input?.action || "status";
    if (!["status", "logs", "craft_catalog"].includes(action)) {
      await this.start();
    }
    switch (action) {
      case "status":
        return this.status();
      case "logs":
        return { logs: await this.logs(input.lines || 120) };
      case "craft_catalog":
        return this.craftCatalog();
      case "query_script":
        if (!input.script) throw new Error("script is required for query_script");
        return this.runReadScript(input.script, input.params || {});
      case "inspect_area":
        return this.inspectArea(input);
      case "inspect_position":
        return this.inspectPosition(input);
      case "inspect_inventory":
        return this.inspectInventory(input);
      case "early_game_catalog":
        return this.earlyGameCatalog(input);
      case "production_stats":
        return this.productionStats(input);
      case "measure_production_window":
        return this.measureProductionWindow(input);
      case "validate_placement":
        return this.validatePlacement(input.entities || []);
      default:
        throw new Error(`unknown factorio_read action: ${action}`);
    }
  }

  async handleAction(input) {
    const action = input?.action;
    if (action !== "propose_capability") {
      await this.start();
    }
    const blocker = await this.mutationBlocker(action);
    if (blocker) return blocker;
    switch (action) {
      case "move_to":
        return this.moveTo(input);
      case "mine_resource":
        return this.mineResource(input);
      case "craft":
        return this.craft(input);
      case "place_from_inventory":
        return this.placeFromInventory(input);
      case "mine_entity_to_inventory":
        return this.mineEntityToInventory(input);
      case "transfer_inventory":
        return this.transferInventory(input);
      case "execute_blueprint":
        return this.executeBlueprint(input);
      case "compose_capability":
        return this.composeCapability(input);
      case "compose_chain":
        return this.composeChain(input);
      case "connect_belt":
        return this.connectBelt(input);
      case "connect_power":
        return this.connectPower(input);
      case "route_belt":
        return this.routeBelt(input);
      case "wait_ticks":
        return this.waitTicks(input);
      case "save":
        return { save: await this.save() };
      case "propose_capability":
        return this.proposeCapability(input);
      default:
        throw new Error(`unknown factorio_action action: ${action}`);
    }
  }

  async handleTool(input) {
    const action = input?.action;
    if (action !== "status") {
      await this.start();
    }
    switch (action) {
      case "status":
        return this.status();
      case "rcon":
        if (!input.command) throw new Error("command is required for rcon");
        return { output: await this.rcon(input.command, input.timeoutMs || 15000) || "(empty response)" };
      case "run_lua":
        return this.runLua(this.config.agentWorkspace, input.script, input.params || {});
      case "save":
        return { save: await this.save() };
      case "logs":
        return { logs: await this.logs(input.lines || 120) };
      default:
        throw new Error(`unknown factorio_server action: ${action}`);
    }
  }

  async stop() {
    if (!this.process) return;
    if (this.isRunning()) {
      await this.save().catch(() => {});
      this.process.kill("SIGTERM");
      const exit = once(this.process, "exit");
      const timeout = new Promise((resolvePromise) => setTimeout(resolvePromise, 10000, "timeout"));
      if ((await Promise.race([exit, timeout])) === "timeout" && this.isRunning()) {
        this.process.kill("SIGKILL");
      }
    }
    this.logStream?.end();
    this.process = null;
    this.logStream = null;
  }
}
