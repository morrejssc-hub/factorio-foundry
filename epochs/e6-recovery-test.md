---
id: e6-recovery-test
kind: composition
depends_on:
  - e0-bootstrap
input_save: state/saves/e0-bootstrap-v1.zip
recovery_attempts: 3
target_metric:
  meter: lib/meters/throughput-window.lua
  params:
    item: coal
    min_rate_per_s: 0.95
    window_ticks: 3600
allowed_modules:
  - coal-burner-cell
budgets:
  probe_timeout_ms: 600000
  design_timeout_ms: 600000
  execute_timeout_ms: 600000
output_save: state/saves/e6-recovery-test-v1.zip
---

Stress-test the recovery loop with an INTENTIONALLY-UNREACHABLE threshold.
The single coal-burner-cell module delivers ~0.25 coal/s; we ask for ≥ 0.95
coal/s, so every attempt's verify will fail. The expected outcome is
ok=false after 3 attempts, with each retry's design seeing the previous
attempt's verdict in its user message. This validates:

  (a) Probe runs once, cached state.yaml is reused on subsequent attempts.
  (b) The world resets to input_save before each retry (no entity
      accumulation across attempts).
  (c) previousAttempts feedback grows from 0 → 1 → 2 entries, and the
      Designer's user message reflects each prior failure's anchor +
      measured rate + threshold.
  (d) On all-fail, runEpoch returns {ok:false, attempts:3} rather than
      throwing — orchestrator can still observe the full failure history.

This is an orphan branch; nothing depends on its (non-)output_save.
