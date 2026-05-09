# TODO — deferred work, not blocking the current restart

This file is the parking lot for ideas raised in design discussions
that we agreed to defer rather than skip. Each entry should explain
what triggered it and what would unblock acting on it. Keep entries
short; promote to a real plan doc (like `restart-plan.md` or
`verify-plan.md`) when ready to act.

## Persistent factorio-server with save fork/commit API

**What**
A long-running factorio-server process exposing
`save_as(name)` / `load(name)` actions, so a single Factorio instance
can branch — "from world W, snapshot to W', mutate, then either keep
W' or revert to W" — without restarting the binary.

**Why deferred**
Today every epoch run cold-starts a Factorio process, loads
`input_save.zip`, mutates, saves to `output_save.zip`. That gives us
fork semantics for free (input save is never touched) but pays a
cold-start penalty per run (~5s startup, plus mod load). Verify
phase will likely amplify this — we want to place harness, run
window, teardown, save — all on the same logical save tree.

The natural-debris branch shape (each verify is a fork of
input_save) doesn't strictly need this; the existing reload path
covers it. But two future use cases push toward it:

- **Parallel candidates** sharing one Factorio instance instead of
  spinning N processes. Each candidate forks from a shared base save,
  runs verify, scores, and the loser-saves are dropped. Currently
  parallel mode (`--parallel N`) actually starts N InstancePool slots,
  each its own factorio process — the bottleneck on multi-candidate
  benchmarking.
- **Verify retry without rebuild** — when a verify fails on harness
  setup but the placement+modules part is fine, we'd want to
  retry just the harness step without redoing module placement.
  Today we'd reload from input_save and redo everything.

**What would unblock**
A FactorioServer method
`async snapshotCurrent({ name })` that issues `/server-save name` (or
the equivalent) and a `loadSnapshot({ name })` that triggers reload
without process restart. Need to confirm via Factorio's RCON whether
runtime save/load can be triggered cleanly without players
disconnecting (we have no players, so likely yes).

**Estimated effort** — half day to prototype, half day to wire into
the runner's pool. Not until we have parallel candidate scoring as a
real bottleneck.

## probe-based unification of success criteria

**What**
Replace the 4-kind `success_criteria` enum
(`build_only / nonzero / threshold / entity_exists`) with a single
concept: each criterion is a lua probe returning `{pass, details}`.
The kinds become probes shipped in `lib/probes/` (e.g.,
`lib/probes/entity-exists.lua`), and runner just collects results.

**Why deferred**
After the e4-restart-with-harness work, the user's intuition (this
session) became: "harness + meter + criteria" together is the right
abstraction; the 4-kind shape isn't actually limiting yet. Decided to
keep the 4 kinds as long as they cover the verify cases we hit; only
unify if a real case demands a kind we can't express cleanly.

**What would unblock**
Encountering an audit case that's awkward to express as one of the 4
kinds — e.g., "all assemblers in this region are running" or "no
electric-buffer-low brownouts during the window". These would force
us to add custom probe scripts anyway, at which point the unification
makes sense.

## upgrade verb in plan.preparation

**What**
`plan.preparation: [{kind: upgrade, position, from, to}]` —
in-place fast-replace of an entity (e.g.,
`burner-mining-drill → electric-mining-drill` at the same tile).

**Why deferred**
No use case in the current epoch chain. e1–e4 don't cross any tier
boundary requiring upgrade. Adding the verb without a real test
case means writing untested code.

**What would unblock**
The first epoch where a module pair has clear "supersedes"
semantics — e.g., when we add `electric-mining-drill-cell` and want
to upgrade existing `coal-burner-cell` instances. At that point the
verb is one method (`fast_replace = true` on entity creation) plus
preparation schema + validator + designer prompt.

## Mod-based per-tick audit sampling

**What**
A small Factorio mod registered for `on_nth_tick(6, ...)` that, during
a verify window, samples every tracked entity's `status == working`
state and accumulates a "fraction of window where active" score per
entity. Result is read at end via `script-output`.

**Why deferred**
The cheaper end-point delta + status snapshot pair captures most
pathologies (drill not on ore, burner empty, network browned out).
We'd only need the mod path if we encounter a case where the system
shows healthy at end-of-window but actually stalled mid-window — and
end-rate vs theoretical-rate disagreement would already flag that
without per-tick precision.

**What would unblock**
A real verify case where end-snapshot says "all good" but downstream
breaks because something stalled in the middle. Then we know
per-tick sampling is needed.

## docs/state-chain.md — capacity-by-consumption principle

**What**
A short architectural doc fixing the principle: production-type
epochs (e1, e4-steam-power, future e_solar) verify "is this thing
working?" — not "does it produce ≥ X". Capacity adequacy is
discovered at consumption time, by the consuming epoch's audit. This
is the demand-pull insight from earlier in this session.

**Why deferred**
Need at least one consumer-pull failure to point at as a concrete
example. Likely happens when e5 (red-bottle production, requires
electric power) is first authored and either succeeds with low e4
output or fails with diagnostic naming the cause.

**What would unblock**
The first consumer-side audit that fails specifically because of
upstream insufficiency. The doc then writes itself around that
example.
