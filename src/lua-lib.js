import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { exists } from "./fs-util.js";

const cache = new Map();

export async function getLuaLibPreamble(workspaceDir) {
  if (cache.has(workspaceDir)) return cache.get(workspaceDir);
  const dir = join(workspaceDir, "lib", "lua-lib");
  if (!(await exists(dir))) {
    cache.set(workspaceDir, "");
    return "";
  }
  const entries = (await readdir(dir)).filter((name) => name.endsWith(".lua")).sort();
  const parts = [];
  for (const name of entries) {
    const content = await readFile(join(dir, name), "utf8");
    parts.push(`-- [lua-lib] ${name}\n${content}`);
  }
  const preamble = parts.length ? parts.join("\n") + "\n" : "";
  cache.set(workspaceDir, preamble);
  return preamble;
}

export function clearLuaLibCache() {
  cache.clear();
}
