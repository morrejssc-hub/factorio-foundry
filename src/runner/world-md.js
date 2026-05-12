// world-md.js — read/write the cross-epoch agent notebook at state/world.md.
//
// world.md is mostly free-form prose for the agent to annotate. The only
// machine-read section is a single yaml fence under "## Deployed modules"
// that lists every module instance that has been successfully placed:
//   - id: p0
//     module: iron-smelt-line
//     anchor: { x: -78, y: -66 }
//     direction: north
//     epoch: e2
//
// Runner appends to the fence after a successful execute and removes
// entries when plan.yaml carries module_decommissions: [<id>, ...]. The
// rest of the markdown — buffer/overflow notes, stockpile intent, open
// puzzles — is purely for Designer/repair-agent context and is left
// untouched by code.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";

const FENCE_HEADER = "## Deployed modules";
const FENCE_OPEN = "```yaml";
const FENCE_CLOSE = "```";

// Machine-managed scaffolding — header + empty fence. Used both to seed a
// brand-new world.md and to auto-heal an existing file whose scaffolding
// has been clobbered (agents have a long history of overwriting world.md
// while leaving the prose intact).
const SCAFFOLDING = `# World notes

A running journal of what's been built across the epoch chain. The
\`## Deployed modules\` block below has a yaml fence — runner appends
to it after each successful execute and removes entries when plan.yaml
carries \`module_decommissions: [<id>, ...]\`. Everything outside that
fence is for agents to read and edit freely.

${FENCE_HEADER}

<!-- machine-managed: do not edit by hand; the runner rewrites this fence -->

${FENCE_OPEN}
[]
${FENCE_CLOSE}
`;

const DEFAULT_NOTES = `
## Buffer & overflow notes

(empty)

## Stockpile intent

(empty)

## Open puzzles

(empty)
`;

const TEMPLATE = SCAFFOLDING + DEFAULT_NOTES;

export function worldMdPath(config) {
  return resolve(config.rootDir, "state/world.md");
}

/**
 * Locate the deployed-modules fence in raw markdown.
 * Returns indices for surgical replacement and the parsed entries.
 * Throws if the document is malformed (header missing, no fence, or
 * fence has no matching close).
 */
export function locateFence(rawText) {
  const headerIdx = rawText.indexOf(FENCE_HEADER);
  if (headerIdx === -1) {
    throw new Error(`world.md missing "${FENCE_HEADER}" header`);
  }
  const openIdx = rawText.indexOf(FENCE_OPEN, headerIdx);
  if (openIdx === -1) {
    throw new Error(`world.md "${FENCE_HEADER}" has no opening fence`);
  }
  const contentStart = openIdx + FENCE_OPEN.length + 1; // +1 for newline
  const closeIdx = rawText.indexOf(`\n${FENCE_CLOSE}`, contentStart);
  if (closeIdx === -1) {
    throw new Error(`world.md "${FENCE_HEADER}" fence has no closing \`\`\``);
  }
  const yamlBody = rawText.slice(contentStart, closeIdx);
  let parsed = [];
  try {
    parsed = parseYaml(yamlBody) ?? [];
  } catch (e) {
    throw new Error(`world.md fence yaml parse failed: ${e.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`world.md fence must be a yaml sequence, got ${typeof parsed}`);
  }
  return { entries: parsed, contentStart, contentEnd: closeIdx };
}

/**
 * Reads world.md, creating it from the template on first access.
 * Auto-heals existing files whose scaffolding (header / fence) has been
 * lost — prepends SCAFFOLDING and persists, preserving any prose below.
 */
export async function readWorldMd(path) {
  let rawText;
  try {
    rawText = await readFile(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, TEMPLATE, "utf8");
      rawText = TEMPLATE;
    } else {
      throw e;
    }
  }
  try {
    const fence = locateFence(rawText);
    return { rawText, entries: fence.entries };
  } catch (e) {
    if (!/missing.*header|has no opening fence|fence has no closing/i.test(e.message)) {
      throw e;
    }
    // Heal: prepend the machine-managed scaffolding (header + empty fence)
    // to whatever prose exists. The original content moves below the fence
    // and stays intact; no agent edits are lost.
    const healed = SCAFFOLDING + (rawText.startsWith("\n") ? rawText : "\n" + rawText);
    await writeFile(path, healed, "utf8");
    const fence = locateFence(healed);
    return { rawText: healed, entries: fence.entries };
  }
}

/**
 * Replaces the fence content with `entries` (full rewrite).
 * Pure function; no I/O.
 */
export function rewriteFence(rawText, entries) {
  const fence = locateFence(rawText);
  const yamlBody = entries.length
    ? stringifyYaml(entries).trimEnd()
    : "[]";
  return rawText.slice(0, fence.contentStart) +
         yamlBody + "\n" +
         rawText.slice(fence.contentEnd + 1); // +1 to skip the leading \n we matched
}

/**
 * Append a new deployed-module entry. Throws on duplicate id.
 * Returns the updated full markdown text.
 */
export function appendEntry(rawText, entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error("appendEntry: entry must be an object");
  }
  if (!entry.id) throw new Error("appendEntry: entry.id is required");
  const fence = locateFence(rawText);
  if (fence.entries.some((e) => e.id === entry.id)) {
    throw new Error(`appendEntry: id "${entry.id}" already present in fence`);
  }
  return rewriteFence(rawText, [...fence.entries, entry]);
}

/**
 * Remove entries by id. Returns updated text and the removed list.
 * Unknown ids are reported in `missing` (not thrown — runner decides).
 */
export function removeEntries(rawText, ids) {
  const fence = locateFence(rawText);
  const toRemove = new Set(ids);
  const kept = [];
  const removed = [];
  for (const e of fence.entries) {
    if (toRemove.has(e.id)) removed.push(e);
    else kept.push(e);
  }
  const removedIds = new Set(removed.map((e) => e.id));
  const missing = ids.filter((id) => !removedIds.has(id));
  return { text: rewriteFence(rawText, kept), removed, missing };
}

/**
 * Convenience: read, append, write. Used by epoch.js after success.
 */
export async function appendDeployedModule(path, entry) {
  const { rawText } = await readWorldMd(path);
  const updated = appendEntry(rawText, entry);
  await writeFile(path, updated, "utf8");
  return entry;
}

/**
 * Convenience: read, remove ids, write. Used by epoch.js for
 * module_decommissions handling.
 */
export async function removeDeployedModules(path, ids) {
  const { rawText } = await readWorldMd(path);
  const { text, removed, missing } = removeEntries(rawText, ids);
  await writeFile(path, text, "utf8");
  return { removed, missing };
}
