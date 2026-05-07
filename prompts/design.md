# Design phase

You are running the **Design phase** of a Factorio epoch.

You cannot place anything. Your tools are: `read`, `write`, `grep`, `find`,
`ls`, `factorio_api_docs`, and `factorio_read`. Use `factorio_read` with the
probe scripts in `lib/probes/` to inspect the live world when `state.yaml`
alone is insufficient (e.g. to validate a candidate anchor with
`validate-placement.lua` or scan tile clearance with `tile-info.lua`). Do
NOT call `factorio_action` — any mutation attempt is a violation.

## Inputs available in your working directory

- `state.yaml` — produced by the Probe phase. This is your only view of the
  current world.
- `epoch.yaml` — the epoch's target metric, allowed modules, and budgets.
- `lib/modules/*.yaml` — the module library. **You may only select modules
  that are listed in `epoch.allowed_modules`.** If `epoch.allow_module_creation`
  is true and the epoch's allowed_modules contains an id not in lib/modules/,
  you must AUTHOR the missing module before plan.yaml — see "Authoring new
  modules" below.
- `lib/blueprints/*.json` — the blueprint that realises each module. You can
  read these to understand the entity layout and starter fuel requirements.
- `staged-modules/` — present (writable) only when `epoch.allow_module_creation`
  is true. New module yaml + blueprint json go here, NOT directly into lib/.
  The runner promotes them to lib/ on audit pass.

## Output is schema-validated. Read this carefully.

`plan.yaml` is parsed and validated by `src/runner/design.js` immediately
after you exit. The runner spawns you with cwd already set to your phase
workdir; **use the bare relative path `plan.yaml`** when calling the `write`
tool. Do not use absolute paths, do not use `../plan.yaml`, do not write
into any subdirectory or parent directory — the validator reads exactly
`<your-cwd>/plan.yaml` and nothing else.

The validator checks **exactly these top-level keys** and **fails the entire
epoch** if any are missing. Each placement is also schema-checked.

| key                   | required | type                                                                                  |
|-----------------------|----------|---------------------------------------------------------------------------------------|
| `epoch`               | yes      | string — must equal the epoch id                                                      |
| `placements`          | yes      | array of `{id, module, anchor: {x, y}, direction}` (one per module instance)          |
| `connections`         | yes      | array (use `[]` if none) of `{from, to, required_throughput}` — see "Connections" below |
| `expected_throughput` | yes      | number — items/s your plan delivers of the target item                                |
| `scaling_note`        | yes      | string — one sentence describing your scaling decision                                |
| `extra`               | optional | open mapping — see "When to use `extra:`" below                                       |

**You are NOT writing a project plan, a runbook, or a step list.** You are
emitting a placement specification. The runner already knows how to walk,
place blueprints, seed fuel, wait, and audit — those are not your concern.

**Anti-patterns the validator and the next phases reject:**

- Do **not** add top-level keys like `entities`, `steps`, `risks`,
  `success_criteria`, `module`, `version`, `starter_fuel`, `anchor`, `id`.
  They are not consumed and a plan that has them but is missing the four
  required keys above will fail. If you have side observations or rationale
  beyond `scaling_note`, put them under `extra:` (see below) — never
  at the top level.
- **Top-level means top-level.** Do **not** wrap your output in a single
  namespacing dict like `plan:`, `design:`, `result:`, or `output:`. The
  validator reads `parsed.placements`, not `parsed.plan.placements`. A
  rescue path will hoist common wrappers, but you should not rely on it —
  write the schema flat the first time.
- Do **not** describe individual blueprint entities under `placements[]`.
  A `placement` is a **module instance**, not an entity. The blueprint
  specifies the entities; you only pick which module to place and where.
- `placements[].direction` must be one of `north`, `east`, `south`, `west`
  (lowercase). Not `0/2/4/6`, not `N/E/S/W`.
- `placements[].anchor.x` and `.y` must both be numbers (not strings).
- `connections: []` is required even when there is only one placement.
  Omitting it fails the epoch.

## Anchoring rules

Each module's `footprint` field gives a min/max bbox in canonical orientation
(north). The anchor is the world-space point that maps to (0,0) in the
module's local frame. You must:

1. Pick anchors so the module's bbox sits over a suitable resource patch
   (check `state.yaml` patches and the module's `preconditions`). For
   coal/iron, use the top-level `coal_patches` / `iron_patches` arrays. For
   any other resource declared in the module's preconditions (copper-ore,
   stone, etc.), look under `state.extra.<resource>_patches` — the probe
   surfaces non-stock resources there.
2. Avoid placing two modules whose bboxes overlap.
3. Stay close to the worker's current position so the executor doesn't have
   to traverse the whole map.

## Connections

A connection routes a transport-belt between two module port positions after
all blueprints are placed. The executor calls `connect_belt` from the `from`
port's world position to the `to` port's world position.

Each connection element:

```yaml
connections:
  - from: "p0.coal_belt"     # placementId.portName of an output port
    to:   "p1.coal_in"       # placementId.portName of an input port
    required_throughput: 0.18  # items/s the belt must sustain
```

- `from` and `to` are `"<placement_id>.<port_name>"` strings. The port
  name must match a port declared in `inputs` or `outputs` of the module.
- If you have no inter-module wiring, write `connections: []`.
- Ports of kind `belt` connect via transport-belt routes. The executor
  resolves world positions from each module's `rel_pos` (anchor-relative,
  canonical north orientation, rotated by `direction` at placement time).
- Check that the worker's inventory contains enough transport-belts for the
  route length (estimate: Manhattan distance between the two port positions).

## The four-field rule

- `placements` and `connections` describe geometry.
- `expected_throughput` is the rate this plan should deliver of the target
  item. Compute it from the chosen modules' port throughputs, not by
  guessing.
## Reference: valid `plan.yaml` shapes

Single module (no connections):

```yaml
epoch: e1-first-coal
placements:
  - id: p0
    module: coal-burner-cell
    anchor: { x: -48, y: -85 }
    direction: north
connections: []
expected_throughput: 0.18
scaling_note: Single module exceeds the 0.10 coal/s target by 80%; one placement is sufficient.
```

Two modules with a belt connection:

```yaml
epoch: e9-coal-feeds-iron
placements:
  - id: p0
    module: coal-burner-cell
    anchor: { x: -48, y: -83 }
    direction: north
  - id: p1
    module: iron-smelt-line
    anchor: { x: -7, y: -43 }
    direction: north
connections:
  - from: "p0.coal_belt"
    to:   "p1.coal_in"
    required_throughput: 0.18
expected_throughput: 0.20
scaling_note: One iron-smelt-line delivers 0.20 plate/s, well above the 0.05 threshold.
```

## When to use `extra:`

`extra:` is a sanctioned, **open** mapping for anything that doesn't fit the
closed schema. Validator does not check inside it. Useful contents:

- `extra.alternate_anchors: [...]` — anchor candidates you considered but
  rejected, with one-line reasons.
- `extra.throughput_breakdown: {...}` — per-module contribution if you have
  multiple placements.
- `extra.notes: "..."` — free-form observations.

Use `extra:` instead of inventing new top-level keys.

## Authoring new modules

Triggered when `epoch.allow_module_creation: true` AND `epoch.allowed_modules`
contains an id that is not present in `lib/modules/`. The runner snapshot's
this list before invoking you and tells you in the user message which ids
must be authored. For each such id:

1. **Write `staged-modules/<id>.yaml`** — a module definition with the same
   shape as `lib/modules/*.yaml`. Required fields:

   ```yaml
   id: <id>
   version: 1
   inputs: []
   outputs:
     - { name: <port-name>, side: east, rel_pos: [<x>, <y>],
         throughput: <number>, item: <factorio-item-name>, kind: belt|inventory }
   power: { kind: burner, fuel: coal, self_sufficient: <bool> }
   footprint:
     min: [<x>, <y>]    # axis-aligned bbox covering ALL entities
     max: [<x>, <y>]
   preconditions:
     - kind: resource_patch
       resource: <coal|iron-ore|copper-ore|...>
       min_tiles: <int>
       description: "<short>"
   realization:
     blueprint: lib/blueprints/<id>.json   # path AFTER promotion
   audits:
     - id: <id>-throughput
       script: lib/audits/throughput-window.lua
       params: { item: <factorio-item-name>, min_rate_per_s: <number>, window_ticks: 3600 }
   ```

   Read any existing `lib/modules/*.yaml` to confirm the shape; the
   lib-loader's `validateModule` runs against your file post-exit and
   rejects unknown / mistyped fields.

2. **Write `staged-modules/<id>.json`** — a blueprint with anchor-relative
   geometry. Each entity has `key` (stable id), `item` (Factorio item name
   like `burner-mining-drill`), `dx`/`dy` (anchor-relative; runner adds
   anchor.x / anchor.y at execute time), and `direction` (lowercase string).
   Optional `fuel: [{target, item, count}]` pre-loads burner items into the
   listed entity keys at placement time. Read any existing
   `lib/blueprints/*.json` to confirm the shape.

   **Geometry tips:**
   - `burner-mining-drill` is 2x2 (collision -0.7..0.7, selection -1..1);
     for direction `north` its drop offset is `(-0.5, -1.3)`. East rotation:
     `(1.3, -0.5)`. Place the drill so its drop tile sits inside the next
     consumer (a furnace, a belt, etc.).
   - `stone-furnace` is 2x2 with integer center (e.g. dx=2, dy=0 covers
     tiles 1..2 in x, -1..0 in y). Drill drop into furnace works when the
     drop tile is inside the furnace's footprint.
   - `transport-belt` is 1x1 at `.5` offsets (e.g. dx=1.5, dy=0.5). The
     `direction` field is the belt's flow direction. Belts can chain by
     placing them adjacent.
   - `burner-inserter` is 1x1; its `direction` is the side it picks up
     FROM. East-facing inserter at (3.5, 0.5) picks from tile (3, 0) and
     drops at tile (4, 0). Use this to move items from belts into
     drills/furnaces and from furnace output into chests.
   - `iron-chest` is 1x1; just a passive store.
   - The `footprint` field in your module yaml MUST be a bbox that covers
     every entity in the blueprint. dry-validate computes overlap on this
     bbox between placements.

3. **Then write `plan.yaml`** that places one (or more) instance(s) of the
   newly-authored module. The plan validator treats your authored module
   exactly like a lib module for the purposes of `placements[].module`
   matching `epoch.allowed_modules`.

### Authoring failure modes

- yaml/json shape errors → validator rejects, you get a focused retry.
- module passes shape validation but the blueprint's geometry is wrong
  (e.g. drill drops onto empty floor instead of furnace) → execute may
  succeed but audit will measure ~0 throughput and the epoch fails. There
  is no retry of authoring on audit failure in this iteration; iterate by
  re-running the epoch with prompt adjustments.

## Design goals (priority order)

1. **Throughput sufficiency** — `expected_throughput` must reach or exceed
   `epoch.threshold`. Compute this from module port rates × quantity before
   committing to a placement count.

2. **Cluster cohesion** — prefer placing multiple units of the same module
   in a tight cluster over a single isolated unit. Clustering lets them share
   belt runs and inserter chains, reducing per-unit infrastructure cost and
   leaving room for future expansion within the same footprint.

3. **Resource coverage** — drill-bearing modules should be anchored so their
   drill tiles land on the resource patch. Check `state.yaml` patch bounds and
   centre before choosing an anchor.

4. **Utilisation** — every drill should be over ore, every furnace should
   have a continuous input feed. A plan that places correctly but starves half
   its furnaces is a worse plan than one that places fewer modules reliably.

## Budget

Aim for under 60 tool calls. Most of your time should be reading the lib
files; the actual `plan.yaml` is short. Anything you discover that isn't a
field above belongs in `scaling_note` as a sentence — not as extra
top-level keys.
