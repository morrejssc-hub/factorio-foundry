# Architecture

Current as of 2026-05-09. This doc describes how the codebase actually behaves; forward-looking work is in `todo.md`.

## The design inversion

The agent does not play Factorio. It writes module specs, blueprints, lua meters, and success criteria; a deterministic runner applies them. The headless game is the test runtime, not the action surface.

Three rules carried over from earlier iterations:

1. **Tool intermediation.** No raw RCON / Lua to the LLM. Every probe goes through a typed Factorio service action.
2. **Bundle separation.** `lib/` is read-only to Designer. New modules are authored under `staged-modules/` and promoted to `lib/` only after the verify phase passes.
3. **Deterministic observe.** The `observe` phase (post-verify clean-save measurement) MUST NOT invoke `pi`. Determinism is what makes multi-candidate comparisons valid.

## The pipeline

```
probe → design → dry-validate → verify → observe
```

`bootstrap` epochs (`kind: bootstrap`) skip everything except inventory stocking and a clean save.

### probe (`src/runner/probe.js`)

LLM-free since 2026-05. Runs `lib/probes/world-census.lua` via RCON, returns clusters of resource patches + world inventory. Output: `state.yaml` under `<runDir>/probe/`. Cache key includes input save bytes + `world.md` bytes — so registry changes bust the cache. The `runDesign` phase reads the produced `state.yaml`.

### design (`src/runner/design.js`)

LLM phase. Tools: `read`, `write`, `grep`, `find`, `factorio_api_docs`, `factorio_read`. **No `factorio_action`** — Designer has zero ability to mutate the world. Input: `state.yaml` + `epoch.md` + `lib/modules/*.yaml`. Output: `plan.yaml` (placements + connections + optional preparation + scaling note). When `epoch.allow_module_creation: true`, may also author `staged-modules/<id>.yaml` + `<id>.json` blueprints.

Decomposition mode: design may emit a `mode: decompose` plan that splits the world into regions, each handled by a `sub-designer` (`src/runner/sub-designer.js`). Connector belts between region ports are then wired by `connector-injector.js` (no LLM).

Schema retry: if the LLM returns malformed `plan.yaml`, the design phase re-prompts once (free; doesn't consume `recovery_attempts`).

### dry-validate (`src/runner/dry-validate.js`)

Pure JS + an optional Factorio probe. Checks placement schema, footprint overlap, port-contract sanity, then (if a controller is attached) runs `lib/probes/validate-placement.lua` to confirm tile-level can_place against the live world.

`recovery_attempts` budget is reserved for the expensive verify failures. dry-validate failures are spatial mistakes the LLM can fix from prompt feedback alone, so they get up to **3 free re-designs** (sequential path only — parallel mode dry-validates each candidate once).

Output: `dry-validate.json` under each candidate dir.

### verify (`src/runner/verify.js`)

Phase that gates candidate pass/fail. The current hot path is `runVerifyGate`,
which runs on a disposable verifier instance from `InstancePool`; it does not
produce the winner save. On the verifier clone loaded from the input save:

1. Run `dry-validate` (static portion).
2. Run `runPreparation` (`plan.preparation` deconstruct ops, if any).
3. Place modules via `placeOne` (re-uses helpers from `execute.js`).
4. Route inter-module connections (`routeConnections`).
5. Place the **harness** on the `verify-harness` Factorio force (chest + bulk-inserter at every belt/inventory port; accumulator + pole at every power port).
6. Run the meter window via `meter.js#runMeterWindow`: chunked `controller.advanceTicks(600)` ticks (10s game-time per chunk) with a `harness_tick` callback fired after each chunk to refill input chests / drain output chests. The meter script runs before + after; `measured = produced / seconds`.
7. Evaluate `epoch.success_criteria` against the verdict.

Output: `verify.json` under `<candidate>/execute/`.

The harness lives on a separate Factorio force so its inserter activity does not pollute `force.get_item_production_statistics(player)` reads done by meters. Teardown is implicit — the verifier clone is reset or shut down after the gate, so harness-bearing worlds are disposable.

`buildPlacementProposal` / `buildConnectionProposal` (from `src/runner/executor-proposal.js`) write a structured `proposal.json` on placement / connection failure — the next design retry sees `{root_cause, suggested_changes, failed_step}` instead of just an error string.

`runVerify` remains as a compatibility wrapper for older callers that still
expect snapshot -> rollback -> export behavior; `runEpoch` uses `runVerifyGate`.

### winner replay + observe (`src/runner/epoch.js`, `src/runner/observe.js`)

Only a passing candidate is replayed on the primary instance. Sequential mode
keeps the primary on the input save while verifier clone attempts run; parallel
mode reloads the primary from the input save after winner selection. Then
`replayObserveExport` applies the winning plan without the harness, runs
`observe`, and exports the candidate save.

`observe` uses the same `runMeterWindow` helper as verify, called without the harness ticker. It measures the clean, replayed world. `observe.json` is the observational record: "what does this design actually produce in production?". Never gates pass/fail; never invokes `pi`.

Output: `observe.json` under `<candidate>/` + `state/saves/<epoch>/<runTs>-cN.zip`.

## FactorioController

`src/runner/factorio-controller.js`. Composes a `FactorioServer` instance + its config. All phases take a controller and call its methods; nothing reaches into `config.rconHost`, `factorio.handleAction`, raw `fetch`, or `rconExec` directly.

Surface:

- **Process** — `isRunning()`, `start()`, `stop()`, `savePath()`, `loadSave(zipPath)` (stop + replace + start, ~10s)
- **Mutating actions** — `action(name, params)` → in-process `factorio.handleAction({action, ...params})`
- **RCON** — `rcon(command, timeoutMs)`, `runLuaScript(scriptPath, params)` (read + buildLuaCommand + RCON + parse JSON)
- **Reads** — `read(actionName, params)` → POSTs `${serviceUrl}/tool/factorio_read`
- **Time control** — `advanceTicks(n)` → POSTs `wait_ticks` action
- **Entity counts** — `countEntities()`, `countEntitiesByName({name, surface})`
- **Snapshot / rollback** — `snapshot(name)` (RCON `/server-save`, copy zip into `<savesDir>/snapshots/<name>.zip`), `rollback(name)` (stop + swap + start, ~10s), `exportZip(destination)`. Used by the legacy `runVerify` wrapper; the current clone gate avoids rollback on the hot path.

`InstancePool` (`src/runner/instance-pool.js`) — N-slot pool for parallel candidates. Each slot owns its own `FactorioServer` + HTTP api + RCON ports + save dir + `FactorioController`. `pool.acquire()` / `pool.release()`.

## Run lifecycle

For a composition epoch with `recovery_attempts: N`:

1. `runEpoch` builds a primary controller from the parent `FactorioServer`.
2. Probe runs once on the primary from the input save.
3. Sequential: one attempt loop with up to 3 free dry-validate re-designs per attempt; each verify attempt runs on a single verifier clone loaded from the input save. Dirty clones are reset before reuse.
4. Parallel: `n = config.parallelCandidates` independent designs run concurrently; each verify attempt runs on an `InstancePool` slot. One winner is picked by `pickWinner`.
5. Verify-pass winner: replay the winning plan on the primary without harness, run observe, then export the clean candidate zip → `state/saves/<epoch>/<runTs>-c<idx>.zip`.
6. Promote winner: copy candidate zip to `state/saves/<epoch>/winner.zip`, append placements to `state/world.md` `## Deployed modules` fence, write `state/digests/<epoch>.md`.
7. `<runDir>/run-meta.json` rolls up probe + design + verify + observe blocks per attempt.
8. `<runDir>/summary.md` is auto-rendered by `run-summary.js` from `run-meta.json`.

## Save lifecycle

```
input_save.zip                       # never mutated
  ↓ primary controller.loadSave
primary in-memory world              # probe only; kept clean for replay
  ↓ verifier clone controller.loadSave
verifier clone world                 # placements + connections + harness
  ↓ verify gate
verifier clone discarded or reset    # no save exported from clone
  ↓ winner replay on primary
primary in-memory world              # clean placements + connections, no harness
  ↓ observe, then controller.exportZip
state/saves/<epoch>/<runTs>-cN.zip   # candidate save
  ↓ promoteWinner (if winner)
state/saves/<epoch>/winner.zip       # input for downstream epochs
```

Harness-bearing worlds exist only in verifier clones. Nothing harness-related
ever reaches the promoted save. On verify-fail, the dirty clone is reset before
reuse or shut down with the pool; the primary remains available for the eventual
winner replay.

## lib/ layout

- `lib/modules/<id>.yaml` — port contract + footprint + meter bindings + preconditions + (optional) `starter_items` + `realization.blueprint` path. Schema validated by `src/lib-loader.js`.
- `lib/blueprints/<id>.json` — anchor-relative entity geometry. Each entity has `key`, `item`, `dx`, `dy`, `direction`, optional `settings: {recipe, fuel}`.
- `lib/meters/` — lua scripts each module's `meters[].port` or `meters[].script` references. Two shapes:
  - **Port meter** (`lib/meters/port-meter.lua`): module declares `port: <name>` on its meter; runner derives world position from the placement's anchor + the module port's `rel_pos`.
  - **Custom meter**: module declares `script: lib/meters/<name>.lua` with custom params (`window_ticks`, item, etc.). `lib/meters/throughput-window.lua` is the canonical item-rate meter.
- `lib/probes/` — lua scripts called by the probe phase or by `factorio_read query_script`. Includes `world-census.lua`, `validate-placement.lua`, `find-placement-anchors.lua`, `tile-info.lua`, etc.
- `lib/lua-lib/` — preamble injected into every pi-submitted probe script. Sandbox helpers. (Currently empty pending evidence — see `todo.md`.)

## epoch.md shape

```yaml
id: e1-first-coal
kind: composition                   # or "bootstrap"
input_save: state/saves/e0-bootstrap/winner.zip
output_save: state/saves/e1-first-coal/winner.zip   # (informational)
goal: |
  Free-form prose for the LLM.
allowed_modules: [coal-burner-cell]
allow_module_creation: false
recovery_attempts: 1
target_metric:
  metric: coal_per_s
  meter: lib/meters/throughput-window.lua  # OR module-driven (lookup by allowed_modules + metric)
  threshold: 0.10
  params: { window_ticks: 3600, item: coal }
success_criteria:                    # optional; legacy threshold auto-coerced if absent
  - { kind: threshold, op: ">=", threshold: 0.10, field: measured }
budgets:
  probe_timeout_ms: 60000
starter_inventory: []                # bootstrap only
```

Three `target_metric` shapes are supported:

1. Direct path (legacy): `{ audit | meter, threshold, params }` with a script path.
2. Module-driven: `{ module: <id>, metric: <label> }` — resolver looks up the module's `meters[]` and selects by metric name.
3. Goal-only: `{ metric: <label> }` — resolver scans every placement's module for a matching meter.

Resolution lives in `src/runner/meter-resolver.js`. The criteria-evaluation layer (`src/runner/success-criteria.js`) is independent of the meter source.

## Sequential vs parallel

Sequential (`runCompositionEpoch`): one attempt at a time, up to `recovery_attempts` retries. Free dry-validate retries via inner loop. `previousAttempts` accumulates verify failures so the next design call sees a focused brief on what failed.

Parallel (`runParallelCompositionEpoch`, when `config.parallelCandidates > 1`): N independent designs run concurrently on N slots from `InstancePool`. No cross-candidate feedback (each design starts with `previousAttempts: []`). Winner picked by `pickWinner` after all candidates finish.

The sequential path's free-retry + previousAttempts feedback is missing in parallel — known divergence; see `todo.md`.

## Tests

`npm test` runs `node --test test/**/*.test.js`. The test suite:

- Unit-tests the deterministic JS surface: rotation math, port resolution, criteria evaluation, dry-validate logic, run-meta rollup, world.md fence rewriting, controller surface (mocked Factorio).
- Live Factorio behaviour is exercised via the e0–e3 chain (smoke). Smoke tests are not in `npm test` because they spawn Factorio and take minutes per epoch.

## Where to look

- `src/runner/epoch.js` — the orchestrator. Read this first.
- `src/runner/factorio-controller.js` — the abstraction every phase uses.
- `src/runner/<phase>.js` — phase implementations.
- `src/factorio-server.js` — large file, but the `MUTATING_ACTIONS` set + `handleAction` switch are the surface most phases call into.
- `prompts/{probe,design,sub-designer}.md` — exact contract each LLM phase sees.
- `epochs/` — the DAG of tasks that gets walked by `scripts/run-dag.js`.
