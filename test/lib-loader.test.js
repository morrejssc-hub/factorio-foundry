import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAllModules, footprintOverlaps, findPort } from "../src/lib-loader.js";

async function makeLibDir() {
  const root = await mkdtemp(join(tmpdir(), "foundry-lib-test-"));
  await mkdir(join(root, "modules"), { recursive: true });
  return root;
}

test("loadAllModules parses and validates a minimal module", async () => {
  const lib = await makeLibDir();
  await writeFile(join(lib, "modules", "m.yaml"), `
id: m
version: 1
inputs: []
outputs:
  - { name: out, rel_pos: [1, 0], throughput: 1.0, item: coal, kind: belt }
footprint: { min: [-1, -1], max: [2, 1] }
realization: { blueprint: lib/blueprints/foo.json }
`);
  const mods = await loadAllModules(lib);
  assert.equal(mods.size, 1);
  const m = mods.get("m");
  assert.equal(m.outputs[0].name, "out");
  await rm(lib, { recursive: true, force: true });
});

test("loadAllModules rejects modules with missing required fields", async () => {
  const lib = await makeLibDir();
  await writeFile(join(lib, "modules", "bad.yaml"), `
id: bad
version: 1
inputs: []
outputs: []
# footprint and realization missing
`);
  await assert.rejects(() => loadAllModules(lib), /missing top-level field: footprint/);
  await rm(lib, { recursive: true, force: true });
});

test("loadAllModules rejects invalid output port shape", async () => {
  const lib = await makeLibDir();
  await writeFile(join(lib, "modules", "bad.yaml"), `
id: bad
version: 1
inputs: []
outputs:
  - { name: out, rel_pos: [1], throughput: "fast", item: coal, kind: laser }
footprint: { min: [0,0], max: [1,1] }
realization: { blueprint: x }
`);
  await assert.rejects(() => loadAllModules(lib), /rel_pos|throughput|kind/);
  await rm(lib, { recursive: true, force: true });
});

test("loadAllModules rejects duplicate ids", async () => {
  const lib = await makeLibDir();
  const mod = `
id: dup
version: 1
inputs: []
outputs: []
footprint: { min: [0,0], max: [1,1] }
realization: { blueprint: x }
`;
  await writeFile(join(lib, "modules", "a.yaml"), mod);
  await writeFile(join(lib, "modules", "b.yaml"), mod);
  await assert.rejects(() => loadAllModules(lib), /duplicate module id dup/);
  await rm(lib, { recursive: true, force: true });
});

test("footprintOverlaps detects axis-aligned overlap and clearance", () => {
  const a = { anchor: { x: 0, y: 0 }, footprint: { min: [-1, -1], max: [2, 1] } };
  const b = { anchor: { x: 1, y: 0 }, footprint: { min: [-1, -1], max: [2, 1] } };
  assert.ok(footprintOverlaps(a, b));
  const c = { anchor: { x: 10, y: 0 }, footprint: { min: [-1, -1], max: [2, 1] } };
  assert.ok(!footprintOverlaps(a, c));
});

test("findPort searches inputs and outputs", () => {
  const m = {
    inputs: [{ name: "in1", kind: "belt" }],
    outputs: [{ name: "out1", kind: "belt" }],
  };
  assert.equal(findPort(m, "in1").kind, "belt");
  assert.equal(findPort(m, "out1").kind, "belt");
  assert.equal(findPort(m, "missing"), undefined);
});

test("ships coal-burner-cell module loads with expected ports", async () => {
  // Verify the actual MVP module in lib/ parses correctly.
  const mods = await loadAllModules(new URL("../lib", import.meta.url).pathname);
  const c = mods.get("coal-burner-cell");
  assert.ok(c, "coal-burner-cell module should exist");
  const belt = findPort(c, "coal_belt");
  assert.equal(belt.kind, "belt");
  assert.equal(belt.item, "coal");
  assert.ok(belt.throughput > 0);
});
