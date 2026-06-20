#!/usr/bin/env bash
# Negative control: small output (~30 lines, <1 KB) — BELOW both Pi's cap and
# pi-recall's gate (200 lines / 5 KB). Condition C MUST pass it through
# unchanged (no capture, no stub). Answer is plainly present.
set -eu
total=30
needle=25
for i in $(seq 1 "$total"); do
  if [ "$i" -eq "$needle" ]; then
    echo "[$i] RESULT: build id = 7f3a9c2"
  else
    echo "[$i] step $i complete"
  fi
done
