# TODO — deferred work, not blocking the current chain

This is the single forward-looking doc. Everything here is intentionally deferred; promote items to a real plan when ready to act.

## Sequential vs parallel feedback parity

**What.** `runCompositionEpoch` (sequential) accumulates `previousAttempts` so every retry's design call sees prior failures (root_cause, suggested_changes from `executor_proposal.json`) and gets up to 3 free dry-validate retries per attempt. `runParallelCompositionEpoch` (parallel) does neither — each candidate's design starts with `previousAttempts: []` and dry-validate failures consume a candidate slot.

**Why deferred.** Parallel mode is rarely used today. When it becomes the default for >1 candidate, the asymmetry will start mattering.

**What unblocks.** Decide whether parallel candidates are an "exploration" (no feedback, on purpose) or a "retry pool" (feedback per slot, expensive). The shape of the fix depends on that decision.

## Mod-based per-tick observe sampling

**What.** A small Factorio mod registered for `on_nth_tick(6, ...)` that samples each tracked entity's `status == working` state during the observe window and accumulates a "fraction of window where active" score. Result is read at end via `script-output`.

**Why deferred.** End-snapshot delta + status pair captures most pathologies (drill not on ore, burner empty, network browned out). Per-tick precision needed only when end-of-window says "all good" but downstream breaks because something stalled mid-window.

**What unblocks.** A real verify case where end-snapshot mismatches downstream behaviour.

## Probe-based unification of success criteria

**What.** Replace the 4-kind `success_criteria` enum (`build_only / nonzero / threshold / entity_exists`) with a single concept: each criterion is a lua probe returning `{pass, details}`. The kinds become probes shipped in `lib/probes/` and the runner just collects results.

**Why deferred.** The 4 kinds cover every verify case we've hit. Unification adds indirection for no current benefit.

**What unblocks.** The first audit case that's awkward to express in the closed enum (e.g., "all assemblers in this region are running", "no electric-buffer-low brownouts during the window").

## `upgrade` verb in plan.preparation

**What.** `plan.preparation: [{kind: upgrade, position, from, to}]` for in-place fast-replace (e.g., `burner-mining-drill → electric-mining-drill` at the same tile).

**Why deferred.** No use case in the current epoch chain crosses a tier boundary.

**What unblocks.** First epoch where a module pair has clear "supersedes" semantics — e.g., when an `electric-mining-drill-cell` wants to replace existing `coal-burner-cell` instances.

## Live load (no-restart rollback)

**What.** `controller.rollback()` currently does stop → swap save zip → start (~10s wall). If Factorio's RCON can trigger a runtime save load without process restart, rollback drops to ~1s.

**Why deferred.** Research item. Need to confirm the Lua surface (`game.write_file` + scenario reload? custom save action?) can actually swap world state mid-process without disconnecting RCON.

**What unblocks.** A session that's already deep in factorio-server.js Lua and can prototype the round-trip cheaply.

## docs/state-chain.md — capacity-by-consumption principle

**What.** A short architectural note codifying the demand-pull insight: production-type epochs (e1-first-coal, e4-steam-power, future e_solar) verify "is this thing working?" — not "does it produce ≥ X". Capacity adequacy is discovered at consumption time, by the consuming epoch's audit.

**Why deferred.** Need a concrete consumer-pull failure to point at as the canonical example.

**What unblocks.** First consumer-side audit that fails specifically because of upstream insufficiency (likely red-bottle or an electric module starved by e4).

## lib/lua-lib/ evidence-driven promotion

**What.** Today every `factorio_read query_script` call writes one record to `<run-dir>/design/probe-calls.jsonl`; `src/runner/scan-evidence.js` clusters records by Jaccard similarity (≥0.6 on normalised Lua tokens) and writes `<run-dir>/evidence.json`. The intended promotion flow:

1. Inspect `evidence.json` across multiple real runs.
2. Manually identify clusters whose pattern is genuinely reusable (general primitive vs one-off task query).
3. Open a PR that hand-writes a parameterised function into `lib/lua-lib/`. The PR is a **rewrite**, not a copy of scratch — the description references source clusters as evidence of demand, but the API is designed fresh.
4. Review focuses on API design, not just "did this appear N times".

**Why deferred.** The point of keeping promotion manual is that auto-promotion would conflate scratch (exploration) with library (contract).

**What unblocks.**
- Run more epochs (e2–e8 across models) and accumulate `evidence.json` outputs. Look for clusters that recur across runs, not within one.
- Add a cross-run aggregator (e.g. `scan-evidence.js --aggregate plans/*`) once we have ≥5 runs of data.
- Tune the 0.6 Jaccard threshold once real data shows whether siblings are splitting (too high) or unrelated queries are merging (too low).
- First real promotion: when a cluster shows up in ≥2 epochs with stable structure, draft an RFC PR by hand.
- Watch for false negatives: scratch that looks unique per call but is actually the same logic with different hardcoded values.
- Decide whether the preamble being part of the read-only validator's input causes issues once `lib/lua-lib/` has real content.

## Decommissioning surface for `module_decommissions`

**What.** `plan.yaml` already supports `module_decommissions: [<id>, ...]` per the world.md ledger design (now in `architecture.md`'s lib layout section). Runner removes from the fence after a successful execute that presumably mined the entities.

**Why deferred.** No current epoch decommissions. Verify the path actually works when the first epoch needs it (mine the entities + drop the fence entry atomically).

**What unblocks.** First epoch that supersedes a deployed module.
