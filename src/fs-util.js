import { mkdir, rename, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

export async function ensureParent(path) {
  await ensureDir(dirname(path));
}

export async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function atomicRename(from, to) {
  await ensureParent(to);
  await rename(from, to);
}

export function inside(base, candidate) {
  const normalizedBase = resolve(base);
  const normalized = resolve(base, candidate);
  return normalized === normalizedBase || normalized.startsWith(`${normalizedBase}/`);
}
