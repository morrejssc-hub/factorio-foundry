import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlacementProposal, buildConnectionProposal } from "../src/runner/executor-proposal.js";

const sampleErr = (msg, payload = null) => {
  const e = new Error(msg);
  if (payload) e.payload = payload;
  return e;
};

test("buildPlacementProposal classifies a collision error", () => {
  const placement = {
    id: "p0",
    module: "coal-burner-cell",
    anchor: { x: -78, y: -13 },
    direction: "north",
  };
  const proposal = buildPlacementProposal(0, placement, sampleErr("entity collision: tile already occupied"));

  assert.equal(proposal.failed_step, 0);
  assert.equal(proposal.root_cause, "collision_with_existing");
  assert.deepEqual(proposal.failed_entity, {
    item: "coal-burner-cell",
    position: { x: -78, y: -13 },
    direction: "north",
  });
  assert.ok(proposal.suggested_changes.length > 0);
  assert.ok(proposal.suggested_changes.every((s) => s.type === "shift"));
  assert.equal(proposal.extra.raw_error, "entity collision: tile already occupied");
  assert.equal(proposal.extra.placement_id, "p0");
});

test("buildPlacementProposal classifies a missing-resource error", () => {
  const placement = { id: "p1", module: "iron-smelt-line", anchor: { x: 0, y: 0 }, direction: "east" };
  const proposal = buildPlacementProposal(1, placement, sampleErr("no iron ore at this anchor"));

  assert.equal(proposal.root_cause, "missing_resource");
  assert.equal(proposal.suggested_changes[0].type, "swap_module");
});

test("buildPlacementProposal falls back to rcon_error when no keyword matches", () => {
  const placement = { id: "p0", module: "x", anchor: { x: 0, y: 0 }, direction: "north" };
  const proposal = buildPlacementProposal(0, placement, sampleErr("HTTP 500: internal error"));
  assert.equal(proposal.root_cause, "rcon_error");
  assert.equal(proposal.suggested_changes.length, 0);
});

test("buildPlacementProposal preserves error.payload in extra", () => {
  const placement = { id: "p0", module: "x", anchor: { x: 0, y: 0 }, direction: "north" };
  const err = sampleErr("blueprint malformed: unknown entity 'foo'", { detail: "lua trace" });
  const proposal = buildPlacementProposal(0, placement, err);
  assert.equal(proposal.root_cause, "blueprint_invalid");
  assert.deepEqual(proposal.extra.payload, { detail: "lua trace" });
});

test("buildConnectionProposal handles a no-path error and known conn pair", () => {
  const conn = { from: "p0.coal_belt", to: "p1.coal_in", required_throughput: 0.18 };
  const err = sampleErr("connection p0.coal_belt→p1.coal_in failed: no path found");
  const proposal = buildConnectionProposal(conn, err);
  assert.equal(proposal.failed_step, -1);
  assert.equal(proposal.failed_entity, null);
  assert.equal(proposal.root_cause, "no_belt_path");
  assert.deepEqual(proposal.extra.connection, conn);
  assert.ok(proposal.suggested_changes.some((s) => s.type === "rearrange_placements"));
  assert.ok(proposal.suggested_changes.some((s) => s.type === "use_underground"));
});

test("buildConnectionProposal handles a null conn (parsed-failure fallback)", () => {
  const err = sampleErr("connection a→b failed: route_belt failed (visited 1234 nodes)");
  const proposal = buildConnectionProposal(null, err);
  assert.equal(proposal.root_cause, "no_belt_path");
  assert.equal(proposal.extra.connection, null);
});
