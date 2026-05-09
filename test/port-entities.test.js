import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PORT_CONNECTORS,
  PORT_CONTAINERS,
  ALL_KINDS,
  METERED_KINDS,
  isAllowedPortEntity,
  resolvePortEntityFromBlueprint,
  registrySummary,
} from "../src/runner/port-entities.js";

test("PORT_CONNECTORS lists three belt speeds", () => {
  assert.deepEqual(PORT_CONNECTORS.belt, [
    "transport-belt",
    "fast-transport-belt",
    "express-transport-belt",
  ]);
});

test("PORT_CONNECTORS lists four electric pole tiers", () => {
  assert.deepEqual(PORT_CONNECTORS.power, [
    "small-electric-pole",
    "medium-electric-pole",
    "big-electric-pole",
    "substation",
  ]);
});

test("PORT_CONTAINERS lists chest tiers under inventory", () => {
  assert.deepEqual(PORT_CONTAINERS.inventory, [
    "wooden-chest",
    "iron-chest",
    "steel-chest",
  ]);
});

test("METERED_KINDS contains exactly belt/pipe/power", () => {
  assert.deepEqual([...METERED_KINDS].sort(), ["belt", "pipe", "power"]);
});

test("ALL_KINDS contains every connector and container kind", () => {
  for (const kind of Object.keys(PORT_CONNECTORS)) {
    assert.ok(ALL_KINDS.has(kind), `missing connector kind '${kind}'`);
  }
  for (const kind of Object.keys(PORT_CONTAINERS)) {
    assert.ok(ALL_KINDS.has(kind), `missing container kind '${kind}'`);
  }
});

test("isAllowedPortEntity accepts each connector tier", () => {
  assert.equal(isAllowedPortEntity("belt", "transport-belt"), true);
  assert.equal(isAllowedPortEntity("belt", "fast-transport-belt"), true);
  assert.equal(isAllowedPortEntity("pipe", "pipe"), true);
  assert.equal(isAllowedPortEntity("power", "small-electric-pole"), true);
  assert.equal(isAllowedPortEntity("power", "substation"), true);
  assert.equal(isAllowedPortEntity("inventory", "iron-chest"), true);
});

test("isAllowedPortEntity rejects mismatched kind/entity", () => {
  assert.equal(isAllowedPortEntity("belt", "iron-chest"), false);
  assert.equal(isAllowedPortEntity("power", "transport-belt"), false);
  assert.equal(isAllowedPortEntity("pipe", "small-electric-pole"), false);
  // Unknown kind
  assert.equal(isAllowedPortEntity("electric", "small-electric-pole"), false);
  // Unknown entity
  assert.equal(isAllowedPortEntity("belt", "magic-belt"), false);
});

test("resolvePortEntityFromBlueprint reads kind/item via entity-key", () => {
  const blueprint = {
    entities: [
      { key: "belt_a", item: "transport-belt", dx: 1, dy: 0 },
      { key: "chest_a", item: "iron-chest", dx: 4, dy: 0 },
    ],
    ports: {
      out_belt: { entity: "belt_a", kind: "belt", item: "coal" },
      out_chest: { entity: "chest_a", kind: "inventory", item: "coal" },
    },
  };
  const beltPort = resolvePortEntityFromBlueprint(blueprint, "out_belt");
  assert.deepEqual(beltPort, {
    entityKey: "belt_a",
    entityName: "transport-belt",
    dx: 1,
    dy: 0,
    kind: "belt",
  });
  const chestPort = resolvePortEntityFromBlueprint(blueprint, "out_chest");
  assert.equal(chestPort.entityName, "iron-chest");
  assert.equal(chestPort.kind, "inventory");
});

test("resolvePortEntityFromBlueprint returns null on missing port/entity", () => {
  const blueprint = {
    entities: [{ key: "belt_a", item: "transport-belt", dx: 0, dy: 0 }],
    ports: { out_belt: { entity: "belt_a", kind: "belt", item: "coal" } },
  };
  assert.equal(resolvePortEntityFromBlueprint(blueprint, "nope"), null);
  // Port references entity-key that doesn't exist in entities[]
  const blueprint2 = {
    entities: [],
    ports: { dangling: { entity: "ghost", kind: "belt", item: "coal" } },
  };
  assert.equal(resolvePortEntityFromBlueprint(blueprint2, "dangling"), null);
});

test("registrySummary lists every kind on its own line", () => {
  const summary = registrySummary();
  assert.match(summary, /belt: transport-belt/);
  assert.match(summary, /pipe: pipe/);
  assert.match(summary, /power: small-electric-pole/);
  assert.match(summary, /inventory: wooden-chest/);
});
