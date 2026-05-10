// run-layout.js — centralized path computation for the epoch × candidate
// directory structure introduced in Phase A.
//
// Canonical layouts:
//   plans/<epoch.id>-<runTs>/
//     probe/
//     candidates/
//       c0/ { design/, execute/, staged-modules/, dry-validate.json }
//       c1/ ...
//     manifest.json
//     run-meta.json
//     designer-history.md
//
//   state/saves/<epoch.id>/
//     <runTs>-c0.zip    (candidate save, GC'd if not winner)
//     winner.zip        (promoted from winning candidate)

import { join, resolve } from "node:path";
import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";

export function candidateId(n) {
  return `c${n}`;
}

export function candidateDir(runDir, cid) {
  return join(runDir, "candidates", cid);
}

export function epochSaveDir(config, epochId) {
  return resolve(config.rootDir, "state", "saves", epochId);
}

export function runSavePath(saveDir, runTs, cid) {
  return join(saveDir, `${runTs}-${cid}.zip`);
}

export function winnerSavePath(saveDir) {
  return join(saveDir, "winner.zip");
}

// Resolve input_save field from epoch spec.
// - If the value ends with ".zip" → literal file path (backward compat).
// - Otherwise (directory form, e.g. "state/saves/e1-first-coal/") → winner.zip inside.
export function resolveInputSave(config, inputSave) {
  if (!inputSave) return null;
  const abs = resolve(config.rootDir, inputSave);
  if (inputSave.endsWith(".zip")) return abs;
  return join(abs, "winner.zip");
}

export async function promoteWinner(candidateSavePath, winnerPath) {
  await mkdir(resolve(winnerPath, ".."), { recursive: true });
  await copyFile(candidateSavePath, winnerPath);
}

export async function writeManifest(runDir, data) {
  await writeFile(
    join(runDir, "manifest.json"),
    JSON.stringify(data, null, 2),
    "utf8",
  );
}

export async function readManifest(runDir) {
  try {
    return JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}
