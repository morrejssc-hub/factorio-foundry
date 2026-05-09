# Restart Plan — clean re-run of e0 → e4 on a fresh save

Last revised: 2026-05-08

## Why restart

The state chain accumulated incidental drift during architecture experiments:
old `target_metric.threshold` numbers picked by guess, a half-finished
hand-authored steam-power-line, plan dirs from runs whose audits were
broken, etc. The runtime now has a coherent set of pieces that didn't
exist together when the chain was first laid down:

- module-declared audits with `metric` / `aggregate` / staged-script
  promotion (see `audit-resolver.js`)
- `success_criteria` that decouple measurement from judgement (see
  `success-criteria.js`)
- executor auto-clear for natural debris and explicit `preparation:`
  teardown (see `runExecute` in `execute.js`, plus
  `factorio-server.js#clearObstacles` / `deconstructAt`)
- defensive audit-script handling (no longer blows up when a Designer
  conflates `ok` with "passed threshold")

Re-running e0 → e4 on a clean save validates these pieces against each
other without legacy compatibility shims fogging the result. The old
saves are kept as **reference** so we can A/B compare measurement
distributions on the same epoch if needed.

## Keep / discard

Keep, untouched:
- `src/` — all runtime code, including the recently added
  `audit-resolver.js` / `success-criteria.js`, executor preparation
  phase, factorio-server `clear_obstacles` / `deconstruct_at`
- `lib/modules/` — `coal-burner-cell`, `iron-smelt-line`,
  `copper-smelt-line`, `coal-cluster-cell` are stable
- `lib/blueprints/` — same four blueprints, no orphans
- `lib/audits/throughput-window.lua` — still the right audit for item
  rates
- `lib/probes/` — including `world-census.lua` with `water_patches`
  support and `tile-info.lua`
- `prompts/` — design.md and probe.md, including the new "Tearing down"
  section
- `epochs/e0-bootstrap.yaml` … `epochs/e9-coal-feeds-iron.yaml` and
  test branches

Drop, before the new run starts:
- `state/saves/e1-first-coal/` … `state/saves/e9-coal-feeds-iron/`
  (entire directories — these were per-attempt staging zips). Top-level
  `state/saves/e*-v1.zip` archives are kept as reference.
- `state/world.md` (regenerate from the e0 bootstrap)
- `state/digests/` (regenerate per epoch)
- `plans/e1-*` … `plans/e9-*` and `plans/e4-steam-power-*` (run
  directories — large, unindexed, no longer referenced)
- `logs/e1-*` … `logs/e9-*` (free-form; useful only for the run that
  produced them)

The reference `e0-v1.zip` … `e9-v1.zip` saves at the **top of**
`state/saves/` are not touched. They are the historical record.

## Re-run sequence

| # | epoch                | input save              | success_criteria                                                                  |
|---|----------------------|-------------------------|-----------------------------------------------------------------------------------|
| 0 | `e0-bootstrap`       | (none — bootstraps)     | deterministic; passes if the worker spawns with stocked inventory                 |
| 1 | `e1-first-coal`      | `e0-bootstrap-v1.zip`   | (legacy) `min_rate_per_s: 0.10 coal/s`                                            |
| 2 | `e2-first-iron`      | `e1-first-coal-v1.zip`  | (legacy) `min_rate_per_s` for iron-plate                                          |
| 3 | `e3-first-copper`    | `e2-first-iron-v1.zip`  | (legacy) `min_rate_per_s` for copper-plate                                        |
| 4 | `e4-steam-power`     | `e3-first-copper-v1.zip` | `build_only` + `entity_exists{steam-engine}` + `nonzero{power_kw}` (new)          |

Note: e1–e3 still use the legacy `min_rate_per_s` field. The runner
auto-coerces this into a single `threshold` criterion via
`coerceLegacyCriteria`, so they keep working without YAML edits. We
migrate them to the new `success_criteria` form **only** when there is
a reason — e.g., when threshold values become demonstrably arbitrary
or when a downstream consumer epoch needs a different signal.

## What "passing" looks like at each step

- **e0**: `state/saves/e0-bootstrap-v1.zip` regenerated, worker exists,
  inventory matches the bootstrap manifest. No probe / design /
  audit phases run.
- **e1–e3**: same as before. Verdict reports `pass: true` with a
  `criteria: [{kind: threshold, op: ">=", ...}]` block (the new
  uniform shape).
- **e4** (the substantive validation): three criteria all `pass: true`:
  - `build_only` — execute phase didn't throw (preparation +
    placements + connections + save all succeeded)
  - `entity_exists{steam-engine}` — at least one steam-engine sits on
    the surface
  - `nonzero{power_kw}` — the audit script's measured value > 0
    (current is actually flowing)
  - The audit script's threshold guess (`min_kw` in its own params)
    no longer affects pass/fail — the runner ignores it. Only
    structural reality counts.

## Re-run command sequence

```
# 0. clear runtime artefacts (one-shot)
rm -rf state/world.md state/digests/ logs/e* plans/
mkdir -p plans/

# 1. drop per-epoch staging save dirs (reference top-level zips kept)
find state/saves/ -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +

# 2. run the chain in order
node scripts/run-epoch.js e0-bootstrap
node scripts/run-epoch.js e1-first-coal
node scripts/run-epoch.js e2-first-iron
node scripts/run-epoch.js e3-first-copper
node scripts/run-epoch.js e4-steam-power
```

Each step writes its own digest under `state/digests/`. `world.md` is
regenerated incrementally — every epoch that promotes a new module or
adds a placement appends to the deployed-modules fence.

## Done criterion

The restart is complete when:

1. e0 → e4 all return `ok: true`. Each `plans/<epoch>-*/run-meta.json`
   shows `final_verdict: { pass: true, ... }`.
2. `lib/modules/steam-power-line.yaml` exists (Designer-authored,
   promoted on e4 audit pass).
3. `lib/blueprints/steam-power-line.json` exists.
4. `lib/audits/<basename>.lua` exists for whatever audit the Designer
   declared on the steam-power-line module — the staged path
   (`staged-modules/...`) is rewritten to lib paths automatically by
   `promoteStagedModules`.
5. `state/saves/e4-steam-power-v1.zip` exists and is loadable into a
   live Factorio process showing a working steam plant.
6. The `verdict.criteria[]` block on e4 contains all three criterion
   results with `pass: true`.

If any step fails, **don't** patch around it — read the
`run-meta.json` failure block and the `summary.md` trajectory, identify
the architectural gap (vs a Designer mistake), and decide whether to
fix infrastructure or rewrite the epoch goal.

## Out of scope for this restart

- Migrating e1–e3 to `success_criteria` form. The legacy threshold
  path works; touch only when there's reason.
- Implementing `preparation: [{kind: upgrade}]`. No upgrade scenario
  exists yet (no module pair where one supersedes the other). Add when
  a real case appears.
- Probe-based audits (e.g. `lib/probes/burner-network-ok.lua`). The
  current "measure value + criteria" path is sufficient for this run;
  the structural-probe direction is its own next step.
- Touching `e5-coal-cluster-cell` … `e9-coal-feeds-iron` test
  branches. They reference earlier saves and stay frozen until the
  main chain stabilises.
