/**
 * pi-recall — reversible compaction for the built-in `bash` tool (SPEC §5).
 *
 * A `tool_result` hook scoped to `bash` captures the COMPLETE output (from the temp file when Pi
 * truncated, else from the inline content), indexes it into an embedded Orama BM25 index, and
 * replaces the model-visible output with a compact stub + recall card. The model pulls detail back
 * via a `recall(query, source?)` tool. Nothing is destructively truncated.
 *
 * Self-contained: Pi's native bash runs the command; index + search are an in-process library. No
 * external process, server, or separately-installed tool.
 */

import { isBashToolResult } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { DEFAULT_CONFIG, loadConfig, overGate } from "./config.ts";
import { RecallStore } from "./store.ts";
import { computeTail, formatStub } from "./stub.ts";

/** One element of a tool result's content array (TextContent | ImageContent), derived from Pi. */
type ContentPart = ToolResultEvent["content"][number];
type TextPart = Extract<ContentPart, { type: "text" }>;

/** TextContent parts joined; ImageContent ignored for sizing/indexing (passed through untouched). */
function textOf(content: ContentPart[]): string {
  return content
    .filter((c): c is TextPart => c.type === "text")
    .map((c) => c.text)
    .join("");
}

function countLines(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// Pi appends a truncation footer to the *inline* result content when it caps a bash output —
// `[Showing lines A-B of N (50.0KB limit). Full output: /tmp/…]` (plus byte-limit / partial-last-line
// variants, bash.js formatOutput). On a SUCCESSFUL truncation Pi also exposes the temp file via
// details.fullOutputPath; but on a FAILED command it *throws* (appending e.g. "Command exited with
// code 1"), so details is absent and the footer rides *mid-text* inside event.content. Two problems:
// the footer points the model at a /tmp re-read instead of the recall tool, and — with no
// fullOutputPath — pi-recall would otherwise capture only Pi's kept tail, not the complete output.
//   • PI_FOOTER_PATH recovers the temp-file path from the footer so recall still covers the whole output.
//   • stripPiFooter removes the footer wherever it sits (it is no longer end-anchored — "Command
//     exited…" can follow it) before the text is indexed or shown in our stub tail.
// Both are no-ops on the clean temp-file text (which carries no footer).
const PI_FOOTER_STRIP = /\n*\[Showing [^\]\n]*Full output: [^\]\n]*\]/g;
const PI_FOOTER_PATH = /\[Showing [^\]\n]*Full output: ([^\]\n]+)\]/;
// Anything Pi appended AFTER the footer in the inline content — on a failed command this is the status
// line ("Command exited with code N", "Command aborted", "Command timed out after N seconds"). The
// temp file has no such line, so we re-attach it when we read the complete output from the temp file.
const PI_FOOTER_TRAILER =
  /\[Showing [^\]\n]*Full output: [^\]\n]*\]\s*([\s\S]*)$/;
function stripPiFooter(text: string): string {
  return text.replace(PI_FOOTER_STRIP, "");
}
function piFooterPath(text: string): string | undefined {
  const m = PI_FOOTER_PATH.exec(text);
  return m ? m[1].trim() : undefined;
}
function piTrailingStatus(text: string): string | undefined {
  const m = PI_FOOTER_TRAILER.exec(text);
  const t = m ? m[1].trim() : "";
  return t || undefined;
}

export default function piRecall(pi: ExtensionAPI): void {
  let cfg = DEFAULT_CONFIG;
  let store = new RecallStore(cfg);
  let active = false; // effective enabled = config.enabled && !--recall-off

  pi.registerFlag("recall-off", {
    description:
      "Disable pi-recall capture; pass all bash output through untouched",
    type: "boolean",
    default: false,
  });

  // ── session lifecycle: load config, restore snapshot, evict stale (§5.2, §6) ──────────────────
  pi.on("session_start", async (_event, ctx) => {
    cfg = loadConfig(ctx.cwd, (msg) => ctx.ui.notify(msg, "warning"));
    const off = pi.getFlag("recall-off") === true;
    active = cfg.enabled && !off;

    store = new RecallStore(cfg);
    if (!active) {
      ctx.ui.setStatus(
        "pi-recall",
        off ? "pi-recall: off (--recall-off)" : "pi-recall: off",
      );
      return;
    }

    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const restored = await store.restore(sessionId);
      const evicted = await store.evictStale();
      if (restored)
        ctx.ui.notify("pi-recall: restored prior session index", "info");
      if (evicted)
        ctx.ui.notify(
          `pi-recall: evicted ${evicted} stale snapshot(s)`,
          "info",
        );
    } catch (e) {
      ctx.ui.notify(
        `pi-recall: index restore failed (${e instanceof Error ? e.message : e})`,
        "warning",
      );
    }
    ctx.ui.setStatus(
      "pi-recall",
      `pi-recall: on (>${cfg.maxLines}ln/${Math.round(cfg.maxBytes / 1024)}KB)`,
    );
  });

  pi.on("session_shutdown", async () => {
    if (!active || !cfg.persist) return;
    try {
      await store.persist();
    } catch {
      // best-effort: a failed snapshot must not block shutdown.
    }
  });

  // ── the capture hook: gate + index + stub (§5.1) ──────────────────────────────────────────────
  pi.on("tool_result", async (event) => {
    if (!active) return; // pass through untouched
    if (!isBashToolResult(event)) return; // scope: bash only (type-guarded)

    const inline = textOf(event.content);
    // The COMPLETE output lives in the temp file when Pi truncated. Pi hands us its path via
    // details.fullOutputPath on a successful truncation; on a failed command it only survives inside
    // the inline footer, so recover it from there too. Falsy → the inline content IS complete.
    const path = event.details?.fullOutputPath ?? piFooterPath(inline);
    let full: string;
    try {
      // pi-recall holds the full text and answers entirely to its own config below — Pi's 50 KB /
      // 2000-line cap is just one more truncation the tool transparently covers.
      full = path ? await readFile(path, "utf8") : inline;
    } catch {
      full = inline; // temp file gone — fall back to Pi's inline (truncated) text
    }
    // Drop Pi's `[Showing … Full output: /tmp/…]` footer before it can be indexed or shown in our tail.
    full = stripPiFooter(full);
    // The temp file ends with the command's last line, not Pi's appended status — re-attach it so the
    // model still sees how a failed command ended. (No-op when we fell back to inline, which kept it.)
    const status = piTrailingStatus(inline);
    if (status && !full.endsWith(status)) full = `${full}\n\n${status}`;

    // One config-driven gate, applied to the complete output regardless of whether Pi truncated.
    // (When Pi did truncate, `full` is the large pre-truncation text and is always over the gate.)
    if (!overGate(full, cfg)) return; // below our gate → pass through unchanged

    const source = store.shortSource(event.toolCallId);
    const command =
      typeof event.input?.command === "string" ? event.input.command : "";

    try {
      await store.add(source, full, command);
    } catch {
      // Indexing failed — don't replace the view, so the model still has Pi's output.
      return;
    }

    // Tail: always pi-recall's OWN configured last-N lines of the complete output (never Pi's tail).
    const tail = computeTail(full, cfg.tailLines);
    const totalLines = countLines(full);
    const text = formatStub({ full, source, tail, totalLines, store, cfg });

    return { content: [{ type: "text", text }] };
  });

  // ── the recall tool (§5.5) ────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "recall",
    label: "Recall",
    description:
      "Search the full, un-truncated output of an earlier bash command (BM25). When a bash result " +
      "was replaced by a 'pi-recall' stub, use this to retrieve buried lines instead of re-running " +
      'the command. Pass the stub\'s source id (e.g. "exec:7f3a") to scope to that one output.',
    promptSnippet:
      "recall(query, source?) — search full output of a captured bash result (BM25)",
    promptGuidelines: [
      "When a bash result shows a 'pi-recall' stub, prefer recall(query, source) over re-running the command to find buried output.",
      'Scope to one capture by passing its source id from the stub (e.g. source="exec:7f3a").',
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "BM25 search terms (use the stub's 'Searchable terms').",
      }),
      source: Type.Optional(
        Type.String({
          description:
            'Capture id e.g. "exec:<id>". Omit to search all captures.',
        }),
      ),
      limit: Type.Optional(Type.Number({ description: "Max hits to return." })),
    }),
    async execute(_toolCallId, { query, source, limit }) {
      // Identical output can recur verbatim across a capture (e.g. a repeated log line chunked into
      // several hits) — rendering each separately pollutes the result with duplicate blocks. Orama's
      // groupBy collapses same-(source, text) hits and, because it groups over the full match set, the
      // duplicates never consume the `limit` budget that bounds distinct blocks below.
      const r = await store.search(query, source, undefined, true);
      const groups = r.groups ?? [];
      if (!groups.length) {
        return {
          content: [
            {
              type: "text",
              text: `(no matches for "${query}"${source ? ` in ${source}` : ""})`,
            },
          ],
          details: undefined,
        };
      }
      // Each Orama group is one distinct `text` (groupBy property order is ["text"]); split its hits
      // by source so an unscoped search that matched the same line in two captures yields one block
      // per capture. Groups arrive best-score-first, so block order stays relevance-ordered.
      const blocks: { src: string; body: string; lines: number[] }[] = [];
      for (const g of groups) {
        const body = String(g.values[0]);
        const bySource = new Map<string, number[]>();
        for (const h of g.result) {
          const lines = bySource.get(h.document.source);
          if (lines) lines.push(h.document.startLine);
          else bySource.set(h.document.source, [h.document.startLine]);
        }
        for (const [src, lines] of bySource) blocks.push({ src, body, lines });
      }
      const MAX_LINES_SHOWN = 3;
      // `limit` bounds distinct blocks (not raw hits), so verbatim repeats can't squeeze out matches.
      const text = blocks
        .slice(0, limit ?? store.cfg.recallLimit)
        .map(({ src, body, lines }) => {
          const cmd = store.commandFor(src);
          const sorted = [...lines].sort((a, b) => a - b);
          const shown = sorted.slice(0, MAX_LINES_SHOWN).join(", ");
          const extra = sorted.length - MAX_LINES_SHOWN;
          const at =
            extra > 0
              ? `lines ${shown}, ...${extra} more`
              : `line${sorted.length > 1 ? "s" : ""} ${shown}`;
          const header = `[${src} @ ${at}${cmd ? ` — $ ${cmd}` : ""}]`;
          return `${header}\n${body}`;
        })
        .join("\n\n---\n\n");
      return { content: [{ type: "text", text }], details: undefined };
    },
  });

  // ── /recall-status command (§6) ───────────────────────────────────────────────────────────────
  pi.registerCommand("recall-status", {
    description: "Show pi-recall effective config and index stats",
    handler: async (_args, ctx) => {
      const docs = await store.docCount().catch(() => 0);
      const snap = await store.snapshotSize().catch(() => null);
      const lines = [
        "pi-recall status",
        `  enabled:        ${active}${pi.getFlag("recall-off") === true ? " (forced off by --recall-off)" : ""}`,
        `  gate:           >${cfg.maxLines} lines or >${cfg.maxBytes} bytes`,
        `  persist:        ${cfg.persist} (format: ${cfg.persistFormat})`,
        `  chunkLines:     ${cfg.chunkLines}`,
        `  snapshotTtl:    ${cfg.snapshotTtlDays} day(s)`,
        `  recallLimit:    ${cfg.recallLimit}`,
        `  stub:           ${cfg.stubTerms} terms, ${cfg.stubHighlights} highlights`,
        "",
        `  captures:       ${store.captureCount}`,
        `  indexed chunks: ${docs}`,
        `  snapshot size:  ${snap == null ? "(none)" : `${snap} bytes`}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
