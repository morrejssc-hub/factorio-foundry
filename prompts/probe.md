# Probe phase

You are running the **Probe phase** of a Factorio epoch.

Your only job is to write `state.yaml` in the current directory describing the
relevant world state for the upcoming epoch. You will not place anything, mine
anything, or change the world.

Use the `factorio_read` tool to gather facts. Allowed actions: `status`,
`logs`, `inspect_position`, `inspect_area`, `inspect_inventory`,
`early_game_catalog`, `production_stats`, `query_script`. Do NOT use the
`factorio_action` tool — it is not in your tool list, and any call to it is a
violation.

## Output is schema-validated. Read this carefully.

`state.yaml` is parsed and validated by `src/runner/probe.js` immediately after
you exit. The runner spawns you with cwd already set to your phase workdir;
**use the bare relative path `state.yaml`** when calling the `write` tool. Do
not use absolute paths, do not use `../state.yaml`, do not write into any
subdirectory or parent directory — the validator reads exactly
`<your-cwd>/state.yaml` and nothing else.

The validator checks **exactly these top-level keys** and **fails the entire
epoch** if any are missing or wrong-typed:

| key                 | required | type                                                          |
|---------------------|----------|---------------------------------------------------------------|
| `tick`              | yes      | number                                                        |
| `worker`            | yes      | object with `.position.x` and `.position.y` (both numbers)    |
| `inventory_summary` | yes      | array of `{item: string, count: number}`                      |
| `coal_patches`      | yes      | **array** (use `[]` if none) — element shape below            |
| `iron_patches`      | yes      | **array** (use `[]` if none) — element shape below            |
| `notes`             | optional | free-form string                                              |

**Required field traps that will make the validator reject your output:**

- `coal_patches` and `iron_patches` are **plural arrays**, never singular.
  Writing `coal_patch:` (singular) or `coal_patches:` as a single object
  fails. If you found exactly one patch, you still write
  `coal_patches:\n  - {...}` (a one-element list).
- `iron_patches` must be present even when there is no iron to report — write
  `iron_patches: []`. Omitting it fails the epoch.
- Each patch element is exactly `{center: {x, y}, tile_count: <number>,
  total_amount: <number>}`. Do not nest extra fields like `peak_tiles`,
  `drill_footprint_coal`, `density_range` inside patch elements — the
  Designer phase does not consume them and they add noise.
- Do **not** add extra top-level keys (`module`, `anchor`, `target_metric`,
  `placement_validation`, `phase`, `epoch`, etc.). The schema is closed:
  produce only the six keys in the table above.

## How to find resource patches

Run `lib/find-resource-patch.lua` via `factorio_read action=query_script
script=lib/find-resource-patch.lua params={center_x, center_y, radius,
resource}` — this returns clusters of tiles for the named resource. The
`resource` param defaults to `"coal"`; pass `resource: "iron-ore"` for iron,
`resource: "copper-ore"` for copper, `resource: "stone"` for stone, etc. Pick
a sensible center (try worker position first; if no patches found, try (0,0)).

When the epoch goal mentions iron, run the script twice — once with default
`resource` (coal) and once with `resource: "iron-ore"` — so both
`coal_patches` and `iron_patches` in `state.yaml` reflect actual on-map data.

The older `lib/find-coal-patch.lua` is still present as a coal-only shim, but
prefer the generalized script above so iron/copper/etc. probes use the same
code path.

## Reference: a valid `state.yaml`

The following is the literal shape the validator accepts. Match it.

```yaml
tick: 3973
worker:
  position: { x: 0, y: 0 }
inventory_summary:
  - { item: coal, count: 50 }
  - { item: iron-plate, count: 20 }
  - { item: transport-belt, count: 20 }
  - { item: burner-inserter, count: 8 }
  - { item: burner-mining-drill, count: 4 }
  - { item: iron-chest, count: 4 }
  - { item: stone-furnace, count: 2 }
  - { item: stone, count: 10 }
coal_patches:
  - center: { x: -48, y: -85 }
    tile_count: 324
    total_amount: 420000
iron_patches: []
notes: |
  Large coal patch ~48 tiles SW of worker. No iron in 100-tile radius
  (not needed for this epoch).
```

## Budget

Aim for under 30 tool calls. Stop and write `state.yaml` once you have enough
information for the epoch's stated goal. Do not over-explore. Anything you
discover that doesn't fit the schema goes in `notes:` as free text — never as
extra structured keys.
