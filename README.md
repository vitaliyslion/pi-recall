# pi-recall

A [Pi coding agent](https://pi.dev) extension that makes shell-output compaction **reversible**.

Most output compaction strips and truncates tool output before it reaches the model. That saves tokens, but the dropped bytes are *gone* — which hurts exploratory/research tasks where you don't yet know which part of the output mattered.

`pi-recall` keeps the savings but removes the loss: a `tool_result` hook scoped to `bash` captures
the **full** output, indexes it into an embedded [Orama](https://github.com/oramasearch/orama) BM25
index, and replaces the model-visible output with a compact **stub** carrying a recall card. When the
model needs detail it didn't keep, it queries the index via a `recall` tool instead of re-running the
command.

## How it works

1. **Capture hook** — `pi.on("tool_result", …)` scoped to `bash`. It reads the *complete* output:
   from `event.details.fullOutputPath` when Pi truncated (its own 50 KB / 2000-line cap), else from
   the inline `event.content`. Pi runs `bash` natively; pi-recall only transforms the result.
2. **Gate** — output over pi-recall's own (lower, configurable) gate — default **200 lines / 5 KB** —
   is captured; smaller output passes through unchanged.
3. **Index** — captured output is chunked (~20-line groups) and inserted into an in-process Orama
   index under `source: "exec:<toolCallId>"`. Snapshots persist under `getAgentDir()/pi-recall/` and
   restore on session resume.
4. **Stub** — the rendered output is replaced with the tail Pi already kept + an index card:
   *notable lines* (auto-highlighted error/warning matches), *searchable terms* (via Orama's own
   tokenizer, so they're copy-paste-searchable), and the `recall(...)` affordance.
5. **Recall tool** — `recall(query, source?)` BM25-searches the index, scoped to one capture or all.

Nothing is ever destructively truncated. Self-contained: no external process, server, or
separately-installed tool — Pi's native `bash` runs the command, index + search are an embedded
library.

## Install

A directory extension loads its entry from the extension root, so the source files in `src/` go
**directly into the extension dir** (not under a nested `src/`), alongside `package.json`.

**Per-project** (loads only inside one repo; the repo must be trusted in Pi):

```bash
DEST=/path/to/your-project/.pi/extensions/pi-recall
mkdir -p "$DEST"
cp src/*.js package.json "$DEST/"
cd "$DEST" && npm install --omit=dev
```

**Global** (loads in every project) — same, into the agent dir:

```bash
DEST=~/.pi/agent/extensions/pi-recall
mkdir -p "$DEST"
cp src/*.js package.json "$DEST/"
cd "$DEST" && npm install --omit=dev
```

**Ad-hoc** (single run, no install) — point Pi at the source in a clone:

```bash
npm install
pi -e /path/to/pi-recall/src/index.js
```

Verify it loaded with `/recall-status` inside Pi (below).

<!-- TODO: add an `install.sh` that flattens src/* + package.json into the chosen dest and runs
     `npm install --omit=dev` — handy, but not a priority right now. -->

- `/recall-status` — print effective config + index stats.
- `--recall-off` — disable capture for a run (pass all bash output through untouched).

## Configuration

Code defaults are layered under two optional JSON files (project wins):

- Global: `~/.pi/agent/extensions/pi-recall.json`
- Project: `<cwd>/.pi/pi-recall.json`

```json
{ "maxLines": 100, "persistFormat": "binary", "stubTerms": 8 }
```

| Key | Default | Controls |
|-----|---------|----------|
| `enabled` | `true` | Master switch (also forced off by `--recall-off`). |
| `maxLines` / `maxBytes` | `200` / `5120` | Capture gate (whichever is hit first). |
| `persist` / `persistFormat` | `true` / `json` | Cross-session snapshot + format. |
| `chunkLines` | `20` | Line-group chunk size. |
| `snapshotTtlDays` | `7` | Evict snapshots older than this on load. |
| `recallLimit` | `5` | Default `recall` hits. |
| `stubTerms` / `stubHighlights` | `12` / `3` | Stub index-card sizing. |
| `highlightPattern` | `error\|warn\|fail\|…` | Auto-highlight matcher (case-insensitive). |

## Layout

- `src/` — the extension: `index.js` (factory: hook, recall tool, lifecycle, command), `store.js`
  (Orama index lifecycle), `stub.js` (stub formatting), `config.js` (merged-JSON config + gate).
- `test/smoke.js` — in-process end-to-end check (capture → index → stub → recall → persist/restore),
  no model calls. Run with `npm run smoke`.
- `probes/` — the §1 POC gate: `v2-orama/` (Orama round-trip).
- `eval/` — the §7 harness comparing native Pi (A) vs pi-recall (C) on buried-answer tasks.
- `docs/SPEC.md` — the full design.

## Verify

```bash
npm run smoke                   # in-process end-to-end, no model calls
```

See [`docs/SPEC.md`](docs/SPEC.md) for the full design, open questions, and eval plan.
