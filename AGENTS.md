# AGENTS.md

## What this is

`pi-recall` is a [Pi coding agent](https://pi.dev) extension that makes shell-output compaction **reversible**. A `tool_result` hook scoped to `bash` captures the full command output, indexes it into an embedded Orama BM25 index, and replaces the model-visible output with a compact stub (tail + notable lines + searchable terms). The model retrieves buried detail via a `recall(query, source?)` tool instead of re-running the command. Nothing is ever destructively truncated. Fully in-process: no external server or binary.

`docs/SPEC.md` is the full design document (architecture, config, eval plan) — consult it before structural changes.

## Commands

Node ≥ 22.19 required; `.ts` files run directly via `node` (type-stripping). Typechecking uses `tsgo` (TypeScript native preview), formatting uses `oxfmt`.

```bash
npm test                          # Vitest unit + integration suite (no model calls)
npx vitest --run test/store.test.ts   # single test file
npx vitest --run -t "pattern"     # single test by name
npm run test:watch                # watch mode
npm run check                     # typecheck src (tsgo --noEmit)
npm run check:test                # typecheck tests
npm run format / format:check     # oxfmt
node probes/v2-orama/probe.js     # Orama round-trip POC probe
```

Eval harness (separate package in `eval/`, run from that dir):

```bash
node src/run.ts [--tasks all|id,id] [--conditions A,C] [--trials N] [--model provider/id] [--ext <path>] [--out <file>]
node src/mine.ts                  # mine buried-answer tasks from session logs
node src/viz.ts                   # render results visualization (eval/web/template.html)
npm run check                     # typecheck eval
```

⚠️ `eval/src/run.ts` makes **real, paid model calls** — keep the task set small and prefer a cheap `--model`. Results persist as JSON under `eval/results/`.

## Architecture

Data flow: model emits bash tool_call → Pi's native `bash` runs it → pi-recall's `tool_result` hook fires → full output read from `event.details.fullOutputPath` (when Pi truncated at its own 50 KB / 2000-line cap) or inline `event.content` → if over pi-recall's own gate (default 200 lines / 5 KB) it is chunked (~20-line groups), indexed under `source: "exec:<hash>"`, and the visible result is replaced by a stub; otherwise passed through unchanged.

- `index.ts` (root) — package entry, re-exports `src/index.ts`.
- `src/index.ts` — extension factory: registers the capture hook, the `recall` tool, the `/recall-status` command, `--recall-off` flag, and session lifecycle (persist/restore).
- `src/store.ts` — `RecallStore`: Orama index lifecycle, chunking, insert/search, snapshot persist/restore under `getAgentDir()/pi-recall/` with TTL eviction.
- `src/config.ts` — layered config: code defaults ← global `~/.pi/agent/extensions/pi-recall.json` ← project `<cwd>/.pi/pi-recall.json` (project wins); capture-gate logic.
- `src/stub.ts` — stub formatting: kept tail, notable-line highlighting (`highlightPattern`), searchable terms via Orama's tokenizer.
- `test/` — Vitest, no model calls: unit specs mirror src modules; `test/integration/` drives the real extension runtime through a mocked bash backend (capture → index → stub → recall → persist/restore); shared setup in `test/helpers/` (`fixtures.ts`, `tmp.ts`, `recall-session.ts`).
- `eval/` — SPEC §7 harness comparing condition A (native Pi) vs C (pi-recall) on buried-answer tasks: `run.ts` (trial driver), `harness.ts`, `conditions.ts`, `metrics.ts`, `report.ts`, `mine.ts` (task mining), `viz.ts` (HTML report from `web/template.html`).
- `probes/v2-orama/` — the SPEC §1 verification probe for the Orama round-trip assumption.

### Load-bearing Orama facts (from SPEC §1, verified by probe)

- The `source` field in the index schema must be type **`enum`**, not `string` — a `string` field is full-text tokenized, so `where: {source}` would fuzzy-match; `enum` gives exact scoping.
- File persistence (`persistToFile`/`restoreFromFile`) lives in the **`@orama/plugin-data-persistence/server`** subpath; the bare entry only has in-memory `persist`/`restore`.
- JSON snapshots are ~5.4× source bytes; `persistFormat: "binary"` exists for when size matters.

