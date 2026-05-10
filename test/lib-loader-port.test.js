import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAllModules, validateBlueprint } from "../src/lib-loader.js";

async function makeLib(yaml, blueprintJson) {
  const root = await mkdtemp(join(tmpdir(), "ff-lib-"));
  const lib = join(root, "lib");
  await mkdir(join(lib, "modules"), { recursive: true });
  await mkdir(join(lib, "blueprints"), { recursive: true });
  await writeFile(join(lib, "modules", "m.yaml"), yaml);
  if (blueprintJson) {
    await writeFile(join(lib, "blueprints", "m.json"), blueprintJson);
  }
  return { root, lib };
}

const VALID_BELT_YAML = `
id: m
version: 1
inputs: []
outputs:
  - { name: out, side: south, rel_pos: [0.5, 2.5], throughput: 0.18, item: coal, kind: belt }
footprint:
  min: [0, 0]
  max: [1, 1]
realization:
  blueprint: lib/blueprints/m.json
meters:
  - id: m-meter
    port: out
    metric: coal_per_s
    aggregate: rate_from_cumulative
`;

const VALID_BELT_BLUEPRINT = JSON.stringify({
  entities: [{ key: "belt_a", item: "transport-belt", dx: 0, dy: 0 }],
  ports: { out: { entity: "belt_a", kind: "belt", item: "coal" } },
});

test("meters[].port form passes validation when port name + kind match", async () => {
  const { lib, root } = await makeLib(VALID_BELT_YAML, VALID_BELT_BLUEPRINT);
  try {
    const modules = await loadAllModules(lib);
    const m = modules.get("m");
    assert.equal(m.meters[0].port, "out");
    assert.equal(m.meters[0].script, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("meters[] rejects entry with both script and port", async () => {
  const yaml = VALID_BELT_YAML + `    script: lib/meters/x.lua\n`;
  const { lib, root } = await makeLib(yaml, VALID_BELT_BLUEPRINT);
  try {
    await assert.rejects(
      () => loadAllModules(lib),
      /must declare either 'script' or 'port', not both/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("meters[] rejects entry with neither script nor port", async () => {
  const yaml = VALID_BELT_YAML.replace(/^    port: out$/m, "");
  const { lib, root } = await makeLib(yaml, VALID_BELT_BLUEPRINT);
  try {
    await assert.rejects(
      () => loadAllModules(lib),
      /must declare one of 'script' or 'port'/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("meters[].port rejects unknown port name", async () => {
  const yaml = VALID_BELT_YAML.replace("port: out", "port: nope");
  const { lib, root } = await makeLib(yaml, VALID_BELT_BLUEPRINT);
  try {
    await assert.rejects(
      () => loadAllModules(lib),
      /port 'nope' does not match any inputs/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("meters[].port rejects port whose kind isn't metered (inventory)", async () => {
  const yaml = VALID_BELT_YAML.replace("kind: belt", "kind: inventory");
  const blueprint = JSON.stringify({
    entities: [{ key: "chest_a", item: "iron-chest", dx: 0, dy: 0 }],
    ports: { out: { entity: "chest_a", kind: "inventory", item: "coal" } },
  });
  const { lib, root } = await makeLib(yaml, blueprint);
  try {
    await assert.rejects(
      () => loadAllModules(lib),
      /port-meter only supports/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateBlueprint rejects unknown port kind", () => {
  assert.throws(() => validateBlueprint({
    entities: [{ key: "p", item: "small-electric-pole" }],
    ports: { out: { entity: "p", kind: "electric", item: "electricity" } },
  }, "/x.json"), /kind 'electric' invalid/);
});

test("validateBlueprint rejects entity not allowed for kind", () => {
  assert.throws(() => validateBlueprint({
    entities: [{ key: "b", item: "transport-belt" }],
    ports: { out: { entity: "b", kind: "power", item: "electricity" } },
  }, "/x.json"), /entity 'transport-belt' not allowed for kind 'power'/);
});

test("validateBlueprint rejects port whose entity-key is missing", () => {
  assert.throws(() => validateBlueprint({
    entities: [{ key: "a", item: "transport-belt" }],
    ports: { out: { entity: "ghost", kind: "belt", item: "coal" } },
  }, "/x.json"), /'ghost' not found in blueprint.entities/);
});

test("validateBlueprint accepts every existing connector tier", () => {
  const blueprint = {
    entities: [
      { key: "b1", item: "transport-belt" },
      { key: "b2", item: "fast-transport-belt" },
      { key: "b3", item: "express-transport-belt" },
      { key: "p1", item: "pipe" },
      { key: "e1", item: "small-electric-pole" },
      { key: "e2", item: "substation" },
      { key: "c1", item: "wooden-chest" },
      { key: "c2", item: "iron-chest" },
    ],
    ports: {
      pb: { entity: "b1", kind: "belt", item: "coal" },
      pf: { entity: "b2", kind: "belt", item: "coal" },
      pe: { entity: "b3", kind: "belt", item: "coal" },
      pp: { entity: "p1", kind: "pipe", item: "water" },
      pe1: { entity: "e1", kind: "power", item: "electricity" },
      pe2: { entity: "e2", kind: "power", item: "electricity" },
      pc1: { entity: "c1", kind: "inventory", item: "coal" },
      pc2: { entity: "c2", kind: "inventory", item: "coal" },
    },
  };
  validateBlueprint(blueprint, "/x.json"); // should not throw
});

test("loadAllModules rejects blueprint with kind: electric (real e4 regression)", async () => {
  const blueprint = JSON.stringify({
    entities: [{ key: "p", item: "small-electric-pole", dx: 0, dy: 0 }],
    ports: { out: { entity: "p", kind: "electric", item: "electricity" } },
  });
  const yaml = `
id: m
version: 1
inputs: []
outputs:
  - { name: out, side: south, rel_pos: [0, 0], throughput: 1, item: electricity, kind: power }
footprint:
  min: [0, 0]
  max: [1, 1]
realization:
  blueprint: lib/blueprints/m.json
`;
  const { lib, root } = await makeLib(yaml, blueprint);
  try {
    await assert.rejects(() => loadAllModules(lib), /kind 'electric' invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
