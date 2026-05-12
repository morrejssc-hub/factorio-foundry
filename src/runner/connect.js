// connect.js — post-verify connection synthesizer.
//
// After verify selects a winner, scan the plan's input ports and try to
// auto-wire each unbound `kind: belt` input to a deployed module's matching
// belt output. Mirrors the existing power auto-route loop in execute.js:337
// (which handles unbound `kind: power` inputs the same way), but for belt
// inputs sourcing from world.md's deployed-modules fence.
//
// Pure JS. No Factorio I/O. The caller (epoch.js's replayObserveExport)
// invokes this before applyCandidate so the synthesized connection entries
// flow through the existing routeConnections path naturally — no new
// placement code is added. The world-placement map returned alongside the
// synthesized connections is what lets routeConnections resolve a `from`
// ref that names a deployed module instead of one in plan.placements.
//
// Matching rule: for each unbound `kind: belt` input port on this plan's
// placements, find every deployed module (lib + world.md fence) whose
// `outputs[]` contains a `kind: belt` port with the same `item`. Pick the
// nearest by Manhattan distance between input port and output port world
// positions. Zero matches → decision `needs_upstream`; non-belt input
// kinds (pipe, retired inventory, ...) → decision `kind_not_supported`.

import { resolvePortWorldPos } from "./execute.js";

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function isInputBound(plan, placementId, portName) {
  const ref = `${placementId}.${portName}`;
  return (plan?.connections || []).some((c) => c?.to === ref);
}

/**
 * Enumerate matching belt outputs across the world's deployed modules.
 *
 * @returns {Array<{ entry, module, port, worldPos }>}
 */
function findBeltOutputCandidates({ item, worldEntries, modules }) {
  const out = [];
  for (const entry of (worldEntries || [])) {
    const module = modules?.get?.(entry.module);
    if (!module) continue;
    for (const port of (module.outputs || [])) {
      if (port.kind !== "belt") continue;
      if (port.item !== item) continue;
      const worldPos = resolvePortWorldPos(entry, module, port.name);
      if (!worldPos) continue;
      out.push({ entry, module, port, worldPos });
    }
  }
  return out;
}

/**
 * Build the synthesized connection list for unbound input ports on this
 * plan's placements. The `added` array is intended to be appended to
 * plan.connections before applyCandidate runs; `worldPlacements` is the
 * companion map of {id → entry} that routeConnections consults when a
 * connection's `from` references a deployed module not in plan.placements.
 *
 * @param {object} args
 * @param {object} args.plan               — plan.yaml object (read-only)
 * @param {Map<string, object>} args.modules — lib + staged module map
 * @param {Array<object>} args.worldEntries — world.md fence entries
 * @returns {{
 *   added: Array<{from: string, to: string, required_throughput: number, _synthesized: true}>,
 *   decisions: Array<object>,
 *   worldPlacements: Map<string, object>,
 * }}
 */
export function synthesizeConnections({ plan, modules, worldEntries }) {
  const added = [];
  const decisions = [];
  const worldPlacements = new Map();

  for (const placement of (plan?.placements || [])) {
    const module = modules?.get?.(placement.module);
    if (!module) {
      decisions.push({
        kind: "module_not_found",
        placement: placement.id,
        module_id: placement.module,
      });
      continue;
    }
    for (const port of (module.inputs || [])) {
      // power is handled deterministically by execute.js's auto-power loop;
      // we don't touch it here.
      if (port.kind === "power") continue;

      const inputRef = `${placement.id}.${port.name}`;
      if (isInputBound(plan, placement.id, port.name)) {
        decisions.push({
          kind: "already_bound",
          input: inputRef,
          port_kind: port.kind,
        });
        continue;
      }

      if (port.kind !== "belt") {
        decisions.push({
          kind: "kind_not_supported",
          input: inputRef,
          port_kind: port.kind,
          reason: "auto-routing only supports kind: belt inputs in this iteration",
        });
        continue;
      }

      const inputPos = resolvePortWorldPos(placement, module, port.name);
      if (!inputPos) {
        decisions.push({
          kind: "input_position_unresolved",
          input: inputRef,
        });
        continue;
      }

      const candidates = findBeltOutputCandidates({
        item: port.item,
        worldEntries,
        modules,
      });

      if (candidates.length === 0) {
        decisions.push({
          kind: "needs_upstream",
          input: inputRef,
          item: port.item,
          reason: `no deployed module exposes ${port.item} as a belt output`,
        });
        continue;
      }

      // Pick nearest by Manhattan distance.
      let best = candidates[0];
      let bestDist = manhattan(inputPos, best.worldPos);
      for (let i = 1; i < candidates.length; i++) {
        const d = manhattan(inputPos, candidates[i].worldPos);
        if (d < bestDist) {
          best = candidates[i];
          bestDist = d;
        }
      }

      const fromRef = `${best.entry.id}.${best.port.name}`;
      added.push({
        from: fromRef,
        to: inputRef,
        required_throughput: port.throughput ?? 0,
        _synthesized: true,
      });
      worldPlacements.set(best.entry.id, best.entry);
      decisions.push({
        kind: "connect",
        input: inputRef,
        from: fromRef,
        item: port.item,
        distance: bestDist,
        candidates_considered: candidates.length,
      });
    }
  }

  return { added, decisions, worldPlacements };
}
