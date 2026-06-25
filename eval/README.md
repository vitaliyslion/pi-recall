# pi-recall evaluation harness (SPEC §7)

Measures whether making truncated `bash` output **reversible + searchable** (pi-recall) beats the
status quo, and whether the model actually *uses* recall. It drives Pi headlessly via the SDK and
compares two conditions on **buried-answer tasks** — where the answer sits in the head/middle of
large output, the part Pi's tail-truncation drops:

- **A — native Pi:** Pi's own truncation (50 KB / 2000 lines) + the `fullOutputPath` footer. No extension.
- **C — pi-recall:** capture → index → stub → `recall` (the §5 self-contained design).

> ⚠️ Runs make **real model calls.** Cloud models cost money — keep the task set small and prefer a
> cheap `--model`. **A local model is free:** omit `--model` and the harness uses Pi's settings default
> (`~/.pi/agent/settings.json`), so a configured Ollama provider (e.g. `gemma4:26b`) runs at zero
> cost. Tokens-into-context are still reported (Ollama returns usage); `cost` shows `$0` for local.

## Install & run

```bash
cd eval
npm install
node src/run.ts --conditions A --trials 1                 # baseline self-test (no extension needed)
node src/run.ts --conditions A,C --trials 3               # full A-vs-C (needs pi-recall built)
node src/run.ts --tasks build-warning-buried --model anthropic/claude-haiku-4-5 --trials 2
```

The sources are TypeScript, run directly via Node's native type stripping (Node ≥ 22.19); there is no
build step. Flags: `--tasks all|id,id`, `--conditions A,C`, `--trials N`, `--model provider/id`
(default = Pi's settings), `--ext <path>` (pi-recall factory, default `../src/index.ts`),
`--out <file>`. Raw per-trial JSON lands in `results/` (gitignored).

## Visualize results

```bash
npm run viz                  # bakes results/*.json into report.html, then open it
```

`viz` reads every run in `results/` and writes a self-contained `report.html` (gitignored) with
charts: a **trend across runs** (pick a range of runs to compare previous results) and an **A-vs-C
by task** breakdown for a focused run, plus the `bashChars`/`ctxTok` reduction headline and a detail
table. Re-run `npm run viz` after a new eval to pick it up.

**Condition C is skipped** with a clear message until the pi-recall extension exists at `--ext`
(default `../src/index.ts`). So A + the fixtures are useful immediately; C goes live the moment the
extension is built. For C, the harness writes a fixed gate to `<cwd>/.pi/pi-recall.json`
(`maxLines:200, maxBytes:5120, persist:false`) so the threshold is constant and no snapshots hit disk.

## Headless SDK integration notes (load-bearing)

Two non-obvious facts about driving Pi via `createAgentSession` (both handled in `harness.ts`):

1. **`session_start` is not emitted automatically.** The TUI/CLI calls `session.bindExtensions(...)`,
   which is what fires `session_start` (agent-session.js). pi-recall arms its capture hook in
   `session_start`, so the harness must call `bindExtensions({ uiContext, mode: "print" })` after
   `createAgentSession` — otherwise the extension stays inert and condition C silently equals A.
   A no-op `uiContext` (Proxy returning no-ops) satisfies extensions that call `ctx.ui.notify`/`setStatus`.
2. **The `tools` allowlist also filters extension tools.** `tools: ["bash","read"]` *excludes* the
   extension's `recall` tool, so the model never sees it. The harness allowlists
   `["bash","read","recall"]` (the name is harmless under A, where no `recall` tool is registered).

## What it measures (per task × condition, averaged over N trials)

| Column | Meaning | §7 family |
|--------|---------|-----------|
| `acc` | final answer matches `task.expect.pattern` (programmatic) | probe accuracy |
| `bashChars` | chars of the bash result that entered context (stub vs. full output) | tokens-into-context |
| `ctxTok` | final context tokens (`getContextUsage`) | tokens-into-context |
| `recall` | fraction of trials that called the `recall` tool (C) | recall behavior |
| `rerun` | fraction that re-ran `bash` instead | recall behavior |
| `reread` | fraction that re-read `fullOutputPath` (A's only affordance) | recall behavior |
| `capt` | fraction where pi-recall captured (stub present) | sanity / negative control |
| `cost` | USD per run (`getSessionStats().cost`) | cost |

**Headline:** C should lower `bashChars`/`ctxTok` while holding or raising `acc`, with a non-trivial
`recall` rate (the §8 stub-discoverability bet). A negative result — model ignores `recall`, accuracy
drops — is valid and reported as-is.

## Tasks (`tasks/<id>/`)

Each task is a deterministic `fixture.sh` (the only run-to-run variance is the model) plus a
`task.json` (`prompt`, `fixtureCmd`, `expect.pattern`, `notes`). The shipped suite:

| Task | Shape | Why |
|------|-------|-----|
| `build-warning-buried` | ~150 KB build log, error at line 300 | over Pi's cap; answer in dropped head |
| `grep-buried-match` | ~160 KB grep result, one real match | distinguishing match from noise |
| `test-failure-buried` | ~170 KB test run, one failure | failure buried; tail shows only passes |
| `midsize-band` | ~22 KB (5–50 KB band) | Pi keeps it ALL (full tokens); C captures (§5.1 path 2) |
| `small-passthrough` | <1 KB | **negative control**: C must NOT capture (`capt` = 0%) |

Add a task: create `tasks/<id>/fixture.sh` (deterministic; bury the answer outside the tail) and
`tasks/<id>/task.json`. Verify determinism: `bash fixture.sh | md5sum` twice should match.

## Optional: mine real transcripts

```bash
node src/mine.ts --limit 10 --min-bytes 5120
```

Scans `~/.pi/agent/sessions` for large/truncated `bash` captures and writes review candidates to
`mined/` (never into `tasks/`). Promote good ones into the curated suite by hand.
