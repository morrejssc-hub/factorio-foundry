---
id: e_test_repair_craft
kind: composition
depends_on:
  - e_test_repair_bootstrap
input_save: state/saves/e_test_repair_bootstrap-v1.zip
target_metric:
  meter: lib/meters/throughput-window.lua
  params:
    item: coal
    min_rate_per_s: 0.1
    window_ticks: 3600
allowed_modules:
  - coal-burner-cell
recovery_attempts: 1
budgets:
  probe_timeout_ms: 600000
  design_timeout_ms: 600000
  execute_timeout_ms: 600000
output_save: state/saves/e_test_repair_craft-v1.zip
_fixture:
  attempts:
    - fixtures/repair-craft/attempt-1
---

Test fixture: deterministically force a missing-drill failure on the
single coal-burner-cell placement at the known-clear (-78,-13) anchor.
Starter inventory has 0 burner-mining-drills, so placement fails with
precondition_failed (missing burner-mining-drill). repairWithPi fires;
the prompt routes the agent to craft_catalog → craft 3 iron-gear-wheels
→ craft 1 burner-mining-drill → re-call execute_blueprint. Audit pass
means the repair path produced a fully-working cell.
