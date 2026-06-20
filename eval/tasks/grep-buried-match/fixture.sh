#!/usr/bin/env bash
# Deterministic synthetic repo-wide grep result (~2500 lines, ~160 KB) — over
# Pi's truncation cap. One meaningful match is buried in the head (line 250).
set -eu
total=2500
needle=250
for i in $(seq 1 "$total"); do
  if [ "$i" -eq "$needle" ]; then
    echo "src/payments/config.ts:$i:  FIXME_PAYMENT_TIMEOUT set to 0 disables retries entirely"
  else
    echo "src/module_$((i % 211))/file_$((i % 97)).ts:$i:  // TODO routine note alpha beta $((i * 13 % 1000))"
  fi
done
