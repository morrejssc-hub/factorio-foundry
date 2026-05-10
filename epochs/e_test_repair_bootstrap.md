---
id: e_test_repair_bootstrap
kind: bootstrap
starter_inventory:
  - item: stone-furnace
    count: 1
  - item: transport-belt
    count: 120
  - item: burner-inserter
    count: 8
  - item: iron-chest
    count: 4
  - item: coal
    count: 50
  - item: iron-plate
    count: 30
  - item: stone
    count: 10
output_save: state/saves/e_test_repair_bootstrap-v1.zip
---

Bootstrap save for the repair-agent craft-path verification (e_test_repair_craft).
Starter inventory deliberately omits burner-mining-drill: the test fixture's
single coal-burner-cell placement will fail with precondition_failed (drill
missing) and force repair-agent to craft one from raw iron+gear+furnace.
