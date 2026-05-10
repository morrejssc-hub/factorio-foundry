---
id: e1-first-coal
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
output_save: state/saves/e1-first-coal/
---

Build a self-fueling burner coal mining cell on a coal patch and sustain a
net coal production rate of at least 0.10 coal/s for one minute. This
validates the "select a module from lib, compose, verify/observe deterministically"
loop end-to-end.
