#!/usr/bin/env node
// scripts/run-summary.js — CLI: render <runDir>/summary.md from run-meta.json
// (or via fallback scan when meta is absent). Useful for re-rendering older
// runs after the summary template changes.
import { resolve } from "node:path";
import { writeSummary } from "../src/runner/run-summary.js";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: node scripts/run-summary.js <runDir>");
  process.exit(2);
}
const runDir = resolve(arg);
const { meta, markdownPath } = await writeSummary(runDir);
console.log(`wrote ${markdownPath}`);
console.log(`epoch=${meta.epoch ?? "(unknown)"} ok=${meta.ok} attempts=${meta.actual_attempts}/${meta.max_attempts} cost=$${(meta.totals.cost_usd ?? 0).toFixed(4)}`);
