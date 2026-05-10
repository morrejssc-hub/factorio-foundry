---
id: e6-red-bottle
kind: composition
depends_on:
  - e5-gear
input_save: state/saves/e5-gear/
allow_module_creation: true
target_metric:
  meter: lib/meters/throughput-window.lua
  params:
    item: automation-science-pack
    min_rate_per_s: 0.02
    window_ticks: 3600
allowed_modules:
  - red-bottle-production
budgets:
  probe_timeout_ms: 600000
  design_timeout_ms: 600000
  execute_timeout_ms: 600000
recovery_attempts: 3
output_save: state/saves/e6-red-bottle/
---

On top of the e5 save (which has coal, iron, copper, steam power, and
gear production running), place a NEW module `red-bottle-production`
that produces automation-science-pack (red bottle) using an
assembling-machine-1 powered by the electric grid.

Recipe: iron-gear-wheel (1) + copper-plate (1) → automation-science-pack (1)
The module needs: assembling-machine-1, iron-gear-wheel input (from e5),
copper-plate input (from e3), and electricity (from e4).

Sustain a net automation-science-pack production rate of at least 0.02/s
for one minute.

Why this epoch: completes the red-bottle milestone — the full chain
from raw ore to science packs.
