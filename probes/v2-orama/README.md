# V2 probe — embedded Orama round-trip

Verifies SPEC §1 gate **V2**: that the embedded index round-trips end to end —
chunk + insert large output under `source: "exec:<id>"`, BM25-search a buried
line back, scope by source, then **persist to disk → restore → search again**.

## Run

```bash
npm install          # @orama/orama + @orama/plugin-data-persistence
node probe.js        # exit 0 = pass, 1 = a check failed
```

## Result: PASS (Orama 3.1.18)

All eight checks green: a needle buried at line 1234/3000 of a 175 KB blob is
retrieved by BM25, scoped to its own source (not a second capture that contains
the same token), and still retrieved after a persist→restore cycle.

## What it pinned down for the real extension

1. **`source` must be schema type `enum`, not `string`.** A `string` field is
   tokenized for full-text search, so `where: { source }` would fuzzy-match a
   label like `exec:aaa111`. `enum` gives exact `eq`/`in` equality — the scoping
   `recall` needs.
2. **File persistence is in the `/server` subpath.** Import `persistToFile` /
   `restoreFromFile` from `@orama/plugin-data-persistence/server`. The bare
   `@orama/plugin-data-persistence` entry exposes only the in-memory
   `persist`/`restore` (string/Buffer), and `persistToFile` there throws telling
   you to use `/server`.
3. **`json` snapshots are bloated** — ~5.4× the source bytes (956 KB for a
   175 KB blob). Revisit the `binary`/`dpack` formats if snapshot size matters.
4. API shape: `create()` is sync; `insertMultiple`/`search` return sync-or-promise
   (await defensively); `restoreFromFile('json', path)` returns the restored db.
