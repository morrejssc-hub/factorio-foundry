import { test } from "node:test";
import assert from "node:assert/strict";
import { FactorioServer } from "../src/factorio-server.js";

function makeServer() {
  return new FactorioServer({
    runtimeDir: "/tmp/x", savesDir: "/tmp/x", configDir: "/tmp/x",
    logsDir: "/tmp/x", modsDir: "/tmp/x", factorioDir: "/tmp/x",
    saveName: "main.zip", rconPassword: "x",
  });
}

test("normalizeBlueprint accepts per-entity settings.fuel and emits a fuel action", () => {
  const srv = makeServer();
  const bp = srv.normalizeBlueprint({
    name: "t", entities: [
      { key: "drill", item: "burner-mining-drill", dx: 0, dy: 0, direction: "east",
        settings: { fuel: { item: "coal", count: 5 } } },
    ],
  });
  assert.equal(bp.entities.length, 1);
  assert.deepEqual(bp.settingsActions, [
    { kind: "fuel", target: "drill", item: "coal", count: 5, inventory: "fuel" },
  ]);
});

test("normalizeBlueprint accepts settings.recipe on assembling-machine-1", () => {
  const srv = makeServer();
  const bp = srv.normalizeBlueprint({
    name: "t", entities: [
      { key: "asm", item: "assembling-machine-1", dx: 0, dy: 0, direction: "north",
        settings: { recipe: "iron-gear-wheel" } },
    ],
  });
  assert.deepEqual(bp.settingsActions, [
    { kind: "recipe", target: "asm", recipe: "iron-gear-wheel" },
  ]);
});

test("normalizeBlueprint rejects setting key not applicable to the entity item", () => {
  const srv = makeServer();
  assert.throws(() => srv.normalizeBlueprint({
    name: "t", entities: [
      { key: "belt", item: "transport-belt", dx: 0, dy: 0,
        settings: { fuel: { item: "coal", count: 1 } } },
    ],
  }), /not applicable to item transport-belt/);
});

test("normalizeBlueprint rejects unknown setting key", () => {
  const srv = makeServer();
  assert.throws(() => srv.normalizeBlueprint({
    name: "t", entities: [
      { key: "asm", item: "assembling-machine-1", dx: 0, dy: 0,
        settings: { bogus: "x" } },
    ],
  }), /unknown key: bogus/);
});

test("normalizeBlueprint rejects legacy top-level fuel array", () => {
  const srv = makeServer();
  assert.throws(() => srv.normalizeBlueprint({
    name: "t",
    entities: [{ key: "drill", item: "burner-mining-drill", dx: 0, dy: 0 }],
    fuel: [{ target: "drill", item: "coal", count: 1 }],
  }), /no longer supported/);
});

test("normalizeBlueprint loads a migrated coal-burner-cell blueprint with three fuel actions", async () => {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(new URL("../lib/blueprints/coal-burner-cell.json", import.meta.url), "utf8");
  const srv = makeServer();
  const bp = srv.normalizeBlueprint(JSON.parse(text), "coal-burner-cell");
  const fuelActions = bp.settingsActions.filter((a) => a.kind === "fuel");
  assert.equal(fuelActions.length, 3);
  assert.deepEqual(new Set(fuelActions.map((a) => a.target)),
    new Set(["drill", "fuel_inserter", "output_inserter"]));
});
