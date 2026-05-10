# factorio-foundry

A Factorio agent built on a deliberate inversion: **the LLM writes code (module specs, blueprints, Lua probes, success criteria); the headless game is the test runtime.** No improvising in-game; the agent compiles intent into a placement plan and lets a deterministic runner apply it.

## Pipeline

Every composition epoch runs five phases in order:

```
probe → design → dry-validate → verify → observe
```

| Phase | Owner | Writes | Purpose |
|---|---|---|---|
| `probe` | LLM via `pi` | `state.yaml` | Snapshot persistent world (resource patches, worker, world inventory) |
| `design` | LLM via `pi` | `plan.yaml` (+ optional staged module files) | Pick modules + anchors + connections |
| `dry-validate` | JS (deterministic) | `dry-validate.json` | Schema + footprint + tile-canPlace checks |
| `verify` | JS + Factorio harness | `verify.json` (in `<candidate>/execute/`) | Run candidate on a disposable verifier clone, place harness, run meter window, gate pass/fail. No save is exported from the clone. |
| `observe` | JS + Factorio (clean replay) | `observe.json` (in `<candidate>/`) + candidate `.zip` save | Replay the winning plan on the primary without harness, measure it, then export the clean candidate save. |

Bootstrap epochs (`kind: bootstrap`) skip everything except inventory stocking and a clean save.

## Layout

```
src/
  factorio-server.js      # Factorio binary lifecycle + RCON + actions
  factorio-process.js     # service boot
  rcon.js                 # raw RCON protocol
  config.js               # env-driven config
  pi-invoke.js            # `pi -p` subprocess wrapper
  http-api.js             # HTTP service exposed to pi extensions
  runner/
    factorio-controller.js   # composes FactorioServer; one facade for all phases
    epoch.js                 # orchestrator (sequential + parallel paths)
    probe.js, design.js, dry-validate.js, verify.js, execute.js, observe.js
    meter.js                 # shared meter-window orchestration (verify + observe)
    meter-resolver.js        # picks which lua meter to run for an epoch
    success-criteria.js      # criteria evaluation (threshold/nonzero/build_only/entity_exists)
    instance-pool.js         # N-slot pool for parallel candidates
    sub-designer.js          # per-region designer for decomposed plans
    connector-injector.js    # wires inter-region belts in decomposed plans
    pi-trace.js, run-summary.js, run-layout.js, ...
lib/
  modules/<id>.yaml       # port-contract + footprint + meter binding per module
  blueprints/<id>.json    # entity layout for each module
  meters/                 # lua scripts that read world state + return measured values
  probes/                 # lua scripts the probe phase calls
  lua-lib/                # shared lua preamble injected into pi probe scripts
epochs/
  e<N>-<name>.md          # one task: frontmatter input save + target metric, body goal
state/
  saves/                  # input/output zip chain (gitignored)
  digests/                # one digest per successful epoch (gitignored)
  world.md                # cross-epoch agent journal of deployed modules
plans/                    # per-run artifacts (gitignored)
prompts/
  probe.md, design.md, sub-designer.md     # phase-specific LLM prompts
docs/
  architecture.md         # full architecture reference
  todo.md                 # forward-looking work items
```

## Run a single epoch

```bash
node scripts/run-epoch.js <epoch-id>           # e.g. e1-first-coal
node scripts/run-epoch.js <epoch-id> --parallel 4   # N candidates in parallel
node scripts/run-dag.js [--from <id>] [--to <id>]   # walk the DAG
```

## Tests

```bash
npm test            # node:test suite
npm run check       # static config / config.js sanity
```

## Conventions

- Phases never reach into `config.rconHost`, `factorio.handleAction`, `rconExec`, `fetch(serviceUrl)` directly. They take a `FactorioController` and call `controller.action / .rcon / .runLuaScript / .read / .advanceTicks / .loadSave / .snapshot / .rollback / .exportZip`.
- Verify gates run on disposable verifier clones. The primary instance only replays the selected winner for observe/export.
- The `observe` phase (deterministic verdict, post-verify on the clean save) MUST NOT invoke `pi`. Phase determinism gates the parallel-candidate comparison.
- New modules go in `staged-modules/` during design, get promoted to `lib/modules/` + `lib/blueprints/` only after the verify phase passes.
- `world.md`'s yaml fence (`## Deployed modules`) is machine-managed; surrounding prose is agent-managed.

## Where to read more

- `docs/architecture.md` — full reference (phase contracts, controller surface, run lifecycle, save chain)
- `docs/todo.md` — open work items
- `prompts/{probe,design,sub-designer}.md` — exact contracts each LLM phase sees
