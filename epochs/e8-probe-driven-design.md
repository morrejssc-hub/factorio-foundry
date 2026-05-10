---
id: e8-probe-driven-design
kind: composition
depends_on:
  - e0-bootstrap
input_save: state/saves/e0-bootstrap-v1.zip
target_metric:
  meter: lib/meters/throughput-window.lua
  params:
    item: coal
    min_rate_per_s: 0.1
    window_ticks: 3600
allowed_modules:
  - coal-burner-cell
budgets:
  probe_timeout_ms: 600000
  design_timeout_ms: 600000
  execute_timeout_ms: 600000
output_save: state/saves/e8-probe-driven-design-v1.zip
---

First epoch that requires the Designer to use factorio_read (tile-info,
validate-placement) to explore the world and validate placements, rather
than relying solely on state.yaml pre-computed hints.

The probe phase produces a minimal state.yaml: inventory, tick, and raw
patch bounds — but no recommended anchors, no pre-validated positions.
The Designer must:
  (a) Use factorio_read with lib/probes/tile-info.lua to scan the coal
      patch area and find clear tiles for the module footprint.
  (b) Use factorio_read with lib/probes/validate-placement.lua to confirm
      the chosen anchor before writing plan.yaml.
  (c) Write plan.yaml with a coal-burner-cell placement that passes verify.

This validates that the foundry-read pi extension wires correctly into the
design phase and that the Designer can reason from live game queries rather
than pre-digested summaries.
