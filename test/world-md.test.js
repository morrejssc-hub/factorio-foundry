import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  locateFence, rewriteFence, appendEntry, removeEntries,
  readWorldMd, appendDeployedModule, removeDeployedModules,
} from "../src/runner/world-md.js";

async function freshTmpDir() {
  return mkdtemp(join(tmpdir(), "world-md-test-"));
}

test("readWorldMd creates file from template on first access", async () => {
  const dir = await freshTmpDir();
  const path = join(dir, "world.md");
  const { entries } = await readWorldMd(path);
  assert.deepEqual(entries, []);
  const text = await readFile(path, "utf8");
  assert.match(text, /## Deployed modules/);
  assert.match(text, /```yaml\n\[\]\n```/);
});

test("appendEntry adds a deployed module to the fence", async () => {
  const dir = await freshTmpDir();
  const path = join(dir, "world.md");
  const { rawText } = await readWorldMd(path);
  const updated = appendEntry(rawText, {
    id: "p0", module: "iron-smelt-line",
    anchor: { x: -78, y: -66 }, direction: "north", epoch: "e2",
  });
  const reloc = locateFence(updated);
  assert.equal(reloc.entries.length, 1);
  assert.equal(reloc.entries[0].id, "p0");
  assert.equal(reloc.entries[0].module, "iron-smelt-line");
  assert.deepEqual(reloc.entries[0].anchor, { x: -78, y: -66 });
});

test("appendEntry rejects duplicate ids", async () => {
  const dir = await freshTmpDir();
  const path = join(dir, "world.md");
  const { rawText } = await readWorldMd(path);
  const once = appendEntry(rawText, { id: "p0", module: "x", anchor: { x: 0, y: 0 }, direction: "north", epoch: "e1" });
  assert.throws(
    () => appendEntry(once, { id: "p0", module: "y", anchor: { x: 1, y: 1 }, direction: "north", epoch: "e2" }),
    /already present/,
  );
});

test("removeEntries drops listed ids and reports missing", async () => {
  const dir = await freshTmpDir();
  const path = join(dir, "world.md");
  let { rawText } = await readWorldMd(path);
  rawText = appendEntry(rawText, { id: "p0", module: "x", anchor: { x: 0, y: 0 }, direction: "north", epoch: "e1" });
  rawText = appendEntry(rawText, { id: "p1", module: "y", anchor: { x: 1, y: 1 }, direction: "north", epoch: "e1" });
  const { text, removed, missing } = removeEntries(rawText, ["p0", "p_unknown"]);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].id, "p0");
  assert.deepEqual(missing, ["p_unknown"]);
  const after = locateFence(text);
  assert.equal(after.entries.length, 1);
  assert.equal(after.entries[0].id, "p1");
});

test("rewriteFence preserves prose around the fence", async () => {
  const text = `# X

## Deployed modules

\`\`\`yaml
- id: p0
  module: foo
\`\`\`

## Notes

Free-form prose that should survive a rewrite.
- a bullet
- another bullet
`;
  const updated = rewriteFence(text, [{ id: "p9", module: "bar" }]);
  assert.match(updated, /Free-form prose that should survive a rewrite/);
  assert.match(updated, /- a bullet/);
  const reloc = locateFence(updated);
  assert.equal(reloc.entries.length, 1);
  assert.equal(reloc.entries[0].id, "p9");
});

test("locateFence throws on missing header", () => {
  assert.throws(() => locateFence("# nothing here"), /missing "## Deployed modules"/);
});

test("locateFence throws on missing close fence", () => {
  const broken = `## Deployed modules\n\n\`\`\`yaml\n- id: p0\nno close\n`;
  assert.throws(() => locateFence(broken), /no closing/);
});

test("appendDeployedModule + removeDeployedModules round-trip via filesystem", async () => {
  const dir = await freshTmpDir();
  const path = join(dir, "world.md");
  await appendDeployedModule(path, { id: "p0", module: "iron-smelt-line", anchor: { x: -78, y: -66 }, direction: "north", epoch: "e2" });
  await appendDeployedModule(path, { id: "p1", module: "copper-smelt-line", anchor: { x: -58, y: -23 }, direction: "north", epoch: "e3" });
  const after1 = await readWorldMd(path);
  assert.equal(after1.entries.length, 2);
  const { removed, missing } = await removeDeployedModules(path, ["p0"]);
  assert.equal(removed.length, 1);
  assert.equal(missing.length, 0);
  const after2 = await readWorldMd(path);
  assert.equal(after2.entries.length, 1);
  assert.equal(after2.entries[0].id, "p1");
});
