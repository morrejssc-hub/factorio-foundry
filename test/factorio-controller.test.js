// factorio-controller.test.js — unit tests for the FactorioController facade.
// Mocks FactorioServer with a tiny stub that records calls and produces fake
// save zips on disk. Skips network-dependent methods (rcon / read /
// advanceTicks / runLuaScript) — those are exercised live via the e1 chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FactorioController } from "../src/runner/factorio-controller.js";

function fakeFactorio({ savesDir, savePath }) {
  const calls = [];
  let running = false;
  let saveCounter = 0;
  return {
    calls,
    isRunning: () => running,
    start: async () => { calls.push(["start"]); running = true; },
    stop: async () => { calls.push(["stop"]); running = false; },
    savePath: () => savePath,
    save: async () => {
      saveCounter += 1;
      const path = join(savesDir, `auto-${saveCounter}.zip`);
      await writeFile(path, `save-content-${saveCounter}`);
      calls.push(["save", path]);
      return { path, mtimeMs: Date.now() };
    },
    handleAction: async (input) => {
      calls.push(["handleAction", input]);
      return { ok: true };
    },
    setRunning: (v) => { running = v; },
  };
}

async function tmp() {
  const dir = await mkdtemp(join(tmpdir(), "ctl-"));
  const savesDir = join(dir, "saves");
  const savePath = join(savesDir, "main.zip");
  await mkdir(savesDir, { recursive: true });
  return { dir, savesDir, savePath };
}

// ------------------------------------------------------------
// action()
// ------------------------------------------------------------

test("action: forwards to factorio.handleAction with merged params", async () => {
  const { savesDir, savePath } = await tmp();
  const factorio = fakeFactorio({ savesDir, savePath });
  const ctl = new FactorioController(factorio, { savesDir });
  await ctl.action("place_harness", { placements: [{ x: 1 }] });
  const last = factorio.calls.find((c) => c[0] === "handleAction");
  assert.deepEqual(last[1], { placements: [{ x: 1 }], action: "place_harness" });
});

test("action: chosen action name overrides any 'action' key in params", async () => {
  const { savesDir, savePath } = await tmp();
  const factorio = fakeFactorio({ savesDir, savePath });
  const ctl = new FactorioController(factorio, { savesDir });
  await ctl.action("place_harness", { action: "evil_override", x: 1 });
  const last = factorio.calls.find((c) => c[0] === "handleAction");
  assert.equal(last[1].action, "place_harness");
});

// ------------------------------------------------------------
// loadSave()
// ------------------------------------------------------------

test("loadSave: stops then copies zip to save path then starts", async () => {
  const { dir, savesDir, savePath } = await tmp();
  const inputZip = join(dir, "input.zip");
  await writeFile(inputZip, "input-content");

  const factorio = fakeFactorio({ savesDir, savePath });
  factorio.setRunning(true);
  const ctl = new FactorioController(factorio, { savesDir });

  await ctl.loadSave(inputZip);

  const ops = factorio.calls.map((c) => c[0]);
  assert.ok(ops.indexOf("stop") >= 0 && ops.indexOf("start") >= 0);
  assert.ok(ops.indexOf("stop") < ops.indexOf("start"), "stop must precede start");
  assert.equal(await readFile(savePath, "utf8"), "input-content");
});

test("loadSave: skips stop when not running", async () => {
  const { dir, savesDir, savePath } = await tmp();
  const inputZip = join(dir, "input.zip");
  await writeFile(inputZip, "x");

  const factorio = fakeFactorio({ savesDir, savePath });
  // running stays false
  const ctl = new FactorioController(factorio, { savesDir });

  await ctl.loadSave(inputZip);
  const ops = factorio.calls.map((c) => c[0]);
  assert.ok(!ops.includes("stop"));
  assert.ok(ops.includes("start"));
});

test("loadSave: omitted zipPath just (re)starts", async () => {
  const { savesDir, savePath } = await tmp();
  const factorio = fakeFactorio({ savesDir, savePath });
  factorio.setRunning(true);
  const ctl = new FactorioController(factorio, { savesDir });

  await ctl.loadSave();
  const ops = factorio.calls.map((c) => c[0]);
  assert.deepEqual(ops, ["stop", "start"]);
});

// ------------------------------------------------------------
// snapshot()
// ------------------------------------------------------------

test("snapshot: copies save zip into snapshots/<name>.zip", async () => {
  const { savesDir, savePath } = await tmp();
  const factorio = fakeFactorio({ savesDir, savePath });
  const ctl = new FactorioController(factorio, { savesDir });

  const snapPath = await ctl.snapshot("a");
  assert.equal(snapPath, resolve(savesDir, "snapshots", "a.zip"));
  const content = await readFile(snapPath, "utf8");
  assert.match(content, /save-content-\d+/);
});

test("snapshot: rejects names with unsafe chars", async () => {
  const { savesDir, savePath } = await tmp();
  const factorio = fakeFactorio({ savesDir, savePath });
  const ctl = new FactorioController(factorio, { savesDir });
  await assert.rejects(ctl.snapshot("../../etc/passwd"), /must match/);
  await assert.rejects(ctl.snapshot("a b"), /must match/);
  await assert.rejects(ctl.snapshot(""), /must match/);
  await assert.rejects(ctl.snapshot(123), /must match/);
});

// ------------------------------------------------------------
// rollback()
// ------------------------------------------------------------

test("rollback: stops, copies snapshot zip to save path, starts", async () => {
  const { savesDir, savePath } = await tmp();
  const snapDir = join(savesDir, "snapshots");
  await mkdir(snapDir, { recursive: true });
  await writeFile(join(snapDir, "a.zip"), "snapshot-content");

  const factorio = fakeFactorio({ savesDir, savePath });
  factorio.setRunning(true);
  const ctl = new FactorioController(factorio, { savesDir });

  await ctl.rollback("a");

  const ops = factorio.calls.map((c) => c[0]);
  assert.ok(ops.indexOf("stop") >= 0 && ops.indexOf("start") >= 0);
  assert.ok(ops.indexOf("stop") < ops.indexOf("start"));
  assert.equal(await readFile(savePath, "utf8"), "snapshot-content");
});

test("rollback: rejects unsafe names", async () => {
  const { savesDir, savePath } = await tmp();
  const factorio = fakeFactorio({ savesDir, savePath });
  const ctl = new FactorioController(factorio, { savesDir });
  await assert.rejects(ctl.rollback("../escape"), /must match/);
});

// ------------------------------------------------------------
// exportZip()
// ------------------------------------------------------------

test("exportZip: saves and copies newest zip to destination", async () => {
  const { dir, savesDir, savePath } = await tmp();
  const dest = join(dir, "out.zip");
  const factorio = fakeFactorio({ savesDir, savePath });
  const ctl = new FactorioController(factorio, { savesDir });

  await ctl.exportZip(dest);
  const content = await readFile(dest, "utf8");
  assert.match(content, /save-content-\d+/);
});

test("exportZip: creates parent directory if missing", async () => {
  const { dir, savesDir, savePath } = await tmp();
  const dest = join(dir, "nested", "deep", "out.zip");
  const factorio = fakeFactorio({ savesDir, savePath });
  const ctl = new FactorioController(factorio, { savesDir });

  await ctl.exportZip(dest);
  assert.ok((await readFile(dest, "utf8")).startsWith("save-content-"));
});

// ------------------------------------------------------------
// Process pass-through
// ------------------------------------------------------------

test("isRunning / start / stop / savePath delegate to factorio", async () => {
  const { savesDir, savePath } = await tmp();
  const factorio = fakeFactorio({ savesDir, savePath });
  const ctl = new FactorioController(factorio, { savesDir });

  assert.equal(ctl.isRunning(), false);
  await ctl.start();
  assert.equal(ctl.isRunning(), true);
  await ctl.stop();
  assert.equal(ctl.isRunning(), false);
  assert.equal(ctl.savePath(), savePath);
});
