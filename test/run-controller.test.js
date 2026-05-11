import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactGraphStore } from "../src/runner/artifact-graph.js";
import { RunController } from "../src/runner/run-controller.js";

async function tmpRoot() {
  return mkdtemp(join(tmpdir(), "foundry-run-controller-"));
}

function makeGraph(root) {
  let n = 0;
  return new ArtifactGraphStore({
    rootDir: root,
    clock: () => new Date("2026-01-02T03:04:05.000Z"),
    idGenerator: () => `id-${++n}`,
  });
}

function makeAttempt(root, runDir, attempt, overrides = {}) {
  const candidate = `c${attempt - 1}`;
  const candidateDir = join(runDir, "candidates", candidate);
  return {
    attempt,
    candidate,
    candidateDir,
    designOut: join(candidateDir, "design"),
    executeOut: join(candidateDir, "execute"),
    candidateSavePath: join(root, "state", "saves", "e1", `candidate-${attempt}.zip`),
    placements: 1,
    authored: [],
    dry_validate: { ok: true, errors: [] },
    execute: null,
    verify: { pass: false, measured: 0, threshold: 1, item: "coal" },
    observe: null,
    error: null,
    ...overrides,
  };
}

test("RunController records run, candidate, phase, artifact, and ref events", async () => {
  const root = await tmpRoot();
  try {
    const graph = makeGraph(root);
    const config = { rootDir: root, parallelCandidates: 1 };
    let runnerInput = null;
    const runner = async ({ inputSaveOverride, runDirOverride }) => {
      runnerInput = inputSaveOverride;
      const attempt = makeAttempt(root, runDirOverride, 1, {
        execute: { ok: true, save_path: join(root, "state", "saves", "e1", "candidate-1.zip") },
        verify: { pass: true, measured: 1.2, threshold: 1, item: "coal" },
        observe: { pass: true, measured: 1.1, threshold: 1, item: "coal" },
      });
      return {
        ok: true,
        runDir: runDirOverride,
        attempts: 1,
        attemptsDetail: [attempt],
        verdict: attempt.verify,
      };
    };
    const controller = new RunController({ config, graph, runner, clock: () => new Date("2026-01-02T03:04:05.000Z") });
    const result = await controller.runEpoch({
      epoch: {
        id: "e1",
        kind: "composition",
        depends_on: ["e0"],
        input_save: "state/saves/e0/",
      },
    });

    assert.equal(runnerInput, resolve(root, "state/saves/e0/winner.zip"));
    assert.equal(result.graph.selectedArtifactId.startsWith("art_e1_save_"), true);
    const events = await graph.readEvents();
    assert.deepEqual(events.map((event) => event.type), [
      "run_started",
      "phase_completed",
      "candidate_started",
      "phase_completed",
      "phase_completed",
      "phase_completed",
      "phase_completed",
      "artifact_created",
      "candidate_completed",
      "ref_updated",
      "run_completed",
    ]);
    assert.deepEqual(events.filter((event) => event.type === "phase_completed").map((event) => event.phase), [
      "probe",
      "design",
      "dry-validate",
      "verify",
      "observe",
    ]);
    const refs = await graph.readRefs();
    assert.equal(refs["epoch/e1/selected"], result.graph.selectedArtifactId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RunController records failed verify attempt before winning retry", async () => {
  const root = await tmpRoot();
  try {
    const graph = makeGraph(root);
    const config = { rootDir: root, parallelCandidates: 1 };
    const runner = async ({ runDirOverride }) => {
      const failed = makeAttempt(root, runDirOverride, 1);
      const winner = makeAttempt(root, runDirOverride, 2, {
        execute: { ok: true, save_path: join(root, "state", "saves", "e1", "candidate-2.zip") },
        verify: { pass: true, measured: 2, threshold: 1, item: "coal" },
        observe: { pass: true, measured: 2, threshold: 1, item: "coal" },
      });
      return {
        ok: true,
        runDir: runDirOverride,
        attempts: 2,
        attemptsDetail: [failed, winner],
        verdict: winner.verify,
      };
    };
    const controller = new RunController({ config, graph, runner, clock: () => new Date("2026-01-02T03:04:05.000Z") });
    const result = await controller.runEpoch({
      epoch: {
        id: "e1",
        kind: "composition",
        input_save: "state/saves/e0/winner.zip",
      },
    });
    const run = await graph.getRun(result.graph.runId);
    assert.equal(run.candidates.length, 2);
    assert.equal(run.candidates[0].ok, false);
    assert.equal(run.candidates[1].ok, true);
    assert.equal(run.selected_candidate_id, "c1");
    assert.equal(run.selected_artifact_id, result.graph.selectedArtifactId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
