# pi-recall — Design Spec

**One line:** a Pi extension that captures full shell-tool output, indexes it in an embedded local
search index, and shows the model a compact stub with a recall handle — making compaction reversible.

---

## 1. POC verification gate

These are load-bearing assumptions about Pi and the embedded search engine that the rest of the
design rests on. Each has a fallback so the project survives a "no". **Both are now resolved** — V1 is
confirmed in source and V2 passed its probe (`probes/`) — so the gate is cleared and §5 (component
design) is live. The rows are kept as the verified record of *why* the design is safe to build.

| # | Question | Why it matters | Fallback if "no" |
|---|----------|----------------|------------------|
| V1 *(**CONFIRMED in source**)* | Can a `tool_result` hook scoped to `bash` (a) reach the complete output and (b) return `{ content }` to replace the model-visible view? **Both confirmed** by reading the installed `@earendil-works/pi-coding-agent` types, which also closed the one seam that was open: **(a)** `isBashToolResult(event)` narrows to `BashToolResultEvent` carrying `details: BashToolDetails | undefined`, and `BashToolDetails.fullOutputPath` is set *exactly when* the output was truncated (`bash.js`, cap 2000 lines / 50 KB via `truncateTail`); the temp file holds the full pre-truncation output. **(b)** the `tool_result` handler return type is `ToolResultEventResult { content?, details?, isError? }`, so returning `{ content }` replaces the rendered output (omitted fields retained). The complete output is always reachable — from `fullOutputPath` when Pi truncated, else the inline `event.content` — so pi-recall applies its **own** (lower, configurable) capture gate rather than piggybacking on Pi's truncation (§5.1, §6). No probe needed — see §5.1. | Override `bash` via `createBashTool` with custom `operations` whose `onData` tees the raw pre-truncation stream (§4.2). |
| V2 *(gate — **PASSED**)* | Does the **embedded index round-trip** — chunk + `insert` large output under `source: "exec:<id>"`, BM25-`search` a buried line back, and **persist + restore** from disk? **Verified** by `probes/v2-orama/probe.js` (Orama 3.1.18): a needle buried at line 1234/3000 of a 175 KB blob is retrieved by BM25, scoped to its own source, and still retrieved after a persist→restore cycle. Two API facts the design must bake in: **(1)** the `source` field must be schema type **`enum`**, not `string` — a `string` field is tokenized for full-text, so `where:{source}` would fuzzy-match; `enum` gives exact `eq`/`in` scoping. **(2)** file persistence (`persistToFile`/`restoreFromFile`) lives in the **`@orama/plugin-data-persistence/server`** subpath, not the bare entry (which is the in-memory `persist`/`restore`). Note: `json` snapshots are ~5.4× the source bytes (956 KB for 175 KB) — revisit `binary`/`dpack` format if snapshot size matters. | The reversibility itself. Orama is a pure-TS in-process import; the bet is that persistence + scoped search behave. | **MiniSearch** (pure-JS, manual JSON persistence); or better-sqlite3 + FTS5 if a native module is acceptable. |

*Scope note:* pi-recall is fully in-process — Pi's native `bash` runs the command, capture is a
`tool_result` hook, index + search is an embedded **Orama** instance. No external binary, server, or
service to reach, so the gate is just the two probes above. (The `fullOutputPath` temp file only needs
to exist *at hook-fire time* — we read it once and index into Orama immediately; its later lifetime
doesn't matter, since recall queries the index, not the file.)

**Exit criterion for the gate:** after a `bash` command produces large output, the hook chunks and
inserts it into an embedded Orama index under `source: "exec:<id>"`, replaces the model-visible output
with a stub, persists to disk, and a `recall(query)` call BM25-retrieves a buried line back *after
restore* — entirely in-process. That proves the self-contained path end to end.

---

## 2. Motivation

### The problem
On Pi, large shell-tool output (builds, repo-wide greps, logs) dumps straight into context. The
available enforced option (pi-rtk-optimizer) compacts that output **destructively** —
stripped/truncated bytes are unrecoverable. That is fine for routine execution but bad for
*research/exploration*, where you don't know in advance which part of the output you'll need.

### The reframe (grounded in current practice)
The field's central distinction is **reversible vs. irreversible** context reduction:

- *Reversible*: information leaves the active window but still exists somewhere (file/index), so
  it can be re-fetched. Nothing is destroyed.
- *Irreversible*: summarization/truncation permanently discards what didn't make the cut.

The current default for coding agents is **just-in-time retrieval** — keep lightweight
identifiers (paths, queries, handles) in context and pull content on demand — rather than either
stuffing everything in or summarizing it away. (Anthropic describes Claude Code as exactly this
hybrid: a little upfront, most via grep/glob on demand.)

`pi-recall` applies enforcement (hook-level, no model cooperation) to a **reversible** mechanism
(index, don't destroy). That dissolves the research-task objection: the compact view is the
default, but the full output is one query away.

See [References](#9-references).

---

## 3. Core principle

> **Capture at the shell boundary; index any output past pi-recall's gate.** pi-recall captures the
> output of the built-in **`bash`** tool. A **`tool_result` hook** scoped to `toolName === "bash"`
> runs *after* Pi executes the command (natively — pi-recall doesn't run it). It obtains the
> *complete* output two ways: when Pi itself truncated (its own cap, 50 KB / 2000 lines) the full text
> is on disk at **`event.details.fullOutputPath`**; otherwise the full text is the inline
> `event.content`. The hook applies its **own lower gate** (default 200 lines / 5 KB — §6): past it,
> it chunks the full output into an **embedded local index** (Orama — BM25 over an in-process store)
> under a `source` label and returns a compact stub + recall card in place of the output; below it,
> output is small enough to pass through unchanged. The model pulls detail back via a `recall` tool.
> All other tools (`read`, `write`, `edit`, …) are untouched.

The guarantee this buys: **nothing is ever destructively truncated.** Small output stays in context
(trivially reversible); captured output is fully indexed (reversible via the `recall` tool). That is
the difference from pi-rtk-optimizer, which hard-truncates. Note Pi *already* hands the model the
`fullOutputPath` temp file on truncation — but that's only **re-readable** (dump the whole file back);
pi-recall's value-add is making it **searchable** (BM25 + a recall affordance), so the model retrieves
just the buried slice instead of re-reading hundreds of KB.

pi-recall is **self-contained** — Pi's own `bash` runs the command, index + search are an embedded
library; it depends on no external process, service, or separately-installed tool (see §4.1).

Non-goals:
- Not reimplementing the search engine — embed Orama's BM25 (MiniSearch as a leaner fallback). We own
  only the trivial glue: line-group chunking and stub formatting.
- Not capturing every tool — only `bash` output routes through capture (other tools are untouched).
- Not executing or reimplementing `bash` — Pi's native tool runs it; we transform its result.

---

## 4. Architecture

```
        ┌─────────────────────────── Pi tool loop ───────────────────────────┐
        │                                                                     │
 model emits tool_call ──▶ native bash runs (Pi executes it) ──▶ output        │
        │                          (content capped 50KB/2000 lines; full →     │
        │                           details.fullOutputPath on truncation)      │
        │                                                         │           │
        │                          ┌──────────────────────────────┴────────┐ │
        │                          │ pi-recall tool_result hook (toolName=  │ │
        │                          │ "bash"):                               │ │
        │                          │   • full = path ? read file :          │ │
        │                          │            event.content (complete)    │ │
        │                          │   • over gate (200ln/5KB)? chunk+index  │ │
        │                          │     (source=exec:<id>), return stub     │ │
        │                          │     card ; else pass through unchanged  │ │
        │                          └──────────────────────────────┬────────┘ │
        │                                                          ▼          │
        │                              model sees result (no destructive cut) │
        │                                                                     │
 model wants detail ──▶ recall(query,[source]) tool ──▶ embedded BM25 search  │
        └─────────────────────────────────────────────────────────────────────┘
```

### Tool disposition

| Tool | Disposition | Why |
|------|-------------|-----|
| everything except `bash` | **untouched** | The hook is scoped to `toolName === "bash"`. Notably `read` stays verbatim — `edit` needs its literal line-numbered text to build `old_string`, so stubbing it would break editing. |
| `bash` | **`tool_result` hook → capture** | Pi runs `bash` natively. The hook gets the complete output (from `details.fullOutputPath` if Pi truncated, else from `event.content`) and, when it exceeds pi-recall's gate (200 lines / 5 KB), indexes it and replaces the view with a stub. `ls`/`grep`/`find` are opt-in Pi tools (`--tools`) and redundant with `bash`, so they're out of scope. |

### Index + store
- **Engine:** embed **Orama** (`@orama/orama`) — in-process BM25, zero native deps, TypeScript-native.
  MiniSearch is the leaner fallback (manual JSON persistence); better-sqlite3 + FTS5 is the option if
  on-disk incremental BM25 is wanted (native module — packaging cost).
- **Store + persistence:** snapshot the index to a file under pi-recall's own data dir (e.g. via
  `getAgentDir()`), restored on load (`@orama/plugin-data-persistence`). We own the store, so eviction
  (session-scoped or TTL) is ours and touches nothing else.
- **Source labels:** each capture is inserted under `source: "exec:<id>"` so `recall` can scope to one
  blob via a field filter.
- **Chunking:** line-group chunks (~20 lines) — the only "engine" code we write; Orama does the
  ranking.
- **Retrieval:** pi-recall registers its own `recall(query, [source])` tool that BM25-searches the
  embedded index. No external service or tool dependency.

### Why a `tool_result` hook (not a tool override)
A `tool_result` hook can **replace** the rendered output by returning `{ content, details }` — pi-rtk
does exactly this in production, so the capability is proven. We scope ours to `toolName === "bash"`,
take the full output (from `event.details.fullOutputPath` if Pi truncated, else `event.content`), and
when it exceeds our gate, index it and return a stub. Two reasons to prefer this over overriding the
`bash` tool:
- **It composes.** Only one extension can *override* `bash`; a hook runs *alongside* whatever owns the
  tool. So pi-recall coexists with a native or sandboxed `bash` instead of fighting for it.
- **No execution to own.** We don't run or reimplement `bash`; Pi already did. We only transform the
  result, which is all we need.

(Overriding `bash` via `createBashTool` remains a clean fallback — see §4.2.)

### 4.1 Integration surface: embedded index (no external process)
The hook indexes into an **in-process Orama instance** — `npm i @orama/orama`, import it,
`create({ schema: { text: 'string', source: 'enum' } })`, `insertMultiple` chunks,
`search({ term, where: { source: { eq } } })`. (`source` is `enum`, not `string`, for exact scoping —
see V2.) Persist with `persistToFile`/`restoreFromFile` from
**`@orama/plugin-data-persistence/server`** (snapshot to a file in pi-recall's data dir; restore on
extension load).

Why embed (vs. any out-of-process index service):
- **No discovery / coupling.** No external binary or server to locate or version-match, no second
  process, no extra install for the user.
- **Nothing spawns a server.** All work happens inside the extension process.
- **Cost:** we own the chunking + stub + persistence glue (small); the ranking engine is the library's.

Orama is a pure-TS npm package imported in-process, so loading inside the extension is
low-risk; MiniSearch is the pure-JS fallback if a transitive dependency ever causes trouble.

### 4.2 Fallback: override `bash` via `createBashTool`

If a `tool_result` hook ever can't replace output on a given Pi version, override the `bash` tool
instead. `@earendil-works/pi-coding-agent` exports **`createBashTool(cwd, { operations? })`**, which
returns the *native* bash tool ready for `registerTool` — so we keep full fidelity (schema, result
shape, streaming, timeouts) without reimplementing anything. Spread it and wrap `execute`:

```ts
const bash = createBashTool(cwd);
pi.registerTool({ ...bash, async execute(id, params, signal, onUpdate, ctx) {
  const r = await bash.execute(id, params, signal, onUpdate);   // native run
  return transform(r);                                          // size-gate → index → stub
}});
```

Trade-off vs. the hook: an override **does not compose** — only one extension can own `bash`, so this
would collide with e.g. the sandbox extension's own `bash` override. Prefer the hook; keep this for
when the hook path is unavailable.

**`read` caveat (for completeness).** Whichever path is used, never stub `read` output: `edit` needs
the literal line-numbered text to build `old_string`. Both designs leave `read` untouched, so this is
moot — noted only so a future "capture every tool" idea doesn't reintroduce it.

---

## 5. Component design

Grounded in the verified Pi API (`@earendil-works/pi-coding-agent`, types read from the installed
package) and the proven Orama round-trip (§1 V2, `probes/v2-orama/`). The
extension is a default-export factory `(pi: ExtensionAPI) => void` that wires up four pieces: a
`tool_result` hook, an Orama index with a session lifecycle, a source-id scheme, and a `recall` tool.

### 5.1 The `bash` `tool_result` hook (gate + capture + stub)

```ts
import { isBashToolResult } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";

pi.on("tool_result", async (event, ctx) => {
  if (!isBashToolResult(event)) return;                 // scope: bash only (type-guarded)
  const path = event.details?.fullOutputPath;
  // The COMPLETE output: from the temp file if Pi truncated, else the inline content.
  const full = path
    ? await readFile(path, "utf8")                      // path set ⟹ Pi truncated (>50 KB/2000 lines)
    : textOf(event.content);                            // no path ⟹ content IS the complete output
  if (!overGate(full, cfg)) return;                     // one config-driven gate on the COMPLETE output
  const source = index.shortSource(event.toolCallId);  // short git-style id (§5.3)
  await index.add(source, full, event.input.command);   // chunk + insertMultiple (§5.2)
  return { content: [{ type: "text", text: stub(event, source, full) }] };  // replace view (§5.4)
});
// overGate(t) = lines(t) > cfg.maxLines || bytes(t) > cfg.maxBytes   (default 200 / 5 KB)
// textOf(content) = TextContent parts joined (ImageContent passed through untouched)
```

Verified facts this rests on:
- **`isBashToolResult(event)`** narrows to `BashToolResultEvent { toolName:"bash"; details: BashToolDetails | undefined; content: (TextContent|ImageContent)[]; toolCallId; input: {command,timeout?}; isError }`. (Don't compare `event.toolName === "bash"` directly — `CustomToolResultEvent.toolName` is `string`, so the union doesn't narrow. Use the guard.)
- **`BashToolDetails = { truncation?: TruncationResult; fullOutputPath?: string }`**, populated *only when Pi truncated* (`bash.js`: `details = { truncation, fullOutputPath }` inside `if (truncation.truncated)`). So `fullOutputPath` present ⟹ Pi truncated and the temp file holds the complete output; absent ⟹ the complete text is `event.content`. `path` only selects *where the complete text comes from* — it does **not** branch the gate or the stub. pi-recall answers entirely to **its own config**: one `overGate(full, cfg)` decides capture (default 200 lines / 5 KB, below Pi's 2000 / 50 KB), so Pi's cap is just one more truncation the tool transparently covers. When Pi truncated, `full` is large and is always over the gate.
- **pi-recall never reuses Pi's kept tail.** Pi tail-truncates (`truncateTail`), but the stub computes its *own* configured tail (`cfg.tailLines`, default 40) from `full` regardless — so the visible view is the same small size whether or not Pi truncated, and the buried head/middle is recovered from the index (and surfaced via the stub's auto-highlights — §5.4).
- The hook returns **`ToolResultEventResult { content?, details?, isError? }`**; omitted fields retain their current value, so returning just `{ content }` replaces the rendered output and leaves the rest intact. (Handlers chain as middleware; we are read-through for non-bash results and for output below our gate.)

### 5.2 Embedded Orama index lifecycle

One index module owns create / restore / add / persist / evict. Schema and persistence are exactly as
the V2 probe validated:

- **Schema:** `{ text: 'string', source: 'enum', startLine: 'number' }`. `source` is **`enum`** (not
  `string`) so `where: { source: { eq } }` is an exact-match scope, not a tokenized fuzzy match.
- **Chunking:** `add(source, full, command)` splits `full` into ~20-line groups and `insertMultiple`s
  `{ text: <group>, source, startLine }`. (Line-group chunking is the only "engine" code we own.)
- **Persistence:** `persistToFile` / `restoreFromFile` from **`@orama/plugin-data-persistence/server`**
  (the `/server` subpath — the bare entry is in-memory only). Snapshot lives under
  **`getAgentDir()`**`/pi-recall/<sessionId>.json`.
- **Lifecycle:** restore on `session_start` (if a snapshot for that session exists); index in memory
  for the live session (recall is in-process, no disk hit); persist on `session_shutdown` (and
  optionally debounced after captures, since `json` snapshots are ~5.4× source bytes — see V2). Recall
  *within* a session never needs disk; persistence is for resuming a session after restart.
- **Eviction:** the index is session-scoped (one snapshot file per session), so cleanup is just
  dropping snapshot files for sessions that no longer exist, or older than a TTL. Touches nothing else.

### 5.3 Source-id scheme

Each capture is keyed `source = "exec:<hash>"`, a short **git-style** id minted by `shortSource`: the
hex SHA-1 of `event.toolCallId`, truncated to the shortest prefix (≥ 5 chars) not already keyed this
session and lengthened by one on a collision. The originating `command` is stored alongside (an extra
field or a small in-memory manifest) so stubs and recall hits can show *which* command produced the blob.

### 5.4 Stub format

The stub *replaces* the captured content with a compact, **fully config-driven** view. pi-recall does
not reuse Pi's kept tail or its `[Showing lines … Full output: <path>]` footer (that footer only
affords a **full re-read**). Instead it shows its *own* configured tail plus a **recall index card**:
not just a handle, but a digest of what's in the buried part so the model can decide *whether* and
*what* to recall. Modeled on context-mode's post-`ctx_execute` summary.

```
<pi-recall's own tail — the last cfg.tailLines lines of the COMPLETE output (default 40)>

[pi-recall: full output (1234 lines / 175 KB) indexed as exec:7f3a. Showing the last N lines.
 Notable: 3 error/warning lines — e.g. "line 1234: ZEBRACORN eviction policy mismatch".
 Searchable terms: eviction, mismatch, zebracorn, timeout, retry, backoff, oomkilled, …
 Search the rest: recall("<query>", source="exec:7f3a").]
```

Three parts, each cheap and computed from the full text we already hold at capture:

1. **Tail.** The model still sees the end, where errors/final results usually are. This is always
   pi-recall's *own* tail — the last `cfg.tailLines` lines (default 40) of the **complete** output —
   computed identically whether or not Pi truncated. So the visible view is the same small size in
   both cases (≈2 KB, not Pi's 50 KB), and Pi's 50 KB cap stops mattering. Free reversibility; the
   buried remainder is one `recall` away.
2. **Notable lines (auto-highlights)** — the intent-free analog to context-mode's "matched
   sections." context-mode's matched-sections need an `intent` parameter; native `bash` has no such
   param and we reject tool-override (§4 clash/race), so we *can't* ask the model for intent. Instead
   we surface salient lines with **no model input**: scan the full output for high-signal patterns
   (`/error|warn|fail|exception|fatal|panic|traceback|denied|timeout|✗/i`), show the first few,
   truncated. A free table-of-contents of likely-relevant content.
3. **Searchable terms** — the analog to context-mode's term list. **Orama has no built-in for this**
   (string facets bucket the *whole* field value, not tokens; `index.tokenOccurrences` is global, not
   per-capture), so we compute it ourselves — but via **Orama's own tokenizer**
   (`db.tokenizer.tokenize(full, lang, "text")`, verified) so every term shown is the exact normalized
   form the index stores and is therefore copy-paste-searchable (recall normalizes the query the same
   way). Rank by in-capture frequency, **optionally demoted by `index.tokenOccurrences` doc-frequency**
   so terms common across *other* captures sink and distinctive tokens rise; drop stopwords, very
   short, and purely-numeric tokens; take top ~12.

Net: the footer is an index card — *what's notable* + *what's searchable* + *how to fetch* — which
also directly addresses the stub-discoverability risk (§8): the model sees concrete terms to query,
not just an abstract handle.

> **Dropped:** per-capture "matched sections for a stated intent." It requires an `intent` argument
> the model won't supply for native `bash`, and the only way to add one is overriding `bash`, which
> §4 rejects (doesn't compose; collides with sandbox/optimizer overrides). Auto-highlights (#2) cover
> the practical need without it.

### 5.5 The `recall` tool

```ts
import { Type } from "typebox";

pi.registerTool({
  name: "recall",
  label: "Recall",
  description: "Search the full, un-truncated output of an earlier bash command (BM25).",
  promptSnippet: "recall(query, source?) — search full output of a truncated bash result",
  parameters: Type.Object({
    query: Type.String(),
    source: Type.Optional(Type.String()),   // e.g. "exec:<id>"; omit to search all captures
    limit: Type.Optional(Type.Number()),
  }),
  async execute(toolCallId, { query, source, limit = 5 }, signal, onUpdate, ctx) {
    const r = await search(db, {
      term: query,
      where: source ? { source: { eq: source } } : undefined,
      limit,
    });
    const text = r.hits.map(h =>
      `[${h.document.source} @ line ${h.document.startLine}]\n${h.document.text}`
    ).join("\n\n---\n\n") || "(no matches)";
    return { content: [{ type: "text", text }] };
  },
});
```

`registerTool` takes a `ToolDefinition` whose `parameters` is a TypeBox schema and whose
`execute(toolCallId, params, signal, onUpdate, ctx)` returns `AgentToolResult` (`{ content, details?,
isError? }`). `search` returns `{ count, hits: [{ id, score, document }], elapsed }` (V2-verified). The
hit format cites `source` + `startLine` so the model can re-scope or widen if needed.

---

## 6. Configuration

**Mechanism (the idiomatic Pi pattern, as in the `sandbox` example extension).** The factory
`(pi: ExtensionAPI) => void` receives no config object, so config is a **merged JSON file** layered
over code defaults — exactly how `sandbox` does it:

```ts
const DEFAULT_CONFIG: RecallConfig = { /* every key below, with its default */ };

function loadConfig(cwd: string): RecallConfig {
  const global  = readJsonIfExists(join(getAgentDir(), "extensions", "pi-recall.json"));
  const project = readJsonIfExists(join(cwd, ".pi", "pi-recall.json"));
  return deepMerge(deepMerge(DEFAULT_CONFIG, global), project);  // project wins
}
```

- **Global:** `~/.pi/agent/extensions/pi-recall.json` (`getAgentDir()/extensions/pi-recall.json`).
- **Project:** `<cwd>/.pi/pi-recall.json` — takes precedence.
- Loaded on `session_start` (same lifecycle hook that restores the index, §5.2). A bad/missing file
  is non-fatal: warn and fall back to defaults.
- **One CLI flag** — `registerFlag("recall-off", { type: "boolean", default: false })`, checked on
  `session_start`; when set, pass every result through untouched (overrides config `enabled`). Useful
  for the §7 A/B without editing files. No other flags; **no environment variables.**
- **`/recall-status` command** (like `sandbox`'s `/sandbox`) — prints effective config + index stats
  (captures held, snapshot size).

Every key has a default; pi-recall works with zero configuration. Because config is JSON, numeric and
array values are first-class (no string-flag parsing).

| Key | Type | Default | Controls |
|-----|------|---------|----------|
| `enabled` | bool | `true` | Master switch (also forced off by `--recall-off`). Off = pass results through untouched. |
| `maxLines` | number | `200` | Capture gate: index + stub when output exceeds this many lines (§5.1). |
| `maxBytes` | number | `5120` | Capture gate: index + stub when output exceeds this many bytes (5 KB). Whichever limit is hit first wins. |
| `persist` | bool | `true` | Snapshot the index to disk for cross-session restore. Off = session-memory only (recall still works within the session). |
| `persistFormat` | `json`\|`binary`\|`dpack` | `json` | Snapshot format. `json` is ~5.4× source bytes (V2); `binary`/`dpack` shrink it. |
| `chunkLines` | number | `20` | Line-group chunk size (§5.2). |
| `snapshotTtlDays` | number | `7` | Evict snapshot files older than this on load (§5.2). |
| `recallLimit` | number | `5` | Default hits from `recall` when `limit` is omitted (§5.5). |
| `tailLines` | number | `40` | Lines of the complete output kept as the stub's visible tail (§5.4). Applied whether or not Pi truncated — this is how pi-recall covers Pi's own 50 KB cap. |
| `stubTerms` | number | `12` | Searchable-terms shown in the stub (§5.4). |
| `stubHighlights` | number | `3` | Notable lines shown in the stub (§5.4). |
| `highlightPattern` | string (regex) | `error\|warn\|fail\|exception\|fatal\|panic\|traceback\|denied\|timeout\|✗` | Auto-highlight matcher (§5.4); case-insensitive. |

Example `.pi/pi-recall.json`:

```json
{ "maxLines": 100, "persistFormat": "binary", "stubTerms": 8 }
```

**On the capture threshold (`maxLines` / `maxBytes`).** pi-recall sets its *own* gate, default
**200 lines / 5 KB**, deliberately *below* Pi's truncation point (2000 lines / 50 KB). So it captures
moderately-large output too — not just the huge stuff Pi already truncates. (Reference: context-mode
recommends its `ctx_execute` for any command producing **>20 lines** and shows a ~500-token / 2000-char
preview; our 200/5 KB default is more conservative since we auto-capture rather than being explicitly
invoked.) The gate is fully pi-recall's own — it is no longer "iff Pi truncated." `fullOutputPath` only
tells the hook *where* the complete text is (temp file when Pi truncated, else `event.content`); the
single `overGate(full, cfg)` check and the `tailLines` stub then govern both cases identically, so
pi-recall's own config covers Pi's 50 KB cap rather than deferring to it.

Earlier-draft keys are gone: `captureThresholdBytes` is now the proper `maxBytes`/`maxLines` pair;
`sourceNamespace` → ids are short git-style `exec:<hash>` (§5.3); `ttlHours` → `snapshotTtlDays`; the free-text
stub template → a structured stub (§5.4); `language` dropped — **English only.**

---

## 7. Evaluation harness

A standing harness under **`eval/`** (sibling to `probes/`) drives Pi headlessly via the SDK
(`createAgentSession` + `DefaultResourceLoader.extensionFactories`, `SessionManager.inMemory`) and
compares two conditions on **buried-answer tasks** — where the answer sits in the *head/middle* of
large output, the part Pi's tail-truncation drops:

- **A — native Pi:** its own truncation (50 KB / 2000 lines + the `fullOutputPath` footer), no extension.
- **C — pi-recall:** capture → index → stub → `recall` (the §5 self-contained design).

**Tasks:** a curated, deterministic fixture suite is the reproducible core — each task is a fixed
`fixture.sh` (buried answer) + a `task.json` (prompt + expected-answer regex), so the only run-to-run
variance is model behavior. An *optional* transcript miner (`mine.ts`) seeds task candidates from real
Pi sessions for human review (the "mine real transcripts" intent), kept off the default path.

**Metrics**, each run over N trials (rates + means, since the model is nondeterministic):
1. **tokens-into-context** — `getSessionStats().tokens` / `getContextUsage()` around the capture turn;
2. **answer accuracy** — last assistant message vs. the task's expected regex (programmatic only);
3. **recall behavior** — `subscribe()` events: did the model call `recall` (C), re-run `bash`, or
   re-read `fullOutputPath` (A's only affordance)? This is the §8 stub-discoverability test.

**Headline comparison:** C should lower tokens-into-context while holding or raising accuracy, with a
non-trivial recall rate proving the stub is actually used. A negative result (model ignores `recall`,
accuracy drops) is valid and reported as-is. Condition C requires the pi-recall extension factory; the
harness loads it pluggably and **skips C** with a clear message until `src/` exists, so A + the fixture
suite are useful immediately. Runs make real (paid) model calls — default to a cheap model for dev.

---

## 8. Open questions / risks

The §1 mechanism risks (V1 hook seam, V2 index round-trip) are now retired — both verified. The live
risks are design-level, to be settled during build:
- **Stub discoverability** — does the model actually call `recall`, or ignore the handle and re-run
  the command? Drives the stub wording (§5.4) and the `recall` `promptSnippet`/`promptGuidelines`.
- **Index relevance over a long session** — BM25 across many captures may blur; per-`source` scoping
  (§5.3) mitigates, but cross-capture queries need evaluation (§7).
- **Eviction / snapshot cost** — `json` snapshots are ~5.4× source bytes; persistence cadence and TTL
  (§5.2) need tuning so a long session doesn't bloat `getAgentDir()`.
- **Composition** — the hook coexists with other `tool_result` handlers (middleware chain); verify no
  conflict with a sandbox/optimizer extension that also rewrites `bash` output.

> Future direction (not a dependency): pi-rtk-optimizer's job — rewriting/compacting commands and
> small output — could be absorbed into pi-recall later, via an existing npm package or a small
> built-in implementation. Out of scope until the capture path is proven.

---

## 9. References

- Anthropic — *Effective context engineering for AI agents* (just-in-time retrieval, hybrid model):
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Redis — *Context Compaction for AI Agents* (reversible vs lossy): https://redis.io/blog/context-compaction/
- *Is Agentic RAG worth it?* (agentic vs naive RAG vs long-context): https://arxiv.org/pdf/2601.07711
- *Coding Agents are Effective Long-Context Processors*: https://arxiv.org/html/2603.20432v1
- *Retrieval-Augmented Code Generation: A Survey (repository-level)*: https://arxiv.org/pdf/2510.04905
- *Git Context Controller* (versioned, recoverable agent context): https://arxiv.org/pdf/2508.00031
- Orama (embedded BM25/vector search, pure TS) — chosen index engine:
  https://github.com/oramasearch/orama
- Orama data-persistence plugin (snapshot/restore index to file):
  https://docs.orama.com/open-source/plugins/plugin-data-persistence
- MiniSearch (pure-JS full-text search, fallback engine): https://github.com/lucaong/minisearch
- context-mode (inspiration — capture-and-search as reversible context; not a dependency): https://github.com/mksglu/context-mode
- pi-rtk-optimizer: https://github.com/MasuRii/pi-rtk-optimizer
- pi-mcp (MCP-on-Pi reference): https://github.com/ElieMessieCode/pi-mcp
- Pi extensions docs (ExtensionAPI: `registerTool`, `pi.exec`, tool override):
  https://pi.dev/docs/latest/extensions
- Pi coding-agent extensions guide:
  https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- Pi tool-override example (overriding a built-in by re-registering its name):
  https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/tool-override.ts
- `@earendil-works/pi-coding-agent` (npm): https://www.npmjs.com/package/@earendil-works/pi-coding-agent
