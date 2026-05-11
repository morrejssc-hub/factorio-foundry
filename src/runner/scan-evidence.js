#!/usr/bin/env node
/**
 * scan-evidence: post-hoc analysis of designer factorio_read calls.
 *
 * Reads <run-dir>/design/probe-calls.jsonl, clusters call records by Lua
 * text similarity (Jaccard on normalized token sets), and writes
 * <run-dir>/evidence.json. Each cluster is a candidate "the designer
 * repeatedly asked about the same thing" — useful as raw input for a
 * future RFC, NOT as auto-promotion to lib/lua-lib/.
 *
 * Usage: node src/runner/scan-evidence.js <run-dir>
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exists } from "../fs-util.js";

const SIMILARITY_THRESHOLD = 0.6;

function tokenize(lua) {
  const stripped = lua
    .replace(/--\[\[[\s\S]*?\]\]/g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, '"S"')
    .replace(/'(?:[^'\\]|\\.)*'/g, '"S"')
    .replace(/-?\d+(?:\.\d+)?/g, "N");
  const tokens = stripped.match(/[A-Za-z_][A-Za-z0-9_]*|[+\-*/=<>!~%^&|]+|[(){}\[\],.;:]/g) || [];
  return new Set(tokens);
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const tok of a) if (b.has(tok)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function variableLines(samples) {
  const lineSets = samples.map((s) => s.split("\n"));
  const minLen = Math.min(...lineSets.map((s) => s.length));
  const constant = [];
  const variable = [];
  for (let i = 0; i < minLen; i++) {
    const first = lineSets[0][i];
    const allSame = lineSets.every((s) => s[i] === first);
    if (allSame) constant.push(first);
    else variable.push(lineSets.map((s) => s[i]));
  }
  return { constant_lines: constant.length, variable_line_groups: variable.length };
}

async function readJsonl(path) {
  const text = await readFile(path, "utf8");
  const records = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return records;
}

function cluster(records) {
  const items = records.map((r) => ({ record: r, tokens: tokenize(r.lua || "") }));
  const clusters = [];
  for (const item of items) {
    let placed = false;
    for (const c of clusters) {
      if (jaccard(item.tokens, c.tokens) >= SIMILARITY_THRESHOLD) {
        c.members.push(item.record);
        // expand the cluster's representative tokens (union)
        for (const tok of item.tokens) c.tokens.add(tok);
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push({ tokens: new Set(item.tokens), members: [item.record] });
    }
  }
  return clusters;
}

export function summarize(clusters) {
  return clusters
    .map((c, idx) => {
      const samples = [];
      const pathsSet = new Set();
      const params = [];
      for (const m of c.members) {
        samples.push(m.lua || "");
        if (m.script_path) pathsSet.add(m.script_path);
        params.push(m.params || {});
      }
      return {
        cluster_id: idx,
        call_count: c.members.length,
        script_paths: Array.from(pathsSet),
        param_samples: params.slice(0, 5),
        sample_lua: samples[0] || "",
        ...variableLines(samples),
      };
    })
    .sort((a, b) => b.call_count - a.call_count);
}

async function main() {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error("usage: node src/runner/scan-evidence.js <run-dir>");
    process.exit(2);
  }
  const abs = resolve(runDir);
  const callsPath = join(abs, "design", "probe-calls.jsonl");
  if (!(await exists(callsPath))) {
    console.error(`no probe-calls.jsonl at ${callsPath}`);
    process.exit(1);
  }
  const records = await readJsonl(callsPath);
  const clusters = cluster(records);
  const summary = summarize(clusters);
  const out = {
    run_dir: abs,
    total_calls: records.length,
    cluster_count: summary.length,
    similarity_threshold: SIMILARITY_THRESHOLD,
    clusters: summary,
  };
  const outPath = join(abs, "evidence.json");
  await writeFile(outPath, JSON.stringify(out, null, 2));
  console.log(`wrote ${outPath} (${records.length} calls → ${summary.length} clusters)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
