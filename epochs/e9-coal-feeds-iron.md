---
id: e9-coal-feeds-iron
kind: composition
depends_on:
  - e0-bootstrap
input_save: state/saves/e0-bootstrap-v1.zip
target_metric:
  meter: lib/meters/throughput-window.lua
  params:
    item: iron-plate
    min_rate_per_s: 0.05
    window_ticks: 3600
allowed_modules:
  - coal-burner-cell
  - iron-smelt-line
budgets:
  probe_timeout_ms: 600000
  design_timeout_ms: 600000
  execute_timeout_ms: 600000
output_save: state/saves/e9-coal-feeds-iron-v1.zip
---

From the e0-bootstrap save, place two modules in one epoch:
  p0: coal-burner-cell on the coal patch — provides continuous coal output
  p1: iron-smelt-line on the iron patch — smelts iron ore into iron plates

After both modules are placed, the executor routes a transport-belt from
p0's coal_belt output port to p1's coal_in input port. That belt delivers
coal continuously to the iron-smelt-line's fuel inserters, keeping the drill
and furnace running indefinitely.

The Designer must:
  (a) Read state.yaml to find both the coal patch and the iron patch.
  (b) Choose anchors so p0 sits on the coal patch and p1 sits on the iron patch,
      with no footprint overlap.
  (c) Declare a connection: from "p0.coal_belt" to "p1.coal_in".
  (d) Verify expected_throughput ≥ 0.05 iron-plate/s (module port rate is 0.20).

This is the first epoch that exercises inter-module belt connections.
