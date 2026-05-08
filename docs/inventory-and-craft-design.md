# Inventory visibility and craft path — design notes

Captured during a 2026-05-07 design discussion that came out of trying to
extend `lib/` toward red-science. Two real blockers surfaced (executor
didn't support `recipe`-on-assembler; chest contents invisible to
Designer) and walking those backwards exposed a cleaner architecture for
how persistent state, live state, and agent capability fit together.

This doc captures the reasoning and the resulting plan. The plan itself
is intentionally kept in checklist form at the bottom — implementation
follows after this is reviewed.

---

## What we discovered (current architecture, accurately)

### Executor is a hybrid, not a pure compiler

`Phase 4 (Execute)` = Node deterministic fast path + LLM repair-agent
fallback (`src/runner/execute.js:85` `repairWithPi`). The repair agent is
spawned with `factorio_read` + `factorio_action` tools; its action set
includes `craft`, `mine_resource`, `transfer_inventory`,
`place_from_inventory`, `execute_blueprint`, `connect_belt`, etc. — i.e.
the agent already has hand-craft capability.

### Strict mode is not a bug, it's the trigger for repair

`materialPolicy=strict` (default, `src/config.js:67`) makes
`executeBlueprint`'s internal dry-run fail with `precondition_failed`
when worker inventory is short on a required item. The failure is what
hands control to `repairWithPi`. Switching to `virtual` would silently
build with non-existent materials, hiding shortage — wrong direction.

The Phase-3 `dry-validate` (the runner step, not the executor's internal
dry-run) does **not** check inventory; it only validates port contracts
and footprint overlap. That separation is correct.

### Hand-craft is already instant

`src/factorio-server.js:3024-3088` `craft`: `inv.remove(ingredients)`
followed by `inv.insert(product)`. No game-tick wait, no animation, no
craft queue. Atomic ingredient → product transformation under strict
inventory accounting. Nothing to fix here.

### What the agent actually lacks

Three small gaps prevent the existing repair path from solving missing
items via craft:

1. **`RECIPES` table is short** (`src/factorio-server.js:162-174`, 11
   entries). Hand-craft refuses anything not in the table — it can't
   make `electronic-circuit`, `assembling-machine-1`,
   `automation-science-pack`, etc.
2. **No tool that reflects the local RECIPES set.**
   `factorio_read/early_game_catalog` exists but returns the in-game
   `force.recipes` (300+ entries) — a superset of what hand-craft
   actually accepts. The agent can be misled into trying to craft
   something that's "enabled in game" but not in our local table.
3. **`repairWithPi` prompt** (`src/runner/execute.js:98-106`) doesn't
   hint at the missing-item → craft path.

---

## Inventory visibility — the harder question

Repair-via-craft only matters once Designer can correctly express what's
already available. Today Designer only sees the worker character's
backpack (probe's `inventory_summary`). World contents — chests built in
prior epochs, in-furnace buffers, items on the ground — are invisible.
This forces Designer into "always re-mine, never reuse" patterns and
makes the repair agent re-discover storage every time.

### Three reframings, each correcting the previous

**v1 — auto-register all `outputs[].kind: inventory` ports.**
Every module's declared output of kind inventory becomes a registered
storage. Probe queries each registered chest's contents next epoch.

Rejected because:
- Buffer chests (Factorio's classic "belt-full → overflow chest" idiom)
  are typically **not** declared output ports — they're internal
  tactical storage. They'd be missed.
- A module could in principle have its declared output box deleted/
  replaced by a connection (currently this doesn't happen, but the
  registry would be brittle to it).

**v2 — Designer-declared registry with inheritance + add/remove.**
plan.yaml carries `inventory_registry` (additions) and
`inventory_registry_removals` (deletions). Runner merges with previous
epoch's registry, persisted in digest.

Rejected because:
- Mixes declaration with state. The save itself already knows what
  chests exist and what's in them.
- Adds a new abstraction (per-chest registry) that overlaps with
  module-level information already being tracked elsewhere.

**v3 — module deployment ledger as the only persisted overlay.**

The save is the single physical truth. The only thing worth persisting
is the **semantic identity** of physical structures: "this cluster of
furnaces is the iron-smelt-line deployed at epoch e2." From that
identity plus the lib module spec, all chest positions and roles are
derivable; all chest contents are live-queryable.

This is the chosen direction.

```yaml
# digest schema (cumulative across epoch chain)
deployed_modules:
  - id: p0
    module: iron-smelt-line
    anchor: { x: -78, y: -66 }
    direction: north
    deployed_at_epoch: e2
  - id: p1
    module: copper-smelt-line
    anchor: { x: -58, y: -23 }
    direction: north
    deployed_at_epoch: e3
```

**What's persisted**: just the intent overlay (id + module ref + anchor +
direction + epoch tag).

**What's derived live at probe time**:
- For each `deployed_module`, look up its lib spec
- For each `outputs[].kind: inventory` port (and any future
  `role: buffer` ports the module declares), compute world position via
  `anchor + rel_pos`, query that chest's contents, surface in
  `state.yaml.world_inventory`

**Inheritance is asymmetric on purpose**:
- placements that succeed → automatically appended to ledger
- removals are explicit: `module_decommissions: [p0]` in plan.yaml,
  applied after a successful execute (which presumably mined the
  entities)

No separate add/remove fields, no merge logic beyond append + filter.
Designer sees the ledger as state context, doesn't have to re-declare it.

### Why this collapses cleanly with the buffer-chest concern

If a module wants buffer storage, the **module spec** declares it as an
extra inventory port (e.g., `role: buffer` to distinguish from `role:
output`). It's the module author's responsibility, not a plan-level
concern. If a Designer truly needs an ad-hoc buffer, they author a tiny
new staged module — a path the system already supports.

---

## Designer's view, end state

```yaml
state.yaml:
  inventory_summary:        # worker backpack, live from worker.inv
    - { item: coal, count: 50 }
  world_inventory:          # derived from ledger + live chest queries
    - { module_id: p0, port: iron_plate_chest, item: iron-plate, count: 412 }
    - { module_id: p1, port: copper_chest,     item: copper-plate, count: 178 }
  deployed_modules:         # ledger, so Designer can reference p0/p1
    - { id: p0, module: iron-smelt-line, anchor: { x: -78, y: -66 }, ... }
  coal_patches: [...]
  iron_patches: [...]
  ...
```

Designer plans new placements knowing what raw stockpile already exists.
Repair agent, on missing-item, has the same view via `inspect_inventory`
on registered chests — it'll prefer `transfer_inventory` over `craft`
when the resource exists somewhere.

---

## Already shipped (commit 4679676)

Not strictly part of this design but a precondition: blueprint per-entity
settings bag with fuel + recipe dispatch. Replaces top-level `fuel`
array with per-entity `settings.{fuel,recipe}`, validated by an
`ENTITY_SETTINGS` registry. `assembling-machine-1` recipe setting is
ready to use for the future gear-assembler-cell module. e1-first-coal
verified end-to-end.

---

## Plan (not yet started)

Two independent strands. Each is small enough to be one commit.

### Strand A: world inventory visibility (the bigger architectural move)

1. Define `deployed_modules` ledger schema in digest
2. Runner: append to ledger after every successful placement
3. plan.yaml: support `module_decommissions: [<id>, ...]` (apply after
   execute mines the entities); dry-validate the IDs exist in the
   inherited ledger
4. Extend `world-census.lua` (or a sibling probe script) to read the
   ledger, resolve each module's inventory ports, query live counts
5. state.yaml schema: add `world_inventory` and `deployed_modules`
   sections
6. Designer prompt: explain both new views; encourage referencing
   existing `world_inventory` items before designing new mining

### Strand B: craft path completion

7. Extend `RECIPES` to cover red-science deps: `copper-cable`,
   `electronic-circuit`, `small-electric-pole`, `assembling-machine-1`,
   `inserter`, `automation-science-pack`
8. Add `factorio_read/craft_catalog` action that returns the local
   RECIPES table (not the in-game superset). Register in dispatch.
9. Update `repairWithPi` prompt: when an item is missing, query
   `craft_catalog` and craft if possible; prefer
   `transfer_inventory` from `world_inventory` over crafting.

### Out of scope for this round

- Module spec extension to declare `role: buffer` inventory ports (only
  needed once a real module wants one)
- Designer-level "auto-derive crafts from placement deficit" compiler
  (a more ambitious version that would obsolete the repair-agent path
  for missing items; revisit after observing how the Strand B agent
  actually behaves on a real run)
- Power infrastructure (boiler/steam-engine module + water probing) —
  separate epic, blocks `assembling-machine-1` actually running but
  doesn't block this round's plumbing
