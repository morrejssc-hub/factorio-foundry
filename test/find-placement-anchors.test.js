// Smoke checks for lib/probes/find-placement-anchors.lua.
//
// The probe runs inside Factorio via RCON, so we can't unit-test its
// runtime behavior without a live game. These tests are regression
// guards: they assert the file exists, exposes the expected entry
// point, and documents the params we wire into Designer prompts. End-
// to-end correctness is covered by the e4-steam-power smoke epoch.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const probePath  = resolve(__dirname, "..", "lib", "probes", "find-placement-anchors.lua");

describe("find-placement-anchors.lua probe", () => {
  it("exists and exposes a query() entry point", async () => {
    const lua = await readFile(probePath, "utf8");
    assert.match(lua, /return\s*{\s*[\s\S]*query\s*=\s*function\s*\(\s*params\s*\)/,
      "probe must export `return { query = function(params) ... }` like the other lib/probes scripts");
  });

  it("documents the expected param contract in the header comment", async () => {
    const lua    = await readFile(probePath, "utf8");
    const header = lua.split("\n").slice(0, 80).join("\n");
    for (const key of ["entity", "region", "mode", "max_results", "sort_by", "directions"]) {
      assert.match(header, new RegExp(`\\b${key}\\b`),
        `header must document param '${key}' so foundry-read prompt and Designer agree on the shape`);
    }
  });

  it("supports both raw and edge modes", async () => {
    const lua = await readFile(probePath, "utf8");
    assert.match(lua, /"raw"|'raw'/, "raw mode literal must appear");
    assert.match(lua, /"edge"|'edge'/, "edge mode literal must appear");
  });

  it("emits status field with free | needs_clearing values", async () => {
    const lua = await readFile(probePath, "utf8");
    assert.match(lua, /status\s*=\s*"free"/, "free status must be set on placeable anchors");
    assert.match(lua, /status\s*=\s*"needs_clearing"/, "needs_clearing status must be set when only clearable blockers");
  });

  it("groups results by position via direction_merge", async () => {
    const lua = await readFile(probePath, "utf8");
    assert.match(lua, /direction_merge|directions\s*=\s*\{\s*\}/,
      "results must be grouped per (x,y) with a directions array");
  });

  it("guards against runaway scans with a hard cap", async () => {
    const lua = await readFile(probePath, "utf8");
    assert.match(lua, /SCAN_HARD_CAP|scan would exceed/i,
      "must trip an internal cap before issuing tens of thousands of can_place_entity calls");
  });

  it("reports total_found alongside truncated results", async () => {
    const lua = await readFile(probePath, "utf8");
    assert.match(lua, /total_found/, "agent needs total_found to know if truncation hid candidates");
  });
});

describe("port-meter.lua power branch — extra fields", () => {
  const meterPath = resolve(__dirname, "..", "lib", "meters", "port-meter.lua");

  it("returns max_kw and stored_kj on the power branch", async () => {
    const lua = await readFile(meterPath, "utf8");
    assert.match(lua, /max_kw\s*=/,
      "max_kw must be emitted so the runner can show nameplate capacity");
    assert.match(lua, /stored_kj\s*=/,
      "stored_kj must be emitted so the runner can show accumulator state");
  });

  it("walks generators + accumulators filtered by electric_network_id", async () => {
    const lua = await readFile(meterPath, "utf8");
    assert.match(lua, /electric_network_id/,
      "snapshot must filter by network id, not just radius");
    assert.match(lua, /type\s*=\s*"generator"/,
      "must enumerate generators for max_kw");
    assert.match(lua, /type\s*=\s*"accumulator"/,
      "must enumerate accumulators for stored_kj");
  });
});
