# Design phase

You are running the **Design phase** of a Factorio epoch.

You have **no access to the Factorio world**. You cannot read live state and
you cannot place anything. Your tools are: `read`, `write`, `grep`, `find`,
`ls`, `factorio_api_docs`. Any attempt to call `factorio_action` or
`factorio_read` will fail and is a violation.

## Inputs available in your working directory

- `state.yaml` — produced by the Probe phase. This is your only view of the
  current world.
- `epoch.yaml` — the epoch's target metric, allowed modules, and budgets.
- `lib/modules/*.yaml` — the module library. **You may only select modules
  that are listed in `epoch.allowed_modules`.** You may not invent new
  modules in this MVP.
- `lib/blueprints/*.json` — the blueprint that realises each module. You can
  read these to understand the entity layout and starter fuel requirements.

## Required output

Write `plan.yaml` (and only `plan.yaml`) at the root of your working directory.
Required fields (all four are mandatory — `dry-validate` will fail otherwise):

```yaml
epoch: <epoch.id>
placements:
  - id: <unique short string>           # e.g. p0, p1
    module: <module.id>
    anchor: { x: <number>, y: <number> }
    direction: <north|east|south|west>
connections:                            # may be []
  - from: { placement: <id>, port: <port name> }
    to:   { placement: <id>, port: <port name> }
    required_throughput: <number>       # items/s
expected_throughput: <number>           # the producer-side rate the plan delivers for the target item
why_not_replicate: <string>             # one sentence — why N modules instead of N copies of one
```

## Anchoring rules

Each module's `footprint` field gives a min/max bbox in canonical orientation
(north). The anchor is the world-space point that maps to (0,0) in the
module's local frame. You must:

1. Pick anchors so the module's bbox sits over a suitable resource patch
   (check `state.yaml` patches and the module's `preconditions`).
2. Avoid placing two modules whose bboxes overlap.
3. Stay close to the worker's current position so the executor doesn't have
   to traverse the whole map.

## The four-field rule

- `placements` and `connections` describe geometry.
- `expected_throughput` is the rate this plan should deliver of the target
  item. Compute it from the chosen modules' port throughputs, not by guessing.
- `why_not_replicate` is the most important field when scaling beyond a
  single module. If you place 4 of the same module to multiply output, your
  reason must explain why this particular composition meets the target —
  not just "4× one module".

## Budget

Aim for under 60 tool calls. Most of your time should be reading the lib
files; the actual `plan.yaml` is short.
