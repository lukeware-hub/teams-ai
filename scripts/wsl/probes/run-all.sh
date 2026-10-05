#!/usr/bin/env bash
# Runs probes p1..p5 sequentially and writes a combined log.
set -uo pipefail
cd "$(dirname "$0")/../../.."
LOG="${1:-/tmp/probes.log}"
: > "$LOG"
for p in p1-baseline p2-json-schema p3-turn-cap p4-compaction p5-sandbox; do
  echo "##### $p" >> "$LOG"
  timeout 900 bash "scripts/wsl/probes/$p.sh" >> "$LOG" 2>&1 || echo "[exit $?]" >> "$LOG"
done
echo "PROBES_DONE" >> "$LOG"
