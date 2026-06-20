#!/usr/bin/env bash
# Deterministic mid-size output (~600 lines, ~22 KB) — in the 5-50 KB band:
# BELOW Pi's truncation cap (so native Pi keeps it ALL, at full token cost) but
# ABOVE pi-recall's default gate (200 lines / 5 KB), so condition C captures it.
# Answer buried at line 120.
set -eu
total=600
needle=120
for i in $(seq 1 "$total"); do
  if [ "$i" -eq "$needle" ]; then
    echo "[$i] calibration: MAGENTA_THRESHOLD computed as 0.834 (final)"
  else
    echo "[$i] sample reading idx=$((i * 7 % 1000)) within tolerance"
  fi
done
