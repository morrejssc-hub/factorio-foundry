import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ArtifactGraphStore } from "./artifact-graph.js";
import { candidateDir, epochSaveDir, winnerSavePath } from "./run-layout.js";
import { runEpoch as runLegacyEpoch } from "./epoch.js";

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function timestampForPath(date = new Date()) {
  return toIso(date).replace(/[:.]/g, "-");
}

function candidateOk(record) {
  if (record?.observe) return !!record.observe.pass;
  if (record?.verify) return !!record.verify.pass;
  return false;
}

function selectedAttemptRecord(result) {
  if (!Array.isArray(result?.attemptsDetail)) return null;
  return result.attemptsDetail.find((record) => candidateOk(record)) || null;
}

export class RunController {
  constructor({
    config,
    factorio,
    graph = null,
    runner = runLegacyEpoch,
    log = console.log,
    clock = () => new Date(),
  } = {}) {
    if (!config?.rootDir) throw new Error("RunController requires config.rootDir");
    this.config = config;
    this.factorio = factorio;
    this.graph = graph || new ArtifactGraphStore({ rootDir: config.rootDir, clock });
    this.runner = runner;
    this.log = log;
    this.clock = clock;
  }

  async runEpoch({ epoch, fromArtifactId = null } = {}) {
    if (!epoch?.id) throw new Error("RunController.runEpoch requires epoch.id");
    const input = await this.graph.resolveEpochInput({ epoch, fromArtifactId });
    const startedAt = this.clock();
    const startedAtIso = toIso(startedAt);
    const runTs = timestampForPath(startedAt);
    const runDir = resolve(this.config.rootDir, "plans", `${epoch.id}-${runTs}`);
    await mkdir(runDir, { recursive: true });
    const run = await this.graph.createRun({
      epoch,
      parentArtifactId: input.artifactId,
      runDir,
      startedAt: startedAtIso,
    });

    const effectiveEpoch = input.path && epoch.kind !== "bootstrap"
      ? { ...epoch, input_save: input.path }
      : { ...epoch };

    let result;
    let selectedRecord = null;
    let selectedArtifact = null;
    try {
      result = await this.runner({
        config: this.config,
        factorio: this.factorio,
        epoch: effectiveEpoch,
        inputSaveOverride: input.path,
        runDirOverride: runDir,
        runTsOverride: runTs,
      });

      selectedArtifact = await this.recordResult({
        epoch: effectiveEpoch,
        runId: run.runId,
        parentArtifactId: input.artifactId,
        runDir,
        result,
      });

      selectedRecord = selectedAttemptRecord(result);
      selectedArtifact = result.graph?.selectedArtifact || selectedArtifact;
      if (!selectedArtifact && result.ok && selectedRecord?.candidateSavePath) {
        selectedArtifact = await this.graph.recordArtifact({
          kind: "save",
          path: selectedRecord.candidateSavePath,
          epochId: epoch.id,
          runId: run.runId,
          candidateId: selectedRecord.candidate,
          parentArtifactId: input.artifactId,
        });
      } else if (!selectedArtifact && result.ok && result.savePath) {
        selectedArtifact = await this.graph.recordArtifact({
          kind: "save",
          path: result.savePath,
          epochId: epoch.id,
          runId: run.runId,
          candidateId: null,
          parentArtifactId: input.artifactId,
        });
      }

      if (result.ok && selectedArtifact?.artifact_id) {
        await this.graph.selectArtifact({ epochId: epoch.id, artifactId: selectedArtifact.artifact_id });
      }
      await this.graph.completeRun({
        runId: run.runId,
        ok: !!result.ok,
        selectedCandidateId: selectedRecord?.candidate ?? null,
        selectedArtifactId: selectedArtifact?.artifact_id ?? null,
      });
      return {
        ...result,
        graph: {
          runId: run.runId,
          input,
          selectedArtifactId: selectedArtifact?.artifact_id ?? null,
        },
      };
    } catch (error) {
      await this.graph.completeRun({
        runId: run.runId,
        ok: false,
        selectedCandidateId: null,
        selectedArtifactId: null,
        error: error.message,
      });
      throw error;
    }
  }

  async recordResult({ epoch, runId, parentArtifactId = null, runDir, result } = {}) {
    if (!result) return null;
    if (Array.isArray(result.attemptsDetail) && (result.runDir || runDir)) {
      await this.graph.recordPhase({
        runId,
        phase: "probe",
        ok: true,
        path: join(result.runDir || runDir, "probe"),
        summary: { attempts: result.attempts ?? null },
      });
    }

    if (!Array.isArray(result.attemptsDetail)) return null;
    let selectedArtifact = null;
    for (const record of result.attemptsDetail) {
      const cid = record.candidate || `c${Math.max(0, Number(record.attempt || 1) - 1)}`;
      await this.graph.startCandidate({
        runId,
        attempt: record.attempt,
        candidateId: cid,
        candidateDir: record.candidateDir || candidateDir(runDir, cid),
      });

      if (record.designOut) {
        await this.graph.recordPhase({
          runId,
          candidateId: cid,
          phase: "design",
          ok: record.placements != null && !record.error,
          path: record.designOut,
          summary: {
            placements: record.placements,
            authored: record.authored || [],
          },
        });
      }
      if (record.dry_validate) {
        await this.graph.recordPhase({
          runId,
          candidateId: cid,
          phase: "dry-validate",
          ok: !!record.dry_validate.ok,
          path: record.candidateDir ? join(record.candidateDir, "dry-validate.json") : null,
          summary: record.dry_validate,
        });
      }
      if (record.verify) {
        await this.graph.recordPhase({
          runId,
          candidateId: cid,
          phase: "verify",
          ok: !!record.verify.pass,
          path: record.executeOut ? join(record.executeOut, "verify.json") : null,
          summary: record.verify,
        });
      }
      if (record.observe) {
        await this.graph.recordPhase({
          runId,
          candidateId: cid,
          phase: "observe",
          ok: !!record.observe.pass,
          path: record.candidateDir ? join(record.candidateDir, "observe.json") : null,
          summary: record.observe,
        });
      }
      if (record.execute?.save_path && candidateOk(record)) {
        selectedArtifact = await this.graph.recordArtifact({
          kind: "save",
          path: record.execute.save_path,
          epochId: epoch.id,
          runId,
          candidateId: cid,
          parentArtifactId,
        });
      }
      await this.graph.completeCandidate({
        runId,
        candidateId: cid,
        ok: candidateOk(record),
        verify: record.verify ?? null,
        observe: record.observe ?? null,
        error: record.error ?? null,
      });
    }
    return selectedArtifact;
  }

  async selectedArtifactForEpoch(epochId) {
    const refs = await this.graph.readRefs();
    const artifactId = refs[`epoch/${epochId}/selected`];
    return artifactId ? this.graph.getArtifact(artifactId) : null;
  }

  winnerPathForEpoch(epochId) {
    return winnerSavePath(epochSaveDir(this.config, epochId));
  }
}
