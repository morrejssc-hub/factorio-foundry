# Inventory visibility, craft path, and the format-rigor principle

Captured during a 2026-05-07 design discussion that came out of trying
to extend `lib/` toward red-science. Two real blockers surfaced
(executor didn't support `recipe`-on-assembler; chest contents invisible
to Designer) and walking those backwards exposed a cleaner architecture
for how persistent state, live state, agent capability, and **artifact
format rigor** fit together.

This doc captures the reasoning and the resulting plan. The plan itself
is intentionally kept in checklist form at the bottom.

---

## Format-rigor principle (architectural lens)

Sort every artifact in this project by **who reads it**:

| Bucket | Consumers | Rigor |
|---|---|---|
| **Cross-phase within an epoch** | Deterministic Node code AND/OR agents in the next phase | **Strict schema** |
| **Cross-epoch** | Mainly agents (next epoch's Designer, future repair-agents) | **Loose / MD-with-fence** |
| **Within a phase** | Same phase's agent re-entering itself, or its own scratch | **Loose / MD prose** |

The reason: only deterministic code consumption forces strict schema.
Agent-to-agent communication is more robust to free-form, and benefits
from prose annotations that schemas can't carry ("this overflow box was
added in e7 because the smelter ran ahead of the line").

### Mapping current artifacts

| Bucket | Artifact | Current form | Verdict |
|---|---|---|---|
| Cross-phase | `state.yaml` (probe → design) | half-structured | keep strict (Designer reads, later phases reference patches) |
| | `plan.yaml` placements/connections | strict yaml | keep strict (dry-validate + execute consume) |
| | `staged-modules/*.{yaml,json}` | strict | keep strict (connector-injector + executor consume) |
| | `dry-validate.json` | strict | keep strict (execute reads to gate) |
| | `audit.json` | strict | keep strict (select-winner sorts on it) |
| | save vN+1 zip | binary | irreducible |
| Cross-epoch | `state/digests/*.yaml` | strict yaml | mixed: cache layer keeps strict; intent overlay (deployed modules) moves out → `world.md` |
| | save chain | binary | irreducible |
| | (new) `world.md` | MD with `## Deployed modules` yaml fence | introduce |
| Within phase | `designer-history.yaml` | strict yaml | **mismatch — should be MD with `executor_proposal` fence**; cross-attempt narrative is the only consumer |
| | `plan.yaml`'s `scaling_note` | already free-text | already correct |
| | repair-agent working memory | not persisted | option: per-attempt scratch.md |
| | audit diagnostic prose | none today | option: optional `audit-notes.md` |
| Source (input) | `lib/modules/*.yaml` | strict | keep strict (port geometry consumed by routing) |
| | `lib/blueprints/*.json` | strict | keep strict (Lua executor consumes) |
| | `epoch.yaml` | strict + free-text `goal` | **mismatch — split into `epoch.md` (frontmatter for runner fields + body for goal)** |

Three mismatches to clean up: **designer-history**, **digests' intent
overlay**, **epoch yaml's prose body**. The world inventory work folds
the second one into a new `world.md` artifact.

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

## Inventory visibility — the hard question

Repair-via-craft only matters once Designer can correctly express what's
already available. Today Designer only sees the worker character's
backpack (probe's `inventory_summary`). World contents — chests built in
prior epochs, in-furnace buffers, items on the ground — are invisible.
This forces Designer into "always re-mine, never reuse" patterns and
makes the repair agent re-discover storage every time.

### Reframings, each correcting the previous

**v1 — auto-register all `outputs[].kind: inventory` ports.**
Rejected: misses buffer chests (Factorio's classic "belt-full →
overflow chest" idiom — not a declared output port), brittle to
plan-time chest deletions.

**v2 — Designer-declared registry with inheritance + add/remove.**
Rejected: persists state that the save already knows; introduces a
per-chest abstraction overlapping with module-level info already on
hand.

**v3 — module deployment ledger as the only persisted overlay.**
The save is the single physical truth. Persist only the **semantic
identity** of physical structures: "this furnace cluster is the
iron-smelt-line deployed at epoch e2." From that identity plus the lib
module spec, all chest positions and roles are derivable; all chest
contents are live-queryable. Closer.

**v4 (chosen) — `world.md` as the cross-epoch agent notebook.**
The ledger's consumer is mostly Designer (and repair-agent). Format
rigor principle says cross-epoch agent-to-agent communication should be
loose / MD. So make it a markdown file that mostly reads as an agent's
running journal of what's built and why, with a single small yaml
fence as the machine-readable index that probe needs to enumerate
chests.

### `world.md` shape

```markdown
# World notes

A running journal of what we've built. Edit the prose freely. The
`## Deployed modules` block has a yaml fence — that's the machine-read
section the probe uses to enumerate chests; everything else is for
agents to read.

## Deployed modules
<!-- machine-managed: runner appends after each successful execute -->
```yaml
- id: p0
  module: iron-smelt-line
  anchor: { x: -78, y: -66 }
  direction: north
  epoch: e2
- id: p1
  module: copper-smelt-line
  anchor: { x: -58, y: -23 }
  direction: north
  epoch: e3
\`\`\`

## Buffer & overflow notes
e7 noticed p0's output box hits cap whenever red-science demand drops;
keep an eye on it.

## Stockpile intent
- p0 chest: feed gear-assembler in e10
- p1 chest: copper-cable buffer for electronic-circuit (planned e11)

## Open puzzles
- e_test_proposal-loop's c1 audit briefly read 0 coal — turned out to
  be off-patch anchor (fixed in f8cfa21). Cautionary note.
```

### What's persisted vs derived

**Persisted** (the yaml fence): `[{id, module, anchor, direction,
epoch}]`. Tiny. ~5 lines per deployed module.

**Derived live at probe time**: For each entry, look up its lib spec,
compute `anchor + rel_pos` for each `outputs[].kind: inventory` port,
query that chest's contents, surface in `state.yaml.world_inventory`.
Nothing about counts ever lives in `world.md`.

### Inheritance is asymmetric

- Successful placements → automatically appended to fence (machine-managed)
- Removals are explicit: `module_decommissions: [<id>, ...]` in
  plan.yaml; runner removes from fence after successful execute (which
  presumably mined the entities)
- Prose sections are agent-managed end-to-end; runner doesn't touch them

### Why the buffer-chest concern dissolves

If a module wants buffer storage, the **module spec** declares it as an
extra inventory port (e.g., `role: buffer`). It's the module author's
responsibility, not a plan-level concern. If a Designer truly needs an
ad-hoc buffer, they author a tiny new staged module — a path the system
already supports.

---

## Designer's view, end state

```yaml
state.yaml (probe output, cross-phase strict):
  inventory_summary:        # worker backpack, live from worker.inv
    - { item: coal, count: 50 }
  world_inventory:          # derived from world.md fence + live chest queries
    - { module_id: p0, port: iron_plate_chest, item: iron-plate, count: 412 }
    - { module_id: p1, port: copper_chest,     item: copper-plate, count: 178 }
  coal_patches: [...]
  iron_patches: [...]
```

Plus, in Designer's cwd: `world.md` symlinked from `state/world.md`,
read via `read` tool like any other doc. Designer's prompt mentions
both the structured `world_inventory` view and the prose context.

Repair agent on missing-item, has the same view via `inspect_inventory`
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

## Plan

Three independent strands. Each is small enough to be one commit. Order
is not strict — A and B are mostly independent; C is purely bookkeeping
that becomes more valuable as A/B add new artifacts.

### Strand A: world.md + world inventory visibility

A1. Define `world.md` location (`state/world.md`) and shape (prose +
    `## Deployed modules` yaml fence).
A2. Runner: append-to-fence on successful placement; remove-from-fence
    when plan.yaml's `module_decommissions` are honored.
A3. plan.yaml: support `module_decommissions: [<id>, ...]`;
    dry-validate the IDs exist in the inherited fence.
A4. Probe (`world-census.lua` or sibling): read fence, resolve each
    module's inventory ports, query live counts.
A5. state.yaml schema: add `world_inventory` section.
A6. design.js: symlink `world.md` into design cwd; Designer prompt
    explains both the structured `world_inventory` view and the prose
    context.

### Strand B: craft path completion

B1. Extend `RECIPES` to cover red-science deps: `copper-cable`,
    `electronic-circuit`, `small-electric-pole`, `assembling-machine-1`,
    `inserter`, `automation-science-pack`.
B2. Add `factorio_read/craft_catalog` action that returns the local
    RECIPES table. Register in dispatch.
B3. Update `repairWithPi` prompt: when an item is missing, prefer
    `transfer_inventory` from `world_inventory`; fall back to
    `craft_catalog` + `craft` if the item is craftable; else mine.

### Strand C: format-rigor cleanups (mismatch fixes)

C1. **`designer-history.yaml` → `designer-history.md`**: convert the
    cross-attempt failure narrative to MD; keep `executor_proposal`
    fields in a yaml fence (root_cause, suggested_changes, failed step).
    Update `flushHistory()` writer + Designer prompt reader.
C2. **`epoch.yaml` → `epoch.md`** (optional, lower priority): split
    into MD with frontmatter for runner fields + body for `goal` prose.
    Keeps yaml-only path working as legacy fallback while migration
    happens. May defer until enough yaml epochs exist that the friction
    becomes obvious.

### Out of scope for this round

- Module spec extension to declare `role: buffer` inventory ports (only
  needed once a real module wants one).
- Designer-level "auto-derive crafts from placement deficit" compiler
  (a more ambitious version that would obsolete the repair-agent path
  for missing items; revisit after observing how the Strand B agent
  actually behaves on a real run).
- Power infrastructure (boiler/steam-engine module + water probing) —
  separate epic, blocks `assembling-machine-1` actually running but
  doesn't block this round's plumbing.
- Per-attempt repair-agent scratch.md (option floated above; not
  needed until we observe a case where loss of agent working memory
  hurts).
