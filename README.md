# factorio-foundry

A Factorio agent built on a single design inversion:

> **pi-coding-agent is a coding agent. Make it write code (module specs, blueprints, Lua probes, audit cases). Don't make it play Factorio. The game world is the test runtime for an "intent → factory" compiler.**

## The 5-phase epoch loop

Each phase is an independent invocation with a different tool set:

| Phase | Caller | Tools | Writes | Reads |
|---|---|---|---|---|
| 1. Probe | `pi -p` | `factorio_read,read,write` | `state.yaml` | `factorio_read` + lib/ |
| 2. Design | `pi -p` | `read,write,grep,find,factorio_api_docs` (**no `factorio_action`**) | `plan.yaml` | state.yaml + lib/ |
| 3. Dry-validate | Node (deterministic) | — | `dry-validate.json` | plan + lib |
| 4. Execute | Node compiler + pi fallback | `factorio_action,factorio_read` | save vN+1 | plan |
| 5. Audit | Node + Lua (deterministic) | — | `audit.json` | save + audit suite |

The Designer phase having no `factorio_action` is the central architectural lever — it forces the agent to **select** modules from `lib/` rather than improvise placements.

## Layout

- `lib/` — durable, monotonically-growing brain: modules with port contracts, blueprints, Lua probes, audit cases.
- `epochs/` — hand-written DAG of (input save, target metric) tasks.
- `plans/<epoch>-<run>/` — per-run artifacts (gitignored).
- `state/saves/` — versioned save chain (gitignored).
- `state/digests/` — one digest per successful epoch (gitignored).
- `src/runner/` — the 5 phase implementations.
- `src/factorio-process.js` — Factorio headless lifecycle + RCON + Lua + actions.
- `src/pi-invoke.js` — wraps `pi -p` with per-phase tools/extensions/prompt/cwd.
- `.pi/extensions/` — vendored from `~/factorio-agent`.

## MVP scope

Validate the architecture with a single epoch chain `e0-bootstrap → e1-first-coal`:
- One module: `coal-burner-cell` with full port contract.
- One audit: `throughput-window.lua` measuring `coal ≥ 0.4/s` over 3600 ticks.
- Designer's stdout must contain **zero** `factorio_action` calls.
- Auditor must never invoke pi.

See `~/.claude/plans/git-repo-mvp-misty-karp.md` for the full plan.

## Quick start

```bash
npm install
npm run check
npm run epoch e0-bootstrap
npm run epoch e1-first-coal --from-save state/saves/e0-bootstrap-v1.zip
npm test
```

## Test fixtures

Epoch yamls may set `_fixture.attempts: [<dir>, ...]` to bypass the LLM
Designer and load a hand-authored `plan.yaml` (and optional
`staged-modules/`) per attempt. The seam lives in `src/runner/design.js`
and only fires when the key is present, so production epochs are
untouched. Used by `epochs/e_test_proposal-loop.yaml` to deterministically
exercise the executor proposal loop end-to-end.

## Origin

Distilled from lessons of `~/factorio-agent` (long-running single-session, copy-bug on scale change) and the abandoned `yoitsu-v2` (over-engineered orchestration). Three architectural rules carried over:

1. Tool intermediation (no raw RCON/Lua to LLM).
2. Bundle/workspace separation (lib is read-only to Designer).
3. Deterministic auditor (LLM never judges its own output).
