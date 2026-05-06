import net from "node:net";
import { basename, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { inside } from "./fs-util.js";

const SERVERDATA_AUTH = 3;
const SERVERDATA_AUTH_RESPONSE = 2;
const SERVERDATA_EXECCOMMAND = 2;
const SERVERDATA_RESPONSE_VALUE = 0;

const QUERY_TYPE_SCRIPTS = new Set([
  "query_game_state.lua",
  "query_logistics.lua",
  "query_production.lua",
]);

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function pack(id, type, body) {
  const encoded = Buffer.from(body, "utf8");
  const out = Buffer.alloc(4 + 4 + 4 + encoded.length + 2);
  out.writeInt32LE(4 + 4 + encoded.length + 2, 0);
  out.writeInt32LE(id, 4);
  out.writeInt32LE(type, 8);
  encoded.copy(out, 12);
  out.writeUInt8(0, 12 + encoded.length);
  out.writeUInt8(0, 13 + encoded.length);
  return out;
}

function unpack(payload) {
  const id = payload.readInt32LE(0);
  const type = payload.readInt32LE(4);
  const body = payload.length > 10 ? payload.subarray(8, -2).toString("utf8") : "";
  return { id, type, body };
}

class SocketReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.closed = false;
    this.error = null;

    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flush();
    });
    socket.once("error", (error) => {
      this.error = error;
      this.flush();
    });
    socket.once("close", () => {
      this.closed = true;
      this.flush();
    });
  }

  read(n) {
    if (this.buffer.length >= n) {
      const out = this.buffer.subarray(0, n);
      this.buffer = this.buffer.subarray(n);
      return Promise.resolve(out);
    }
    if (this.error) return Promise.reject(this.error);
    if (this.closed) return Promise.reject(new Error(`RCON connection closed after ${this.buffer.length}/${n} bytes`));
    return new Promise((resolvePromise, reject) => {
      this.waiters.push({ n, resolve: resolvePromise, reject });
    });
  }

  flush() {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0];
      if (this.buffer.length >= waiter.n) {
        this.waiters.shift();
        const out = this.buffer.subarray(0, waiter.n);
        this.buffer = this.buffer.subarray(waiter.n);
        waiter.resolve(out);
        continue;
      }
      if (this.error) {
        this.waiters.shift();
        waiter.reject(this.error);
        continue;
      }
      if (this.closed) {
        this.waiters.shift();
        waiter.reject(new Error(`RCON connection closed after ${this.buffer.length}/${waiter.n} bytes`));
        continue;
      }
      break;
    }
  }
}

async function readPacket(reader) {
  const sizeBuf = await reader.read(4);
  const size = sizeBuf.readInt32LE(0);
  const payload = await reader.read(size);
  return unpack(payload);
}

function connect(host, port, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => resolvePromise(socket));
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`RCON connect timed out after ${timeoutMs}ms`));
    });
    socket.once("error", reject);
  });
}

export async function rconExec({ host, port, password, command, timeoutMs = 15000 }) {
  const socket = await connect(host, port, timeoutMs);
  const reader = new SocketReader(socket);
  socket.setTimeout(timeoutMs);
  try {
    socket.write(pack(1, SERVERDATA_AUTH, password));
    let auth = await readPacket(reader);
    if (auth.type === SERVERDATA_RESPONSE_VALUE) {
      auth = await readPacket(reader);
    }
    if (auth.type !== SERVERDATA_AUTH_RESPONSE || auth.id === -1) {
      throw new Error("RCON authentication failed");
    }

    socket.write(pack(2, SERVERDATA_EXECCOMMAND, command));
    const response = await readPacket(reader);
    return response.body;
  } finally {
    socket.end();
  }
}

function luaString(value) {
  return JSON.stringify(String(value));
}

function luaLiteral(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value === null || value === undefined) return "nil";
  if (Array.isArray(value)) {
    return `{ ${value.map((item) => luaLiteral(item)).join(", ")} }`;
  }
  if (typeof value === "object") {
    return `{ ${Object.entries(value).map(([key, item]) => {
      const encodedKey = IDENT_RE.test(key) ? key : `[${luaString(key)}]`;
      return `${encodedKey} = ${luaLiteral(item)}`;
    }).join(", ")} }`;
  }
  return luaString(value);
}

function paramsLiteral(params = {}) {
  const entries = Object.entries(params);
  for (const [key] of entries) {
    if (!IDENT_RE.test(key)) {
      throw new Error(`invalid Lua identifier for param key: ${key}`);
    }
  }
  return `{ ${entries.map(([key, value]) => `${key} = ${luaLiteral(value)}`).join(", ")} }`;
}

export function buildLuaCommand(scriptName, lua, params = {}) {
  const paramsLua = paramsLiteral(params);
  const base = basename(scriptName);
  const call = QUERY_TYPE_SCRIPTS.has(base)
    ? `__result.query(${luaString(params.query || params.query_type || "summary")}, __params)`
    : "__result.query(__params)";

  const wrapper = `
local __chunk = assert(load(${luaString(lua)}))
local __result = __chunk()
local __params = ${paramsLua}
if type(__result) == "table" and type(__result.query) == "function" then
  local __value = ${call}
  if __value ~= nil and type(__value) ~= "table" then
    rcon.print(tostring(__value))
  end
elseif __result ~= nil then
  rcon.print(tostring(__result))
end
`;

  return `/silent-command assert(load(${luaString(wrapper)}))()`;
}

export async function buildLuaCommandFromWorkspace(workspaceDir, scriptPath, params = {}) {
  if (!scriptPath) throw new Error("script is required for run_lua");
  const relative = scriptPath.startsWith("@") ? scriptPath.slice(1) : scriptPath;
  const normalized = relative.startsWith("scripts/") ? relative : `scripts/${relative}`;
  if (!inside(workspaceDir, normalized)) {
    throw new Error(`script path escapes workspace: ${scriptPath}`);
  }
  const absolute = resolve(workspaceDir, normalized);
  const lua = await readFile(absolute, "utf8");
  return {
    command: buildLuaCommand(basename(absolute), lua, params),
    absolute,
    lua,
    relative: normalized,
  };
}
