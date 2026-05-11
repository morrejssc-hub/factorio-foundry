import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactGraphStore } from "../src/runner/artifact-graph.js";
import { FoundryController } from "../src/runner/foundry-controller.js";

async function makeDagRoot() {
  const root = await mkdtemp(join(tmpdir(), "foundry-dag-"));
  await mkdir(join(root, "epochs"), { recursive: true });
  await mkdir(join(root, "state", "saves", "e1"), { recursive: true });
  await writeFile(join(root, "epochs", "dag.yaml"), [
    "id: test-dag",
    "nodes:",
    "  - id: e0",
    "  - id: e1",
    "    depends_on: [e0]",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(root, "epochs", "e0.md"), [
    "---",
    "id: e0",
    "kind: bootstrap",
    "output_save: state/saves/e0.zip",
    "---",
    "",
    "bootstrap",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(root, "epochs", "e1.md"), [
    "---",
    "id: e1",
    "kind: composition",
    "depends_on:",
    "  - e0",
    "input_save: state/saves/e0/",
    "output_save: state/saves/e1/",
    "---",
    "",
    "compose",
    "",
  ].join("\n"), "utf8");
  return root;
}

function makeGraph(root) {
  let n = 0;
  return new ArtifactGraphStore({
    rootDir: root,
    clock: () => new Date("2026-01-02T03:04:05.000Z"),
    idGenerator: () => `id-${++n}`,
  });
}

test("FoundryController DAG dry plan resolves input from graph artifact", async () => {
  const root = await makeDagRoot();
  try {
    const graph = makeGraph(root);
    await graph.createRun({ epoch: { id: "e0" }, runId: "run-e0" });
    await graph.recordArtifact({
      artifactId: "art-e0",
      kind: "save",
      path: "state/saves/e0/graph.zip",
      epochId: "e0",
      runId: "run-e0",
    });
    await graph.selectArtifact({ epochId: "e0", artifactId: "art-e0" });
    const controller = new FoundryController({
      config: { rootDir: root, parallelCandidates: 1 },
      graph,
      runController: { runEpoch: async () => ({ ok: true }) },
    });
    const plan = await controller.planDag({ from: "e1", to: "e1" });
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].input.source, "selected_ref");
    assert.equal(plan.steps[0].input.artifactId, "art-e0");
    assert.equal(plan.steps[0].input.path, resolve(root, "state/saves/e0/graph.zip"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FoundryController infers resume epoch after --from-artifact when --from is omitted", async () => {
  const root = await makeDagRoot();
  try {
    const graph = makeGraph(root);
    await graph.createRun({ epoch: { id: "e0" }, runId: "run-e0" });
    await graph.recordArtifact({
      artifactId: "art-e0",
      kind: "save",
      path: "state/saves/e0/resume.zip",
      epochId: "e0",
      runId: "run-e0",
    });
    const controller = new FoundryController({
      config: { rootDir: root, parallelCandidates: 1 },
      graph,
      runController: { runEpoch: async () => ({ ok: true }) },
    });
    const plan = await controller.planDag({ fromArtifactId: "art-e0", to: "e1" });
    assert.deepEqual(plan.steps.map((step) => step.id), ["e1"]);
    assert.equal(plan.steps[0].input.source, "explicit_artifact");
    assert.equal(plan.steps[0].input.path, resolve(root, "state/saves/e0/resume.zip"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FoundryController DAG dry plan keeps legacy input_save fallback without graph", async () => {
  const root = await makeDagRoot();
  try {
    const graph = makeGraph(root);
    const controller = new FoundryController({
      config: { rootDir: root, parallelCandidates: 1 },
      graph,
      runController: { runEpoch: async () => ({ ok: true }) },
    });
    const plan = await controller.planDag({ from: "e1", to: "e1" });
    assert.equal(plan.steps[0].input.source, "legacy_input_save");
    assert.equal(plan.steps[0].input.path, resolve(root, "state/saves/e0/winner.zip"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FoundryController runDag does not skip just because legacy output_save exists", async () => {
  const root = await makeDagRoot();
  try {
    await writeFile(join(root, "state", "saves", "e1", "winner.zip"), "legacy-output", "utf8");
    const graph = makeGraph(root);
    const calls = [];
    const controller = new FoundryController({
      config: { rootDir: root, parallelCandidates: 1 },
      graph,
      runController: {
        runEpoch: async ({ epoch }) => {
          calls.push(epoch.id);
          return { ok: true };
        },
      },
    });
    const result = await controller.runDag({ from: "e1", to: "e1" });
    assert.deepEqual(calls, ["e1"]);
    assert.equal(result.results[0].status, "pass");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
