import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDryValidate } from "../src/runner/dry-validate.js";

function fakeModule(id, opts = {}) {
  return {
    id,
    version: 1,
    inputs: opts.inputs || [],
    outputs: opts.outputs || [],
    footprint: opts.footprint || { min: [-1, -1], max: [1, 1] },
    realization: { blueprint: `lib/blueprints/${id}.json` },
  };
}

async function tmpDir() {
  return mkdtemp(join(tmpdir(), "dry-validate-test-"));
}

test("dry-validate passes a minimal valid plan", async () => {
  const out = await tmpDir();
  const modules = new Map([["m", fakeModule("m", {
    outputs: [{ name: "o", rel_pos: [1, 0], throughput: 1, item: "coal", kind: "belt" }],
  })]]);
  const plan = {
    epoch: "test",
    placements: [{ id: "p0", module: "m", anchor: { x: 0, y: 0 }, direction: "north" }],
    connections: [],
    expected_throughput: 1,
    scaling_note: "single module sufficient",
  };
  const verdict = await runDryValidate({ plan, modules, outDir: out });
  assert.equal(verdict.ok, true, verdict.errors?.join("\n"));
  await rm(out, { recursive: true, force: true });
});

test("dry-validate detects overlapping footprints", async () => {
  const out = await tmpDir();
  const modules = new Map([["m", fakeModule("m")]]);
  const plan = {
    epoch: "test",
    placements: [
      { id: "p0", module: "m", anchor: { x: 0, y: 0 }, direction: "north" },
      { id: "p1", module: "m", anchor: { x: 1, y: 0 }, direction: "north" },
    ],
    connections: [],
    expected_throughput: 0,
    scaling_note: "overlap test",
  };
  const verdict = await runDryValidate({ plan, modules, outDir: out });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => /overlap/.test(e)));
  await rm(out, { recursive: true, force: true });
});

test("dry-validate detects missing required fields", async () => {
  const out = await tmpDir();
  const modules = new Map([["m", fakeModule("m")]]);
  const plan = {
    epoch: "test",
    placements: [{ id: "p0", module: "m", anchor: { x: 0, y: 0 }, direction: "north" }],
    // connections / expected_throughput / scaling_note intentionally missing
  };
  const verdict = await runDryValidate({ plan, modules, outDir: out });
  assert.equal(verdict.ok, false);
  for (const f of ["connections", "expected_throughput", "scaling_note"]) {
    assert.ok(verdict.errors.some((e) => e.includes(f)), `missing error for ${f}`);
  }
  await rm(out, { recursive: true, force: true });
});

test("dry-validate detects unknown module reference", async () => {
  const out = await tmpDir();
  const modules = new Map([["m", fakeModule("m")]]);
  const plan = {
    epoch: "test",
    placements: [{ id: "p0", module: "ghost", anchor: { x: 0, y: 0 }, direction: "north" }],
    connections: [],
    expected_throughput: 0,
    scaling_note: "n/a",
  };
  const verdict = await runDryValidate({ plan, modules, outDir: out });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => /unknown module 'ghost'/.test(e)));
  await rm(out, { recursive: true, force: true });
});

test("dry-validate connections: kind mismatch flagged", async () => {
  const out = await tmpDir();
  const modules = new Map([
    ["src", fakeModule("src", { outputs: [{ name: "o", rel_pos: [1, 0], throughput: 1, item: "coal", kind: "belt" }] })],
    ["dst", fakeModule("dst", { inputs: [{ name: "i", rel_pos: [-1, 0], throughput: 1, item: "coal", kind: "pipe" }] })],
  ]);
  const plan = {
    epoch: "test",
    placements: [
      { id: "a", module: "src", anchor: { x: 0, y: 0 }, direction: "north" },
      { id: "b", module: "dst", anchor: { x: 5, y: 0 }, direction: "north" },
    ],
    connections: [{ from: { placement: "a", port: "o" }, to: { placement: "b", port: "i" }, required_throughput: 1 }],
    expected_throughput: 1,
    scaling_note: "n/a",
  };
  const verdict = await runDryValidate({ plan, modules, outDir: out });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => /kind mismatch/.test(e)));
  await rm(out, { recursive: true, force: true });
});
