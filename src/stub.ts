// Stub formatting (SPEC §5.4). The stub *replaces* the captured output but keeps what's useful:
//   1. Tail        — the end Pi already shows (errors/final results usually live there).
//   2. Notable     — auto-highlighted high-signal lines, intent-free (no model input needed).
//   3. Terms       — copy-paste-searchable tokens (via Orama's own tokenizer) + the recall affordance.
// All three are computed from the full text we already hold at capture; none needs the model.

import type { RecallConfig } from "./config.ts";
import type { RecallStore } from "./store.ts";

// prettier-ignore
const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had", "her", "was", "one",
  "our", "out", "day", "get", "has", "him", "his", "how", "man", "new", "now", "old", "see", "two",
  "way", "who", "boy", "did", "its", "let", "put", "say", "she", "too", "use", "with", "this", "that",
  "from", "have", "they", "will", "would", "there", "their", "what", "about", "which", "when", "your",
]);

interface NotableLine {
  lineNo: number;
  text: string;
}

function lastLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.length <= n ? text : lines.slice(-n).join("\n");
}

function countLines(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** First `max` lines matching the highlight pattern, each trimmed to a sane width. */
function notableLines(
  full: string,
  pattern: string,
  max: number,
): NotableLine[] {
  if (max <= 0) return [];
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    return [];
  }
  const out: NotableLine[] = [];
  const lines = full.split("\n");
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const line = lines[i];
    if (re.test(line)) {
      const trimmed = line.trim().replace(/\s+/g, " ");
      out.push({
        lineNo: i,
        text: trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed,
      });
    }
  }
  return out;
}

/**
 * Is `tok` worth offering as a searchable term? Drops stopwords, very short tokens, and low-value
 * noise: purely-numeric, sha/hash-like hex blobs, and mostly-digit ids/timestamps that survive
 * tokenization. None of these make a useful `recall()` query.
 */
function isCandidateTerm(tok: string): boolean {
  if (tok.length < 3 || STOPWORDS.has(tok)) return false;
  if (/^\d+$/.test(tok)) return false; // purely numeric
  if (/^[0-9a-f]{6,}$/.test(tok)) return false; // hex blob (sha/hash fragment)
  let digits = 0;
  for (let i = 0; i < tok.length; i++) {
    const c = tok.charCodeAt(i);
    if (c >= 48 && c <= 57) digits++;
  }
  if (digits * 2 > tok.length) return false; // mostly digits (ids, timestamps)
  return true;
}

/**
 * Copy-paste-searchable terms (§5.4). Ranked by *distinctiveness, not repetition*: within-capture
 * TF-IDF treating each line as a document, so tokens that appear on most lines (path fragments,
 * pass/fail status words — easy to pick up but useless to search) get near-zero IDF and drop out,
 * while tokens concentrated in a few lines (error types, unique symbols, a failing spec's name)
 * rise. A small cross-capture demotion knocks down tokens common across the whole index.
 * Tokenized via Orama's own tokenizer so every term is the exact normalized form the index stores.
 */
export function searchableTerms(
  store: RecallStore,
  full: string,
  want: number,
): string[] {
  if (want <= 0) return [];
  // tf: total occurrences. df: number of distinct lines containing the token (line-level document
  // frequency). Tokenize per line — the tokenizer dedups within a single call, so a whole-blob call
  // would lose both counts; per-line tallying recovers them.
  const tf = new Map<string, number>();
  const df = new Map<string, number>();
  const lines = full.split("\n");
  for (const line of lines) {
    const seen = new Set<string>();
    for (const tok of store.tokenize(line)) {
      if (!isCandidateTerm(tok)) continue;
      tf.set(tok, (tf.get(tok) ?? 0) + 1);
      if (!seen.has(tok)) {
        seen.add(tok);
        df.set(tok, (df.get(tok) ?? 0) + 1);
      }
    }
  }
  const numLines = lines.length;
  const occ = store.tokenOccurrences();
  const scored: { tok: string; score: number }[] = [];
  for (const [tok, f] of tf) {
    const idf = Math.log((numLines + 1) / ((df.get(tok) ?? 0) + 1));
    const tfw = 1 + Math.log(f); // sublinear, so raw repetition can't dominate
    // occ is doc-frequency over the whole index — a small extra demotion for session-common tokens.
    const score = (tfw * idf) / (1 + (occ[tok] ?? 0));
    scored.push({ tok, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, want).map((s) => s.tok);
}

export interface FormatStubArgs {
  /** complete output */
  full: string;
  /** "exec:<id>" */
  source: string;
  /** text to show as the visible tail (Pi's kept tail, or our own) */
  tail: string;
  /** total line count of full */
  totalLines: number;
  store: RecallStore;
  cfg: RecallConfig;
}

/** Build the replacement stub text. */
export function formatStub({
  full,
  source,
  tail,
  totalLines,
  store,
  cfg,
}: FormatStubArgs): string {
  const bytes = Buffer.byteLength(full, "utf8");
  const notable = notableLines(full, cfg.highlightPattern, cfg.stubHighlights);
  const terms = searchableTerms(store, full, cfg.stubTerms);
  const tailLineCount = countLines(tail);

  const card: string[] = [];
  card.push(
    `[pi-recall: full output (${totalLines} lines / ${fmtSize(bytes)}) indexed as ${source}. ` +
      `Showing the last ${tailLineCount} line${tailLineCount === 1 ? "" : "s"}.`,
  );
  if (notable.length) {
    const head = notable[0];
    card.push(
      ` Notable: ${notable.length} match${notable.length === 1 ? "" : "es"} for error/warning patterns` +
        ` — e.g. "line ${head.lineNo}: ${head.text}".`,
    );
  }
  if (terms.length) {
    card.push(` Searchable terms: ${terms.join(", ")}.`);
  }
  card.push(` Search the rest: recall("<query>", source="${source}").]`);

  return `${tail}\n\n${card.join("\n")}`;
}

/** pi-recall's own configured tail: the last `maxTailLines` lines of the complete output. */
export function computeTail(full: string, maxTailLines: number): string {
  return lastLines(full, maxTailLines);
}
