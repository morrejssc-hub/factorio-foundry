# Verify Plan — phase rename + item-port harness

Last revised: 2026-05-08
Scope: this document covers the **item harness** (chest +
top-tier inserter at module ports). The power harness
(accumulator + magic discharge) and fluid harness
(storage-tank + magic refill/drain) are forward-compatible with the
same architecture but are out of scope for this iteration. We pick
"item" first because the restart starts at e1 (coal mining) and
e1–e3 are entirely item-port modules.

## Why this exists

The audit has been doing two unrelated jobs:

1. **Probe** — measure what's flowing in the world right now.
2. **Judge** — decide whether the design works.

These got conflated. A coal-burner-cell whose belt-end chest happens
to fill up during the audit window will measure low throughput —
that's a measurement artefact (the harness, not the design,
bottlenecked it), but the verdict "fail" attaches to the design.

The correct shape is:

- **Verify**: "given idealised inputs and outputs, does this design
  produce its claimed metric?" — done in a controlled rig, gates
  pass/fail.
- **Record**: "what does the persistent world look like right now?"
  — observational, no judgement, feeds the digest so downstream
  epochs can probe state.

This doc specifies how the verify side gets built. Record is the
existing post-execute audit, demoted to observational role.

## Glossary (canonical)

The vocabulary settled in this session, fixed for forward
discussion:

**Pipeline phases**

| name | what it does | gates pass/fail? |
|---|---|---|
| `probe` | observe persistent world → write `state.yaml` | no |
| `design` | author plan + (if module-creation) staged module files | no |
| `verify` | static checks + harness-rig live test | **yes** |
| `execute` | apply verified plan to persistent save (no harness) | no |
| `record` | snapshot persistent world to `state/digests/<epoch>.md` | no |

`verify` replaces today's `dry-validate` name. The static portion
(schema, footprint, connections) is unchanged; a new live-test
substep is added. `execute` keeps the name but loses its
"verification" responsibility. `audit` is renamed `record` to
clarify it doesn't judge anything.

**Object terms**

| term | meaning |
|---|---|
| **module** | reusable unit in `lib/modules/`, declares ports + footprint + blueprint + meters |
| **placement** | a module instance in `plan.placements[]` |
| **port** | input/output of a module, with `kind: belt | inventory | pipe | power` |
| **plan** | designer output: `placements` + `connections` + `preparation` |

**Test rig terms**

| term | meaning |
|---|---|
| **harness** | the temporary helper entities verify places to feed inputs / drain outputs / load networks |
| **harness force** | `audit-harness` Factorio force, isolated from the player force so harness entities don't pollute production statistics |
| **harness ticker** | the periodic refill/drain loop that runs during the verify window |

**Measurement and judgement**

| term | meaning |
|---|---|
| **meter** | a lua script that reads the world and returns a numeric metric (replaces the ambiguous "audit script") |
| **metric** | a labelled scalar (e.g. `power_kw`, `coal_per_s`) — what a meter reports |
| **criterion** | a pass/fail rule applied to a metric or world state — `success_criteria[]` entries |
| **verdict** | aggregated criterion results: `{pass: bool, criteria: [{kind, pass, ...}, ...]}` |

Note: `lib/audits/` is not renamed yet. Renaming is bookkeeping;
defer unless we touch every file there for other reasons.

## Phase pipeline (verify substeps)

```
probe → design → verify → execute → record
                   │
                   ├─ static  (schema, footprint, connections)
                   ├─ harness-place   (auto-derived from ports + plan)
                   ├─ ticker-start    (RCON polling loop)
                   ├─ window-wait     (default 60s @ 60 TPS)
                   ├─ meter           (run module's meter scripts)
                   ├─ criteria        (evaluate success_criteria)
                   ├─ ticker-stop
                   └─ harness-teardown (delete by force)
```

Failure paths:

- static fails → retry design (existing)
- harness-place fails → bug; surface as runner error, no retry
- meter or criteria fails → retry design (existing); harness is
  always torn down before the next attempt
- harness-teardown fails → log, continue; verify result already
  computed

`execute` after `verify` re-applies the plan to the input save (the
verify run mutates a fork; execute is what produces the
to-be-promoted save). Wait — see "save lifecycle" below; this
might collapse with verify in some implementations.

## Save lifecycle

Each `run-epoch.js` invocation already operates on a fork:
`input_save.zip` is loaded into Factorio at the start, the run
mutates the in-memory world, output is saved to a per-attempt zip
under `state/saves/<epoch>/`, and the input is never touched. So
"verify on a fork, fail rolls back automatically" is the existing
behaviour — the input save is the fork base.

For verify to live cleanly inside this lifecycle:

1. Load input_save (existing).
2. Place modules (existing — was `execute`).
3. Place harness on the harness force (new).
4. Start ticker (new).
5. Wait window (existing).
6. Run meter, evaluate criteria (existing, slightly moved).
7. Stop ticker (new).
8. **If verdict.pass**: teardown harness, save game → candidate save
   → promotion logic decides if it becomes winner.
9. **If verdict.fail**: don't save; the next attempt cold-starts
   Factorio from input_save again.

This is structurally what we already do, just with harness inserted
between (2) and (5) and torn down before (8). No need for a
separate `execute` phase post-verify — the placements are the same
ones that were just live-tested. `execute` as a top-level phase name
collapses; the meaningful boundary is verify (with harness) vs
record (no harness, persistent state).

Revised pipeline, after this collapse:

```
probe → design → verify → record
                   │
                   ├─ static
                   ├─ place modules
                   ├─ place harness
                   ├─ run window + meter + criteria
                   ├─ teardown harness
                   └─ save (only on pass)
```

`record` is just "read the persistent save we just produced and
write a digest" — no live world interaction.

## Item harness

For every port of every placement where `kind` is `belt` or
`inventory`, the harness places a chest + a top-tier inserter.

### Inserter choice

Use `bulk-inserter` (Factorio 2.0; was "stack-inserter" in 1.x).
Reasons:

- Highest base throughput (~2.31 swings/s × stack size 4 = 9+
  items/s) — comfortably saturates any belt the modules under test
  produce in the burner era.
- Single tier means we don't need to track research state of the
  player force.

If the harness force has all techs unlocked (see "Force isolation"),
we can place bulk inserters regardless of the player's research.

### Per-port placement geometry

Each port has:

- `rel_pos: [dx, dy]` — anchor-relative tile center
- `side: north | east | south | west` — which face of the module
  the port projects from
- `kind: belt | inventory | ...`
- `item: <factorio-item-name>`

The harness picks **one tile outward** from the port (in the `side`
direction) for the inserter and **two tiles outward** for the chest.
The inserter's facing is set so its pickup is the port tile (for
output ports) or its drop is the port tile (for input ports).

Example: port `coal_belt` at rel_pos `(2.5, 0.5)`, side `south`,
kind `belt`. Module placement at anchor `(0, 0)` direction `north`.
Port world position: `(2.5, 0.5)` (northbound module = identity
rotation).

For an **output** port:
- Inserter at world `(2.5, 1.5)` facing north (pickup north → the
  port tile, drop south → the chest)
- Chest at world `(2.5, 2.5)`

For an **input** port: inserter facing flipped (pickup south = the
chest, drop north = port tile).

For ports with `kind: inventory` (passive store like a chest), the
harness collapses to "another chest adjacent + inserter between the
two", and the magic ticker drains the **module's own chest** rather
than placing extra entities. (TBD: this case might be cleaner if
the harness instead drains the module's chest directly with no
helper inserter — simpler, same effect. Pick during implementation.)

### Magic ticker (item ports)

A polling loop, runs once every 5 seconds during the window:

- For each input chest in the harness: ensure it has at least
  `desired_buffer` of the port's `item`. If short, `inv.insert`
  from nothing (creator force can spawn items).
- For each output chest in the harness: clear all items
  (`inv.clear()`).

5s polling = 12 invocations during a 60s window. Latency tolerance:
items in transit during the 5s gap can build up backpressure on a
near-saturated output, but at burner-cell rates (0.18 coal/s) a 5s
gap means ~1 coal in transit — negligible.

Implementation: extend the existing `runAudit` `waitTicks` loop to
yield control every 5s (or implement as a separate
`runHarnessTicker` that runs in a `setInterval` parallel to
wait_ticks). The simpler form is yield-and-poll.

`desired_buffer` for input chests: enough to feed a 60s window at
the port's declared throughput, with a safety factor. For an input
expecting 0.18 coal/s, `desired_buffer = 0.18 × 60 × 2 = 22 coal`.
Cap chests are 48 slots × stack size, so the absolute upper bound
is way above any realistic burner-era flow. Ticker just refills
to a fixed comfortable target like 200 items.

### Force isolation

Why not put harness on the player force: the meter reads
`force.get_item_production_statistics(surface)` which would include
items handled by harness inserters as "consumption", muddling the
signal.

Approach: at startup of the verify-capable factorio service (or on
first verify run), create a force named `audit-harness`:

```lua
if not game.forces["audit-harness"] then
  local f = game.create_force("audit-harness")
  -- Unlock all relevant tech so harness can place advanced inserters
  f.research_all_technologies()
  -- Friendly to player so inserters don't trigger combat
  f.set_friend("player", true)
  game.forces.player.set_friend("audit-harness", true)
  -- Cease-fire both ways too
  f.set_cease_fire("player", true)
  game.forces.player.set_cease_fire("audit-harness", true)
end
```

Verify-place sets `force = "audit-harness"` for every harness
entity. Teardown finds `find_entities_filtered{force = "audit-harness"}`
and destroys all.

Caveat: inserters on a different force may or may not be willing to
interact with player-force belts/chests. Vanilla Factorio's
inserter behaviour: an inserter checks `entity.can_be_inserted`
(or similar) on the target — friendly force is treated like own.
Confirm during implementation; if inserters refuse, fall back to
harness on player force + tag-based teardown.

## File-level changes

Listing what gets touched, ordered by dependency:

1. **`src/factorio-server.js`**
   - Add `place_harness` action: takes `placements` (each with
     `module_id`, `anchor`, `direction`) and `port_specs` (per-port
     `{kind, side, rel_pos, item, role: input|output}`); returns
     placement results.
   - Add `harness_tick` action: takes the same harness manifest and
     does the per-tick refill/drain. Idempotent.
   - Add `harness_teardown` action: destroys all entities on
     `audit-harness` force.
   - Add `audit-harness` force creation at server boot (idempotent).
   - These are mutating actions → add to `MUTATING_ACTIONS` set.

2. **`src/runner/verify.js`** (new file)
   - Exports `runVerify({config, plan, modules, epoch, outDir, ...})`.
   - Orchestrates static → place modules → place harness → ticker
     → meter → criteria → teardown.
   - Static portion delegates to existing `dry-validate.js`.
   - Module placement reuses `placeOne` from current `execute.js`.
   - Harness placement derives port_specs from each placement's
     module and emits one harness call.
   - Ticker runs as a `setInterval` during `waitTicks`; cancelled
     on completion or error.
   - Meter + criteria delegate to existing `audit.js#runAudit`
     (which already does the resolveAudit + evaluateCriteria flow).

3. **`src/runner/epoch.js`**
   - Replace `runExecute` + `runAudit` calls with one
     `runVerify` call.
   - On pass: save game (existing logic), promote to winner.
   - On fail: skip save, retry per existing retry policy.
   - Record phase: stays as `writeDigest` (already observational).

4. **`src/runner/dry-validate.js`** — no logic change, but its
   call site moves into `runVerify`. Keep as a function, not a
   phase-level entry point.

5. **`src/runner/execute.js`** — split: keep `placeOne`,
   `routeConnections`, `repairWithPi`, `runPreparation` (these are
   now sub-helpers of verify). Drop the top-level `runExecute`
   wrapper, or keep it as an alias that calls runVerify for backward
   compatibility during transition.

6. **`prompts/design.md`**
   - "Tearing down" section already covers `preparation` for
     player-placed entities. No changes needed for harness — it's
     transparent to Designer.
   - Add a note: "the verify phase places harness entities adjacent
     to your module's ports automatically; do NOT include test-load
     accumulators or sink chests in your blueprint or you'll fight
     the harness for tile space."

7. **`epochs/e4-steam-power.yaml`** — note: the steam-power module
   that Designer authors must NOT include accumulators (harness
   handles that). Out of scope here; document under power harness.

## Test points

What's testable in JS unit tests vs requires live Factorio:

- **JS unit-testable**:
  - port → world coord computation (rotation by direction)
  - per-port harness manifest derivation (which entities, which tiles)
  - magic ticker logic (input chest refill amount, output chest
    drain) given a fake server state
  - schema for `verify`-related fields (none new in plan.yaml; all
    derived from existing module ports)

- **Live-Factorio-only** (run as part of e1 verification, the
  smoke test):
  - place_harness lua: does it actually create the entities at the
    right tiles?
  - audit-harness force creation idempotent on second run?
  - inserters with cross-force friend relations actually swing?
  - magic refill in the ticker actually takes effect?
  - teardown removes everything cleanly?
  - meter sees clean stats (harness didn't pollute production)?

For the live cases, the test harness IS e1 itself: when e1 verifies
correctly, the entire harness pipeline is exercised.

## Done criteria for this iteration

1. Phase rename `dry-validate` → `verify` lands; `execute` /
   `audit` collapse described above is implemented.
2. Item harness places chest + bulk-inserter at every belt /
   inventory port of every placement.
3. Magic ticker keeps input chests at their target buffer and
   output chests empty during the window.
4. `audit-harness` force is created idempotently and isolated from
   player force in production stats.
5. Teardown removes 100% of harness entities; persistent save
   contains only player-force entities.
6. e1 verifies under the new pipeline. Verdict shape unchanged
   (existing `nonzero{coal_per_s}` legacy criterion, auto-coerced).
7. e2, e3 verify without changes (their item-port modules feed the
   same harness shape).
8. Tests pass. `npm test` covers the unit-testable surface; live
   verification is via the e1 → e3 chain.

## What's NOT in this iteration

- Power harness (accumulator + discharge ticker) — separate doc
  when e4-steam-power restart begins.
- Fluid harness (storage-tank refill/drain) — same.
- Per-tick precision sampling — see TODO.
- Phase rename in lib paths (`lib/audits/` → `lib/meters/`) — pure
  rename, defer until we touch those files for other reasons.

## Sequencing with restart-plan.md

`restart-plan.md` currently lists e1 → e4 as the re-run target.
With this verify work intervening, the order becomes:

1. Implement verify + item harness (this doc)
2. Re-run e1, e2, e3 to confirm item harness works
3. Implement power harness (forthcoming doc)
4. Re-run e4-steam-power to confirm power harness works
5. Update restart-plan.md to reflect the new pipeline names in its
   sequence and done criteria
