#!/usr/bin/env bash
# Deterministic synthetic TAP-style test run (~4000 lines, ~170 KB) — over Pi's
# cap. Exactly one failure, buried in the head (line 400), among passing lines.
set -eu
total=4000
needle=400
for i in $(seq 1 "$total"); do
  if [ "$i" -eq "$needle" ]; then
    echo "not ok $i - test_payment_refund_rounding (expected 19.99 got 20.00)"
  else
    echo "ok $i - test_case_$((i % 521)) passed"
  fi
done
echo "# 1 failed, $((total - 1)) passed"
