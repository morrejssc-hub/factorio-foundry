---
id: e_test_proposal-loop
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
  - far-sink
allow_module_creation: true
recovery_attempts: 2
budgets:
  probe_timeout_ms: 600000
  design_timeout_ms: 600000
  execute_timeout_ms: 600000
output_save: state/saves/e_test_proposal-loop-v1.zip
_fixture:
  attempts:
    - fixtures/proposal-loop/attempt-1
    - fixtures/proposal-loop/attempt-2
---

Test fixture: deterministically exercise the executor proposal loop.
Attempt 1 emits a plan whose belt connection cannot route (the goal port
is 2000 tiles away; A* exhausts maxIterations). Execute writes
proposal.json, epoch.js injects executor_proposal into designer-history.
Attempt 2 emits a clean coal-burner-cell-only plan that verify passes.
