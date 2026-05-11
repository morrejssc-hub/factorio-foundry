import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ensureDir, ensureParent, exists, atomicRename, inside } from "../src/fs-util.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "fs-util-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("ensureDir creates directory recursively", async () => {
  await withTempDir(async (tmp) => {
    const target = join(tmp, "a", "b", "c");
    await ensureDir(target);
    const s = await stat(target);
    assert.ok(s.isDirectory());
  });
});

test("ensureParent creates parent directory", async () => {
  await withTempDir(async (tmp) => {
    const parent = join(tmp, "parent");
    const child = join(parent, "child.txt");
    await ensureParent(child);
    const s = await stat(parent);
    assert.ok(s.isDirectory());
  });
});

test("exists returns true if path exists, false otherwise", async () => {
  await withTempDir(async (tmp) => {
    const file = join(tmp, "exists.txt");
    assert.strictEqual(await exists(file), false);
    await writeFile(file, "hello");
    assert.strictEqual(await exists(file), true);
  });
});

test("atomicRename renames file and ensures parent", async () => {
  await withTempDir(async (tmp) => {
    const from = join(tmp, "from.txt");
    const to = join(tmp, "subdir", "to.txt");
    await writeFile(from, "content");
    await atomicRename(from, to);
    assert.strictEqual(await readFile(to, "utf8"), "content");
    assert.strictEqual(await exists(from), false);
  });
});

test("inside checks path inclusion correctly", () => {
  const base = "/home/user";
  assert.ok(inside(base, "/home/user/file.txt"));
  assert.ok(inside(base, "file.txt")); // relative to resolve(base)
  assert.ok(inside(base, "."));
  assert.ok(!inside(base, ".."));
  assert.ok(!inside(base, "/etc/passwd"));

  // Test with trailing slash
  const baseSlash = "/home/user/";
  assert.ok(inside(baseSlash, "/home/user/file.txt"));
  assert.ok(!inside(baseSlash, "/home/other"));
});
