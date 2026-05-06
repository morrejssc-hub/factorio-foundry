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

## Required output schema

Write `state.yaml` (and only `state.yaml`) at the root of your working
directory. It must contain:

```yaml
tick: <number>
worker:
  position: { x: <number>, y: <number> }
inventory_summary:
  - { item: <string>, count: <number> }   # only items with count > 0
coal_patches:
  - { center: { x, y }, tile_count: <number>, total_amount: <number> }
iron_patches:
  - { center: { x, y }, tile_count: <number>, total_amount: <number> }
notes: <free-form short string about anything important the planner needs>
```

Empty arrays are fine. If a section is irrelevant to this epoch (e.g. iron is
not needed yet) you may write `iron_patches: []`.

## How to find resource patches

Run `lib/find-coal-patch.lua` via `factorio_read action=query_script
script=lib/find-coal-patch.lua params={center_x, center_y, radius}` — this
returns clusters of coal tiles. Pick a sensible center (try worker position
first; if no patches found, try (0,0)).

## Budget

Aim for under 30 tool calls. Stop and write `state.yaml` once you have enough
information for the epoch's stated goal. Do not over-explore.
