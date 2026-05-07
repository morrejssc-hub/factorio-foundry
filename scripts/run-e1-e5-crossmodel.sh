#!/usr/bin/env bash
# Cross-model re-run of e1-e5 with qwen3.6-plus (default).
# Runs sequentially (shared Factorio server).
# After each epoch, reads run-meta.json and logs pass/fail.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EPOCHS=(e1-first-coal e2-first-iron e3-first-copper e4-coal-pair e5-coal-cluster-cell)
SUMMARY_FILE="$ROOT/notes/cross-model-e1-e5-qwen-$(date +%Y-%m-%dT%H-%M-%S).md"

echo "# Cross-model e1-e5 — qwen3.6-plus — $(date)" > "$SUMMARY_FILE"
echo "" >> "$SUMMARY_FILE"
echo "| epoch | pass | measured | threshold | item | attempts | wall_ms |" >> "$SUMMARY_FILE"
echo "|---|---|---|---|---|---|---|" >> "$SUMMARY_FILE"

for EPOCH in "${EPOCHS[@]}"; do
  echo ""
  echo "=============================="
  echo "Running $EPOCH ..."
  echo "=============================="

  START_TS=$(date +%s%3N)
  # Default provider/model = qwen3.6-plus via .pi/agent/settings.json
  node "$ROOT/scripts/run-epoch.js" "$EPOCH" || true
  END_TS=$(date +%s%3N)
  WALL=$((END_TS - START_TS))

  # Find the most recent run dir for this epoch
  RUN_DIR=$(ls -td "$ROOT/plans/${EPOCH}-"* 2>/dev/null | head -1 || echo "")
  if [ -z "$RUN_DIR" ]; then
    echo "| $EPOCH | ERROR | — | — | — | — | ${WALL} |" >> "$SUMMARY_FILE"
    continue
  fi

  META="$RUN_DIR/run-meta.json"
  if [ ! -f "$META" ]; then
    echo "| $EPOCH | ERROR (no run-meta) | — | — | — | — | ${WALL} |" >> "$SUMMARY_FILE"
    continue
  fi

  PASS=$(node -e "const m=JSON.parse(require('fs').readFileSync('$META')); console.log(m.ok)")
  MEASURED=$(node -e "const m=JSON.parse(require('fs').readFileSync('$META')); console.log(m.final_verdict?.measured ?? 'null')")
  THRESHOLD=$(node -e "const m=JSON.parse(require('fs').readFileSync('$META')); console.log(m.final_verdict?.threshold ?? 'null')")
  ITEM=$(node -e "const m=JSON.parse(require('fs').readFileSync('$META')); console.log(m.final_verdict?.item ?? 'null')")
  ACTUAL_ATTEMPTS=$(node -e "const m=JSON.parse(require('fs').readFileSync('$META')); console.log(m.actual_attempts)")

  echo "| $EPOCH | $PASS | $MEASURED | $THRESHOLD | $ITEM | $ACTUAL_ATTEMPTS | $WALL |" >> "$SUMMARY_FILE"
  echo "  → pass=$PASS measured=$MEASURED threshold=$THRESHOLD"
done

echo ""
echo "=============================="
echo "Summary written to: $SUMMARY_FILE"
cat "$SUMMARY_FILE"
