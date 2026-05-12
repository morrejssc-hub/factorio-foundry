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

test("PORT_CONTAINERS is empty — chests/tanks are not valid port kinds", () => {
  assert.deepEqual(Object.keys(PORT_CONTAINERS), []);
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

test("ALL_KINDS does not include retired inventory kind", () => {
  assert.equal(ALL_KINDS.has("inventory"), false);
});

test("isAllowedPortEntity accepts each connector tier", () => {
  assert.equal(isAllowedPortEntity("belt", "transport-belt"), true);
  assert.equal(isAllowedPortEntity("belt", "fast-transport-belt"), true);
  assert.equal(isAllowedPortEntity("pipe", "pipe"), true);
  assert.equal(isAllowedPortEntity("power", "small-electric-pole"), true);
  assert.equal(isAllowedPortEntity("power", "substation"), true);
});

test("isAllowedPortEntity rejects retired inventory kind even on a chest", () => {
  assert.equal(isAllowedPortEntity("inventory", "iron-chest"), false);
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
      { key: "pole_a", item: "small-electric-pole", dx: 4, dy: 0 },
    ],
    ports: {
      out_belt:  { entity: "belt_a", kind: "belt", item: "coal" },
      power_in:  { entity: "pole_a", kind: "power", item: "electricity" },
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
  const powerPort = resolvePortEntityFromBlueprint(blueprint, "power_in");
  assert.equal(powerPort.entityName, "small-electric-pole");
  assert.equal(powerPort.kind, "power");
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

test("registrySummary lists every connector kind on its own line", () => {
  const summary = registrySummary();
  assert.match(summary, /belt: transport-belt/);
  assert.match(summary, /pipe: pipe/);
  assert.match(summary, /power: small-electric-pole/);
  // inventory is retired — it should NOT appear
  assert.doesNotMatch(summary, /inventory:/);
});
