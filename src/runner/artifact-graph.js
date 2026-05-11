import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { exists } from "../fs-util.js";
import { resolveInputSave } from "./run-layout.js";

function sanitizeId(value) {
  return String(value || "unknown")
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unknown";
}

function nowIso(clock) {
  const value = clock();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function timestampForPath(iso) {
  return iso.replace(/[:.]/g, "-");
}

function inferEpochIdFromInputSave(inputSave) {
  if (!inputSave) return null;
  const parts = String(inputSave).replaceAll("\\", "/").split("/").filter(Boolean);
  const savesIdx = parts.lastIndexOf("saves");
  if (savesIdx !== -1 && parts[savesIdx + 1]) {
    const raw = parts[savesIdx + 1];
    if (!raw.endsWith(".zip")) return raw;
    return basename(raw, ".zip").replace(/-v\d+$/i, "");
  }
  const base = basename(String(inputSave), ".zip");
  return base === inputSave ? null : base.replace(/-v\d+$/i, "");
}

export class ArtifactGraphStore {
  constructor({ rootDir, graphDir = null, clock = () => new Date(), idGenerator = randomUUID } = {}) {
    if (!rootDir) throw new Error("ArtifactGraphStore requires rootDir");
    this.rootDir = rootDir;
    this.graphDir = graphDir || resolve(rootDir, "state", "graph");
    this.eventsPath = join(this.graphDir, "events.jsonl");
    this.refsPath = join(this.graphDir, "refs.json");
    this.clock = clock;
    this.idGenerator = idGenerator;
  }

  async ensure() {
    await mkdir(this.graphDir, { recursive: true });
  }

  async appendEvent(type, payload = {}) {
    await this.ensure();
    const event = { type, at: nowIso(this.clock), ...payload };
    await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  async readEvents() {
    if (!(await exists(this.eventsPath))) return [];
    const text = await readFile(this.eventsPath, "utf8");
    return text.split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  async readRefs() {
    if (!(await exists(this.refsPath))) return {};
    return JSON.parse(await readFile(this.refsPath, "utf8"));
  }

  async writeRefs(refs) {
    await this.ensure();
    await writeFile(this.refsPath, JSON.stringify(refs, null, 2), "utf8");
  }

  makeRunId(epochId, startedAt = nowIso(this.clock)) {
    return `run_${sanitizeId(epochId)}_${timestampForPath(startedAt)}_${sanitizeId(this.idGenerator()).slice(0, 8)}`;
  }

  makeArtifactId({ epochId, runId, candidateId = null, kind = "artifact" }) {
    const suffix = sanitizeId(this.idGenerator()).slice(0, 8);
    const candidatePart = candidateId ? `_${sanitizeId(candidateId)}` : "";
    return `art_${sanitizeId(epochId)}_${sanitizeId(kind)}_${sanitizeId(runId).slice(0, 48)}${candidatePart}_${suffix}`;
  }

  async createRun({ epoch, parentArtifact = null, parentArtifactId = null, runId = null, runDir = null, startedAt = null } = {}) {
    if (!epoch?.id) throw new Error("createRun requires epoch.id");
    const at = startedAt || nowIso(this.clock);
    const id = runId || this.makeRunId(epoch.id, at);
    const parentId = parentArtifactId || parentArtifact?.artifact_id || parentArtifact?.artifactId || null;
    const event = await this.appendEvent("run_started", {
      run_id: id,
      epoch_id: epoch.id,
      parent_artifact_id: parentId,
      run_dir: runDir,
      started_at: at,
    });
    return { runId: id, run_id: id, epochId: epoch.id, epoch_id: epoch.id, runDir, run_dir: runDir, event };
  }

  async startCandidate({ runId, attempt, candidateDir = null, candidateId = null } = {}) {
    if (!runId) throw new Error("startCandidate requires runId");
    const id = candidateId || `c${Math.max(0, Number(attempt || 1) - 1)}`;
    return this.appendEvent("candidate_started", {
      run_id: runId,
      candidate_id: id,
      attempt,
      candidate_dir: candidateDir,
    });
  }

  async recordPhase({ runId, candidateId = null, phase, ok, path = null, summary = null } = {}) {
    if (!runId) throw new Error("recordPhase requires runId");
    if (!phase) throw new Error("recordPhase requires phase");
    return this.appendEvent("phase_completed", {
      run_id: runId,
      candidate_id: candidateId,
      phase,
      ok: !!ok,
      path,
      summary,
    });
  }

  async recordArtifact({
    artifactId = null,
    kind,
    path,
    epochId,
    runId,
    candidateId = null,
    parentArtifactId = null,
  } = {}) {
    if (!kind) throw new Error("recordArtifact requires kind");
    if (!path) throw new Error("recordArtifact requires path");
    if (!epochId) throw new Error("recordArtifact requires epochId");
    if (!runId) throw new Error("recordArtifact requires runId");
    const id = artifactId || this.makeArtifactId({ epochId, runId, candidateId, kind });
    const event = await this.appendEvent("artifact_created", {
      artifact_id: id,
      kind,
      path,
      epoch_id: epochId,
      run_id: runId,
      candidate_id: candidateId,
      parent_artifact_id: parentArtifactId,
    });
    return { ...event, artifactId: id, artifact_id: id };
  }

  async completeCandidate({ runId, candidateId, ok, verify = null, observe = null, error = null } = {}) {
    if (!runId) throw new Error("completeCandidate requires runId");
    if (!candidateId) throw new Error("completeCandidate requires candidateId");
    return this.appendEvent("candidate_completed", {
      run_id: runId,
      candidate_id: candidateId,
      ok: !!ok,
      verify,
      observe,
      error,
    });
  }

  async completeRun({ runId, ok, selectedCandidateId = null, selectedArtifactId = null, error = null } = {}) {
    if (!runId) throw new Error("completeRun requires runId");
    return this.appendEvent("run_completed", {
      run_id: runId,
      ok: !!ok,
      selected_candidate_id: selectedCandidateId,
      selected_artifact_id: selectedArtifactId,
      error,
    });
  }

  async selectArtifact({ epochId, artifactId } = {}) {
    if (!epochId) throw new Error("selectArtifact requires epochId");
    if (!artifactId) throw new Error("selectArtifact requires artifactId");
    const artifact = await this.getArtifact(artifactId);
    if (!artifact) throw new Error(`artifact not found: ${artifactId}`);
    const ref = `epoch/${epochId}/selected`;
    const refs = await this.readRefs();
    refs[ref] = artifactId;
    await this.writeRefs(refs);
    await this.appendEvent("ref_updated", { ref, artifact_id: artifactId });
    return { ref, artifactId, artifact_id: artifactId };
  }

  resolveArtifactPath(artifact) {
    if (!artifact?.path) return null;
    return resolve(this.rootDir, artifact.path);
  }

  async resolveEpochInput({ epoch, fromArtifactId = null } = {}) {
    if (!epoch) throw new Error("resolveEpochInput requires epoch");
    if (fromArtifactId) {
      const artifact = await this.getArtifact(fromArtifactId);
      if (!artifact) throw new Error(`artifact not found: ${fromArtifactId}`);
      return {
        source: "explicit_artifact",
        artifactId: artifact.artifact_id,
        artifact,
        path: this.resolveArtifactPath(artifact),
      };
    }

    if (epoch.kind === "bootstrap" || !epoch.input_save) {
      return { source: "none", artifactId: null, artifact: null, path: null };
    }

    const refs = await this.readRefs();
    const candidateEpochIds = [
      ...(Array.isArray(epoch.depends_on) ? epoch.depends_on : []),
      inferEpochIdFromInputSave(epoch.input_save),
    ].filter(Boolean);
    for (const epochId of candidateEpochIds) {
      const artifactId = refs[`epoch/${epochId}/selected`];
      if (!artifactId) continue;
      const artifact = await this.getArtifact(artifactId);
      if (!artifact) continue;
      return {
        source: "selected_ref",
        sourceEpochId: epochId,
        artifactId,
        artifact,
        path: this.resolveArtifactPath(artifact),
      };
    }

    return {
      source: "legacy_input_save",
      artifactId: null,
      artifact: null,
      path: resolveInputSave({ rootDir: this.rootDir }, epoch.input_save),
    };
  }

  async getRun(runId) {
    const events = (await this.readEvents()).filter((event) => event.run_id === runId);
    const started = events.find((event) => event.type === "run_started");
    if (!started) return null;
    const completed = events.filter((event) => event.type === "run_completed").at(-1) || null;
    const candidateMap = new Map();
    for (const event of events) {
      if (!event.candidate_id) continue;
      if (!candidateMap.has(event.candidate_id)) {
        candidateMap.set(event.candidate_id, {
          candidate_id: event.candidate_id,
          phases: [],
          artifacts: [],
        });
      }
      const candidate = candidateMap.get(event.candidate_id);
      if (event.type === "candidate_started") {
        candidate.attempt = event.attempt;
        candidate.candidate_dir = event.candidate_dir;
      } else if (event.type === "phase_completed") {
        candidate.phases.push(event);
      } else if (event.type === "artifact_created") {
        candidate.artifacts.push(event);
      } else if (event.type === "candidate_completed") {
        candidate.completed = event;
        candidate.ok = event.ok;
      }
    }
    return {
      ...started,
      ok: completed?.ok ?? null,
      selected_candidate_id: completed?.selected_candidate_id ?? null,
      selected_artifact_id: completed?.selected_artifact_id ?? null,
      completed,
      candidates: [...candidateMap.values()],
      artifacts: events.filter((event) => event.type === "artifact_created"),
      phases: events.filter((event) => event.type === "phase_completed"),
      events,
    };
  }

  async getArtifact(artifactId) {
    if (!artifactId) return null;
    const events = await this.readEvents();
    return events.filter((event) => event.type === "artifact_created" && event.artifact_id === artifactId).at(-1) || null;
  }

  async listEpochRuns(epochId) {
    const starts = (await this.readEvents())
      .filter((event) => event.type === "run_started" && event.epoch_id === epochId);
    return Promise.all(starts.map((event) => this.getRun(event.run_id)));
  }
}
