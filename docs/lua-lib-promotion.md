# Lua Library Promotion

Designer scratch (raw Lua submitted via `factorio_read`) and the formal
shared library (`lib/lua-lib/`) are deliberately separated. Scratch is
exploration; library is contract. This doc describes the data we collect
and the (not-yet-built) flow from one to the other.

## What's wired today

### Sandbox preamble
`lib/lua-lib/*.lua` is concatenated (sorted by filename) and prepended to
every script the designer submits via `/tool/foundry_probe`. The combined
script then passes through the read-only validator
(`READ_ONLY_FORBIDDEN` in `src/factorio-server.js`) before execution.

Files in this dir MUST define top-level Lua functions or a returned
module — not standalone `return ...` scripts (those belong in
`lib/probes/`). The library is intentionally empty at the start; it
grows from real evidence, not speculation.

Loader: `src/lua-lib.js` (`getLuaLibPreamble(workspaceDir)`), cached per
workspace; restart the foundry service to pick up new files.

### Evidence collection
The `foundry-read` pi extension appends one record to
`<run-dir>/design/probe-calls.jsonl` per `factorio_read` call:

```json
{"ts": "...", "script_path": "...", "lua": "...", "params": {...},
 "ok": true, "elapsed_ms": 123}
```

The append is best-effort and runs in a `finally` block — log failure
never fails the probe.

### Scanner
```
node src/runner/scan-evidence.js <run-dir>
```
Reads `<run-dir>/design/probe-calls.jsonl`, clusters records by Jaccard
similarity (≥0.6) on normalized Lua tokens (string literals → `"S"`,
numerics → `N`, comments stripped), and writes `<run-dir>/evidence.json`.
Each cluster reports `call_count`, `script_paths`, `param_samples`,
`sample_lua`, and a coarse `constant_lines` / `variable_line_groups`
count to hint at what's parameter-like vs. structural.

## Intended promotion flow (not built)

1. Inspect `evidence.json` across multiple real runs.
2. Manually identify clusters whose pattern is genuinely reusable
   (general primitive vs. one-off task query).
3. Open a PR adding a hand-written, parameterized function to
   `lib/lua-lib/`. This is a **rewrite**, not a copy of scratch — the
   PR description references the source `evidence.json` clusters as
   evidence of demand, but the API is designed fresh.
4. Review focuses on API design (naming, parameter shape, error modes,
   abstraction level), not just "did this appear N times".

The point of keeping this manual: auto-promotion would conflate scratch
(exploration) with library (contract).

## TODO (verify as evidence accumulates)

- [ ] Run more epochs (e2–e8 across models) and accumulate
      `evidence.json` outputs. Look for clusters that recur across
      multiple runs, not just within one.
- [ ] Add a cross-run aggregator (e.g. `scan-evidence.js --aggregate
      plans/*`) once we have ≥5 runs worth of data — single-run
      clusters are noisy.
- [ ] Decide on a similarity-threshold sweet spot. 0.6 is a guess;
      tune after seeing real data (too high → siblings split, too low
      → semantically distinct queries merged).
- [ ] First real promotion: when a cluster shows up in ≥2 epochs with
      stable structure, draft an RFC PR by hand and use it to
      pressure-test this doc.
- [ ] Watch for false negatives: scratch that looks unique per call
      but is actually the same logic with different hardcoded values.
      The Jaccard tokenizer already normalizes numbers/strings, but
      may need AST-level analysis if the false-negative rate is high.
- [ ] Decide whether the preamble being part of the read-only
      validator's input causes issues once `lib/lua-lib/` has real
      content (e.g. a forbidden token in a comment will be stripped,
      but a forbidden token in an unused helper function will trip
      the validator). Currently moot — library is empty.
