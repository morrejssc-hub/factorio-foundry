# factorio-foundry

A Factorio agent built on a deliberate inversion: **the LLM writes code (module specs, blueprints, lua probes, success criteria); the headless game is the test runtime.** The agent compiles intent into a placement plan; a deterministic runner applies it.

## Pipeline

Five phases per composition epoch:

```
probe → design → dry-validate → verify → observe
```

Designer has no `factorio_action` tool — placement is selected, not improvised. Verify runs on disposable verifier clones; only the winning plan is replayed on the primary for observe/export. Observe is deterministic and never invokes the LLM.

## Quick start

```bash
npm install
npm run epoch e0-bootstrap
npm run epoch e1-first-coal
npm test
```

`scripts/run-dag.js` walks the epoch DAG. `scripts/run-epoch.js <id> --parallel <N>` runs N candidates concurrently.

## Structure

- `src/runner/` — phase implementations and the `FactorioController` facade
- `lib/modules/` + `lib/blueprints/` — module library (port contracts + entity geometry)
- `lib/meters/` + `lib/probes/` — lua scripts for measurement and read-only probes
- `epochs/` — task DAG (`*.md` frontmatter + goal body)
- `state/` — saves, digests, world.md (gitignored)
- `prompts/` — exact contract each LLM phase sees

## Read more

- `docs/architecture.md` — full reference
- `docs/todo.md` — open work items
- `CLAUDE.md` — session-priming overview
