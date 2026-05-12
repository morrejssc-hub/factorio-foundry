---
id: e4-steam-power
kind: composition
depends_on:
  - e3-first-copper
input_save: state/saves/e3-first-copper/
allow_module_creation: true
target_metric:
  metric: power_kw
  params:
    window_ticks: 3600
success_criteria:
  - kind: build_only
  - kind: entity_exists
    name: steam-engine
  - kind: threshold
    field: max_kw
    op: ">="
    value: 100
allowed_modules:
  - steam-power-line
recovery_attempts: 3
budgets:
  probe_timeout_ms: 600000
  design_timeout_ms: 1800000
  execute_timeout_ms: 600000
output_save: state/saves/e4-steam-power/
---

Author and verify a NEW module `steam-power-line` that generates electric
power from coal and water. The module must contain: offshore-pump (draws
water), boiler (burns coal to generate steam), steam-engine (produces
electricity), and small-electric-pole(s) for power distribution.

Place one instance adjacent to a water source (visible in state.yaml's
water_patches field) and sustain ≥ 100 kW power output for one minute.
Use `direction: north` in `plan.yaml`; `steam-power-line`'s blueprint already
encodes the south-facing boiler/engine entity directions.

Why this epoch exists: e1-e3 use burner-only modules (no electricity).
Steam power is the prerequisite for assembling-machine-1 and electric-mining-drill.
This epoch validates that the Designer can author a module with:
(a) non-resource preconditions (water_source), (b) pipe connections between
pump→boiler→steam-engine, and (c) power output meter (not throughput-window).

This epoch continues the state chain (e0→e1→e2→e3→e4) because subsequent
red bottle production needs the electric network established here.

Inventory budget (from e3): coal/iron/copper production running, plus
remaining e0 bootstrap items. Need: 1 offshore-pump, 1 boiler, 1 steam-engine,
2-4 small-electric-poles, 1 burner-inserter, ~10 transport-belts for coal feed,
~2 pipes. Coal supply can be routed from existing coal-burner-cell output.

Threshold rationale: one steam-engine at full load produces 900 kW. At
partial load (cold start, belt stall), we expect ~510-700 kW steady state.
The 100 kW threshold accepts a working but not-yet-optimized plant.
