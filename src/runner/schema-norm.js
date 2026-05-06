// schema-norm.js — phase-output normalizer.
//
// Each phase (probe, design) declares a tiny schema:
//   { required: [string], optional: { name: defaultValue }, wrappers: [string],
//     aliases: { wrongName: rightName } }
//
// `normalize(parsed, schema)` runs in three stages:
//
//   1. Wrapper unwrap. If `parsed` doesn't carry any required field at the
//      top level but `parsed.<wrapper>` does, the inner mapping is hoisted.
//      Absorbs Pattern B drift (LLM nests everything under a single
//      namespacing dict like `probe:` or `findings:`).
//
//   2. Classify-and-relocate. For every top-level key:
//        - REQUIRED or declared OPTIONAL → kept at its position
//        - "extra" → merged into normalized.extra
//        - anything else → moved to normalized.extra.<key> + warning
//      Absorbs Pattern C drift (LLM adds metadata fields like
//      placement_validation, selected_module, baseline_production_*) without
//      forcing a retry. Optional fields receive declared defaults so callers
//      can rely on `normalized.<optional>` always existing.
//
//   3. Required check. Missing required fields → errors (caller decides
//      whether to retry or fail). For known near-miss aliases (e.g.
//      `coal_patch` singular instead of `coal_patches`), the error message
//      includes a "did you mean" hint so the retry feedback is focused.
//
// Pattern A drift (LLM treats plan.yaml as a runbook with steps/risks and
// no placements) is NOT auto-corrected here — it surfaces as missing
// required fields and triggers a normal retry. Auto-promoting top-level
// `module`/`anchor` to a synthesized `placements[0]` would require guessing
// LLM intent, so the conservative move is to let the retry path handle it.

function tryUnwrap(parsed, wrappers, requiredFields) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  // If parsed already carries any required field, don't unwrap — even
  // partial flat output is preferred to a wrapper rescue (which might pick
  // the wrong inner if LLM split content across the top and a wrapper).
  if (requiredFields.some((f) => f in parsed)) return parsed;
  for (const w of wrappers) {
    const inner = parsed[w];
    if (inner && typeof inner === "object" && !Array.isArray(inner)
        && requiredFields.some((f) => f in inner)) {
      return inner;
    }
  }
  return parsed;
}

function deepClone(value) {
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * @param {object} parsed   — yaml-parsed top-level value
 * @param {object} schema   — { required, optional, wrappers, aliases }
 * @returns {{normalized: object|null, errors: string[], warnings: string[], unwrapped: boolean}}
 */
export function normalize(parsed, schema) {
  const warnings = [];
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      normalized: null,
      errors: ["yaml document must be a top-level mapping"],
      warnings,
      unwrapped: false,
    };
  }

  const required = schema.required || [];
  const optional = schema.optional || {};
  const wrappers = schema.wrappers || [];
  const aliases = schema.aliases || {};

  const unwrappedSource = tryUnwrap(parsed, wrappers, required);
  const unwrapped = unwrappedSource !== parsed;
  if (unwrapped) warnings.push(`auto-unwrapped from a top-level wrapper key`);

  const allowed = new Set([...required, ...Object.keys(optional), "extra"]);

  // Stage 2: seed defaults, then classify keys.
  const normalized = {};
  for (const [name, def] of Object.entries(optional)) {
    normalized[name] = deepClone(def);
  }
  if (!("extra" in normalized)) normalized.extra = {};

  for (const [key, value] of Object.entries(unwrappedSource)) {
    if (key === "extra") {
      const merged = (value && typeof value === "object" && !Array.isArray(value))
        ? value
        : { _malformed_extra: value };
      normalized.extra = { ...normalized.extra, ...merged };
      continue;
    }
    if (allowed.has(key)) {
      normalized[key] = value;
      continue;
    }
    normalized.extra[key] = value;
    warnings.push(`relocated unknown top-level key "${key}" → extra.${key}`);
  }

  // Stage 3: required check + alias hinting.
  const errors = [];
  for (const r of required) {
    if (!(r in normalized)) {
      // Look for a near-miss key whose target is r and which we just
      // relocated to extra. Add a hint to the retry message.
      let hint = "";
      for (const [wrong, right] of Object.entries(aliases)) {
        if (right === r && normalized.extra && wrong in normalized.extra) {
          hint = ` (you wrote "${wrong}" — did you mean "${r}"? note the schema requires the plural-array form)`;
          break;
        }
      }
      errors.push(`missing required field: ${r}${hint}`);
    }
  }

  return { normalized, errors, warnings, unwrapped };
}

// ---- Phase schemas ----

export const STATE_SCHEMA = {
  required: ["tick", "worker", "inventory_summary", "coal_patches", "iron_patches"],
  optional: { notes: "", extra: {} },
  wrappers: ["probe", "state", "result", "data", "output", "findings"],
  aliases: {
    coal_patch: "coal_patches",
    iron_patch: "iron_patches",
    inventory: "inventory_summary",
  },
};

export const PLAN_SCHEMA = {
  required: ["epoch", "placements", "connections", "expected_throughput", "why_not_replicate"],
  optional: { extra: {} },
  wrappers: ["plan", "design", "result", "data", "output"],
  aliases: {},
};
