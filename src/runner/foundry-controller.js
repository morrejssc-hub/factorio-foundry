import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ArtifactGraphStore } from "./artifact-graph.js";
import { loadEpoch } from "./epoch.js";
import { RunController } from "./run-controller.js";

export function topoSort(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set();
  const visiting = new Set();
  const result = [];
  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`cycle in DAG at ${id}`);
    visiting.add(id);
    const node = byId.get(id);
    if (!node) throw new Error(`DAG references missing node: ${id}`);
    for (const dep of (node.depends_on || [])) visit(dep);
    visiting.delete(id);
    visited.add(id);
    result.push(node);
  }
  for (const node of nodes) visit(node.id);
  return result;
}

export function filterRange(ordered, fromId, toId) {
  const fromIdx = fromId ? ordered.findIndex((node) => node.id === fromId) : 0;
  const toIdx = toId ? ordered.findIndex((node) => node.id === toId) : ordered.length - 1;
  if (fromId && fromIdx === -1) throw new Error(`--from epoch "${fromId}" not found in DAG`);
  if (toId && toIdx === -1) throw new Error(`--to epoch "${toId}" not found in DAG`);
  if (fromIdx > toIdx) throw new Error(`--from "${fromId}" comes after --to "${toId}" in topological order`);
  return ordered.slice(fromIdx, toIdx + 1);
}

export async function loadDag(rootDir) {
  const path = resolve(rootDir, "epochs", "dag.yaml");
  const dag = parseYaml(await readFile(path, "utf8"));
  return { path, dag };
}

export class FoundryController {
  constructor({ config, factorio = null, graph = null, runController = null, log = console.log } = {}) {
    if (!config?.rootDir) throw new Error("FoundryController requires config.rootDir");
    this.config = config;
    this.factorio = factorio;
    this.graph = graph || new ArtifactGraphStore({ rootDir: config.rootDir });
    this.runController = runController || new RunController({
      config,
      factorio,
      graph: this.graph,
      log,
    });
    this.log = log;
  }

  async loadEpoch(epochId) {
    return loadEpoch(resolve(this.config.rootDir, "epochs"), epochId);
  }

  async selectedArtifact(epochId) {
    const refs = await this.graph.readRefs();
    const artifactId = refs[`epoch/${epochId}/selected`];
    return artifactId ? this.graph.getArtifact(artifactId) : null;
  }

  async resolveEpochInput({ epoch, fromArtifactId = null } = {}) {
    return this.graph.resolveEpochInput({ epoch, fromArtifactId });
  }

  async planDag({ from = null, to = null, fromArtifactId = null } = {}) {
    const { dag } = await loadDag(this.config.rootDir);
    const ordered = topoSort(dag.nodes || []);
    let effectiveFrom = from;
    if (fromArtifactId && !effectiveFrom) {
      const artifact = await this.graph.getArtifact(fromArtifactId);
      if (!artifact) throw new Error(`artifact not found: ${fromArtifactId}`);
      const artifactIdx = ordered.findIndex((node) => node.id === artifact.epoch_id);
      if (artifactIdx === -1) throw new Error(`artifact epoch not found in DAG: ${artifact.epoch_id}`);
      const next = ordered[artifactIdx + 1];
      if (!next) throw new Error(`artifact ${fromArtifactId} is already at the end of the DAG; pass --from explicitly to rerun an epoch`);
      effectiveFrom = next.id;
    }
    const nodes = filterRange(ordered, effectiveFrom, to);
    const steps = [];
    for (const [index, node] of nodes.entries()) {
      const epoch = await this.loadEpoch(node.id);
      const input = await this.graph.resolveEpochInput({
        epoch,
        fromArtifactId: index === 0 ? fromArtifactId : null,
      });
      const selected = await this.selectedArtifact(node.id);
      steps.push({
        id: node.id,
        epoch,
        input,
        selectedArtifact: selected,
        selectedArtifactId: selected?.artifact_id ?? null,
      });
    }
    return { dag, steps };
  }

  async runEpoch({ epochId, epoch = null, fromArtifactId = null } = {}) {
    const loaded = epoch || await this.loadEpoch(epochId);
    return this.runController.runEpoch({ epoch: loaded, fromArtifactId });
  }

  async runDag({ from = null, to = null, fromArtifactId = null, force = false, dryRun = false } = {}) {
    const plan = await this.planDag({ from, to, fromArtifactId });
    if (dryRun) return { ...plan, dryRun: true, results: [] };

    const results = [];
    const resumeRun = !!fromArtifactId;
    for (const [index, step] of plan.steps.entries()) {
      const selected = await this.selectedArtifact(step.id);
      if (!force && !resumeRun && selected) {
        results.push({ id: step.id, status: "skipped", selectedArtifactId: selected.artifact_id });
        continue;
      }
      const result = await this.runEpoch({
        epoch: step.epoch,
        fromArtifactId: index === 0 ? fromArtifactId : null,
      });
      results.push({ id: step.id, status: result.ok ? "pass" : "fail", result });
      if (!result.ok) break;
    }
    return { ...plan, dryRun: false, results };
  }

  async selectArtifact({ epochId, artifactId } = {}) {
    return this.graph.selectArtifact({ epochId, artifactId });
  }

  async resume({ artifactId, toEpochId } = {}) {
    if (!toEpochId) throw new Error("resume requires toEpochId");
    return this.runDag({ from: toEpochId, to: toEpochId, fromArtifactId: artifactId, force: true });
  }
}
