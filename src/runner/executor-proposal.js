// executor-proposal.js — structured failure records emitted by execute.js
// when placement or connection irrecoverably fails. The record is written
// to <executeOut>/proposal.json; epoch.js attaches it to previousAttempts
// so the next design retry sees a focused recommendation instead of a
// raw error string. Designer prompt has a section "Reading executor_proposal
// in TASK HISTORY" that tells the LLM how to consume these.
//
// Root-cause classification is keyword-based against the error message
// (the Factorio service does not surface structured error codes today).
// Imperfect but useful — the raw message is preserved in extra.raw_error
// so the LLM has the full context if heuristics misfire.

const COLLISION_KEYWORDS = ["collision", "occupied", "blocked", "in the way", "obstruct", "overlap"];
const RESOURCE_KEYWORDS  = ["resource", "no ore", "patch", "no coal", "no iron", "no copper", "no stone"];
const BLUEPRINT_KEYWORDS = ["malformed blueprint", "invalid blueprint", "unknown entity", "bad direction"];
const PATH_KEYWORDS      = ["no path", "unreachable", "no_path", "route_belt failed"];

function classifyRootCause(errorMessage) {
  const msg = (errorMessage || "").toLowerCase();
  if (PATH_KEYWORDS.some((kw)      => msg.includes(kw))) return "no_belt_path";
  if (COLLISION_KEYWORDS.some((kw) => msg.includes(kw))) return "collision_with_existing";
  if (BLUEPRINT_KEYWORDS.some((kw) => msg.includes(kw))) return "blueprint_invalid";
  if (RESOURCE_KEYWORDS.some((kw)  => msg.includes(kw))) return "missing_resource";
  return "rcon_error";
}

function suggestedChangesForPlacement(rootCause) {
  switch (rootCause) {
    case "collision_with_existing":
      return [
        { type: "shift", offset: { dx: 4, dy: 0 }, rationale: "try shifting east of the blocker" },
        { type: "shift", offset: { dx: 0, dy: 4 }, rationale: "or shift south" },
        { type: "shift", offset: { dx: -4, dy: 0 }, rationale: "or shift west" },
      ];
    case "missing_resource":
      return [
        { type: "swap_module", rationale: "this module's preconditions aren't satisfied at this anchor; pick a different module or move to a verified patch from state.yaml" },
      ];
    case "blueprint_invalid":
      return [
        { type: "swap_module", rationale: "the (likely staged) module's blueprint geometry may be wrong; switch to a lib module or re-author with corrected dx/dy" },
      ];
    case "no_belt_path":
      return [
        { type: "rearrange_placements", rationale: "the access channel to this placement is blocked; shift neighbouring placements to open a corridor" },
      ];
    default:
      return [];
  }
}

function suggestedChangesForConnection(rootCause) {
  if (rootCause === "no_belt_path") {
    return [
      { type: "rearrange_placements", rationale: "the inter-region path is blocked; shift the placements that bound the channel" },
      { type: "use_underground", rationale: "consider modules whose port supports underground belt for routing through obstacles" },
    ];
  }
  return [];
}

/**
 * Build a structured failure record for a placement failure.
 * @param {number} failedStep — index in plan.placements (-1 if not applicable)
 * @param {object} placement
 * @param {Error} error
 * @returns {object}
 */
export function buildPlacementProposal(failedStep, placement, error) {
  const rootCause = classifyRootCause(error.message);
  return {
    failed_step: failedStep,
    failed_entity: {
      item: placement.module,
      position: placement.anchor,
      direction: placement.direction,
    },
    root_cause: rootCause,
    suggested_changes: suggestedChangesForPlacement(rootCause),
    extra: {
      raw_error: error.message,
      payload: error.payload ?? null,
      placement_id: placement.id,
    },
  };
}

/**
 * Build a structured failure record for a belt connection failure.
 * @param {object|null} conn — plan.connections entry {from, to, required_throughput}
 * @param {Error} error
 * @returns {object}
 */
export function buildConnectionProposal(conn, error) {
  const rootCause = classifyRootCause(error.message);
  return {
    failed_step: -1,
    failed_entity: null,
    root_cause: rootCause,
    suggested_changes: suggestedChangesForConnection(rootCause),
    extra: {
      connection: conn
        ? { from: conn.from, to: conn.to, required_throughput: conn.required_throughput }
        : null,
      raw_error: error.message,
    },
  };
}

/**
 * Build a structured failure record for a power-coverage check failure.
 * Diagnostic fields from port-power-check.lua flow into extra.diagnostic
 * so the designer prompt can read concrete distances instead of guessing.
 */
export function buildPowerProposal({ placement, portName, diagnostic }) {
  const portHasUpstream = diagnostic?.summary?.port_has_upstream_power;
  const uncovered = Array.isArray(diagnostic?.uncovered) ? diagnostic.uncovered : [];
  const rootCause = !portHasUpstream
    ? "power_port_isolated_from_grid"
    : "power_entity_off_port_network";

  const suggestions = [];
  if (rootCause === "power_port_isolated_from_grid") {
    suggestions.push({
      type: "shift",
      rationale: `module's power_in port at ${JSON.stringify(diagnostic?.port_pole?.position)} created a new (unpowered) electric network — move the anchor so the port_pole falls within wire reach of an existing energized pole, or add intermediate poles via plan.connections`,
    });
  } else {
    for (const u of uncovered) {
      const np = u.nearest_pole_on_port_network;
      if (np) {
        suggestions.push({
          type: "add_intermediate_pole",
          rationale: `entity ${u.id} (${u.entity_name || "?"}) at ${JSON.stringify(u.position)} is on a different electric network from the module's port_pole; nearest pole on the port network is ${JSON.stringify(np.position)} at distance ${np.distance?.toFixed(2)}`,
        });
      } else {
        suggestions.push({
          type: "review_blueprint",
          rationale: `entity ${u.id} (${u.entity_name || "?"}) at ${JSON.stringify(u.position)} not on the port_pole's network and no port-network pole nearby — blueprint may be missing internal poles`,
        });
      }
    }
  }

  return {
    failed_step: -1,
    failed_entity: {
      item: placement.module,
      position: placement.anchor,
      direction: placement.direction,
    },
    root_cause: rootCause,
    suggested_changes: suggestions,
    extra: {
      placement_id: placement.id,
      port_name: portName,
      diagnostic,
    },
  };
}
