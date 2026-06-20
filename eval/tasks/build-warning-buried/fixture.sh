#!/usr/bin/env bash
# Deterministic synthetic build log (~3000 lines, ~150 KB) — exceeds Pi's
# 50 KB / 2000-line truncation. The one error is buried in the HEAD (line 300),
# i.e. OUTSIDE the tail Pi keeps, so native Pi (condition A) drops it.
set -eu
total=3000
needle=300
for i in $(seq 1 "$total"); do
  if [ "$i" -eq "$needle" ]; then
    echo "[$i] ERROR: ZEBRACORN eviction policy mismatch in cache-layer (code E4471)"
  else
    echo "[$i] INFO compiling module_$((i % 137)) ok in $((i * 7 % 1000))ms gamma delta"
  fi
done
