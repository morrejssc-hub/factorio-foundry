import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactGraphStore } from "../src/runner/artifact-graph.js";

async function tmpRoot() {
  return mkdtemp(join(tmpdir(), "foundry-graph-"));
}

function graph(root) {
  let n = 0;
  return new ArtifactGraphStore({
    rootDir: root,
    clock: () => new Date("2026-01-02T03:04:05.000Z"),
    idGenerator: () => `id-${++n}`,
  });
}

test("ArtifactGraphStore appends and reads JSONL events", async () => {
  const root = await tmpRoot();
  try {
    const store = graph(root);
    await store.appendEvent("unit_event", { value: 1 });
    await store.appendEvent("unit_event", { value: 2 });
    const events = await store.readEvents();
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((event) => event.value), [1, 2]);
    assert.equal(events[0].type, "unit_event");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ArtifactGraphStore records artifact parent lineage", async () => {
  const root = await tmpRoot();
  try {
    const store = graph(root);
    const run = await store.createRun({ epoch: { id: "e1" }, runDir: join(root, "plans", "r1") });
    const parent = await store.recordArtifact({
      artifactId: "art-parent",
      kind: "save",
      path: "state/saves/e0.zip",
      epochId: "e0",
      runId: run.runId,
    });
    const child = await store.recordArtifact({
      artifactId: "art-child",
      kind: "save",
      path: "state/saves/e1.zip",
      epochId: "e1",
      runId: run.runId,
      candidateId: "c0",
      parentArtifactId: parent.artifact_id,
    });
    const loaded = await store.getArtifact(child.artifact_id);
    assert.equal(loaded.parent_artifact_id, "art-parent");
    assert.equal(loaded.candidate_id, "c0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ArtifactGraphStore updates selected refs", async () => {
  const root = await tmpRoot();
  try {
    const store = graph(root);
    await store.createRun({ epoch: { id: "e1" }, runId: "run-1" });
    await store.recordArtifact({
      artifactId: "art-selected",
      kind: "save",
      path: "state/saves/e1/winner.zip",
      epochId: "e1",
      runId: "run-1",
    });
    await store.selectArtifact({ epochId: "e1", artifactId: "art-selected" });
    const refs = await store.readRefs();
    assert.equal(refs["epoch/e1/selected"], "art-selected");
    assert.equal((await store.readEvents()).at(-1).type, "ref_updated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ArtifactGraphStore resolves explicit artifact, selected ref, then legacy input_save", async () => {
  const root = await tmpRoot();
  try {
    const store = graph(root);
    await store.createRun({ epoch: { id: "e0" }, runId: "run-0" });
    await store.recordArtifact({
      artifactId: "art-e0",
      kind: "save",
      path: "state/saves/e0/from-graph.zip",
      epochId: "e0",
      runId: "run-0",
    });
    await store.recordArtifact({
      artifactId: "art-explicit",
      kind: "save",
      path: "state/saves/manual.zip",
      epochId: "manual",
      runId: "run-0",
    });
    await store.selectArtifact({ epochId: "e0", artifactId: "art-e0" });

    const epoch = {
      id: "e1",
      kind: "composition",
      depends_on: ["e0"],
      input_save: "state/saves/e0/",
    };
    const explicit = await store.resolveEpochInput({ epoch, fromArtifactId: "art-explicit" });
    assert.equal(explicit.source, "explicit_artifact");
    assert.equal(explicit.path, resolve(root, "state/saves/manual.zip"));

    const selected = await store.resolveEpochInput({ epoch });
    assert.equal(selected.source, "selected_ref");
    assert.equal(selected.artifactId, "art-e0");
    assert.equal(selected.path, resolve(root, "state/saves/e0/from-graph.zip"));

    const legacy = await store.resolveEpochInput({
      epoch: { ...epoch, depends_on: ["missing"], input_save: "state/saves/missing/" },
    });
    assert.equal(legacy.source, "legacy_input_save");
    assert.equal(legacy.path, resolve(root, "state/saves/missing/winner.zip"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
