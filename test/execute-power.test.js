import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { routeConnections } from "../src/runner/execute.js";

async function stagedModule(id, ports) {
  const dir = await mkdtemp(join(tmpdir(), "foundry-power-"));
  const blueprintPath = join(dir, `${id}.json`);
  await writeFile(blueprintPath, JSON.stringify({ entities: [] }), "utf8");
  return {
    cleanup: () => rm(dir, { recursive: true, force: true }),
    module: {
      id,
      version: 1,
      inputs: ports.inputs || [],
      outputs: ports.outputs || [],
      footprint: { min: [0, 0], max: [1, 1] },
      realization: { blueprint: `lib/blueprints/${id}.json` },
      _staged: true,
      _stagedBlueprintPath: blueprintPath,
    },
  };
}

test("routeConnections sends explicit power pairs to connect_power", async () => {
  const source = await stagedModule("source", {
    outputs: [{ name: "power_out", side: "east", rel_pos: [0, 0], throughput: 900, item: "electricity", kind: "power" }],
  });
  const sink = await stagedModule("sink", {
    inputs: [{ name: "power_in", side: "west", rel_pos: [10, 0], throughput: 75, item: "electricity", kind: "power" }],
  });
  const calls = [];
  const controller = {
    config: { rootDir: process.cwd() },
    action: async (name, params) => {
      calls.push({ name, params });
      assert.equal(name, "connect_power");
      return { ok: true, pathLength: 2 };
    },
  };
  try {
    const result = await routeConnections({
      controller,
      modules: new Map([["source", source.module], ["sink", sink.module]]),
      plan: {
        placements: [
          { id: "p0", module: "source", anchor: { x: 0, y: 0 }, direction: "north" },
          { id: "p1", module: "sink", anchor: { x: 0, y: 0 }, direction: "north" },
        ],
        connections: [{ from: "p0.power_out", to: "p1.power_in", required_throughput: 75 }],
      },
      log: () => {},
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params.from, { x: 0, y: 0 });
    assert.deepEqual(calls[0].params.to, { x: 10, y: 0 });
    assert.equal(result[0].kind, "power");
  } finally {
    await source.cleanup();
    await sink.cleanup();
  }
});

test("routeConnections auto-connects unbound power inputs to nearest powered pole", async () => {
  const sink = await stagedModule("sink", {
    inputs: [{ name: "power_in", side: "west", rel_pos: [10, 0], throughput: 75, item: "electricity", kind: "power" }],
  });
  const calls = [];
  const controller = {
    config: { rootDir: process.cwd() },
    read: async (name, params) => {
      calls.push({ name: "read", action: name, params });
      assert.equal(name, "query_script");
      return {
        output: JSON.stringify({
          ok: true,
          checks: [{
            id: "p1.power_in",
            powered: false,
            nearestPoweredPole: { position: { x: 1.5, y: 2.5 } },
          }],
        }),
      };
    },
    action: async (name, params) => {
      calls.push({ name, params });
      assert.equal(name, "connect_power");
      return { ok: true, pathLength: 3 };
    },
  };
  try {
    const result = await routeConnections({
      controller,
      modules: new Map([["sink", sink.module]]),
      plan: {
        placements: [
          { id: "p1", module: "sink", anchor: { x: 0, y: 0 }, direction: "north" },
        ],
        connections: [],
      },
      log: () => {},
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].name, "read");
    assert.equal(calls[1].name, "connect_power");
    assert.deepEqual(calls[1].params.from, { x: 1.5, y: 2.5 });
    assert.deepEqual(calls[1].params.to, { x: 10, y: 0 });
    assert.deepEqual(result[0], { from: "auto-power", to: "p1.power_in", kind: "power", ok: true, length: 3 });
  } finally {
    await sink.cleanup();
  }
});
