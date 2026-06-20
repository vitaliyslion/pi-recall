// Stub formatting (SPEC §5.4). The stub *replaces* the captured output but keeps what's useful:
//   1. Tail        — the end Pi already shows (errors/final results usually live there).
//   2. Notable     — auto-highlighted high-signal lines, intent-free (no model input needed).
//   3. Terms       — copy-paste-searchable tokens (via Orama's own tokenizer) + the recall affordance.
// All three are computed from the full text we already hold at capture; none needs the model.

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had", "her", "was", "one",
  "our", "out", "day", "get", "has", "him", "his", "how", "man", "new", "now", "old", "see", "two",
  "way", "who", "boy", "did", "its", "let", "put", "say", "she", "too", "use", "with", "this", "that",
  "from", "have", "they", "will", "would", "there", "their", "what", "about", "which", "when", "your",
]);

function lastLines(text, n) {
  const lines = text.split("\n");
  return lines.length <= n ? text : lines.slice(-n).join("\n");
}

function countLines(text) {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** First `max` lines matching the highlight pattern, each trimmed to a sane width. */
function notableLines(full, pattern, max) {
  if (max <= 0) return [];
  let re;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    return [];
  }
  const out = [];
  const lines = full.split("\n");
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const line = lines[i];
    if (re.test(line)) {
      const trimmed = line.trim().replace(/\s+/g, " ");
      out.push({ lineNo: i, text: trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed });
    }
  }
  return out;
}

/**
 * Copy-paste-searchable terms (§5.4). Rank by in-capture frequency, demoted by cross-capture
 * doc-frequency so distinctive tokens rise. Drop stopwords, very short, and purely-numeric tokens.
 * Tokenized via Orama's own tokenizer so every term is the exact normalized form the index stores.
 */
function searchableTerms(store, full, want) {
  if (want <= 0) return [];
  const freq = new Map();
  // Tokenize per line: the tokenizer dedups within a single call, so a whole-blob call would lose
  // frequency. Per-line tallying recovers a usable in-capture frequency.
  for (const line of full.split("\n")) {
    for (const tok of store.tokenize(line)) {
      if (tok.length < 3 || /^\d+$/.test(tok) || STOPWORDS.has(tok)) continue;
      freq.set(tok, (freq.get(tok) ?? 0) + 1);
    }
  }
  const occ = store.tokenOccurrences();
  const scored = [];
  for (const [tok, f] of freq) {
    // demote tokens that are common across captures (occ is doc-frequency over the whole index).
    const score = f / (1 + (occ[tok] ?? 0));
    scored.push({ tok, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, want).map((s) => s.tok);
}

/**
 * Build the replacement stub text.
 * @param {object} a
 * @param {string} a.full        complete output
 * @param {string} a.source      "exec:<id>"
 * @param {string} a.tail        text to show as the visible tail (Pi's kept tail, or our own)
 * @param {number} a.totalLines  total line count of full
 * @param {import("./store.js").RecallStore} a.store
 * @param {import("./config.js").RecallConfig} a.cfg
 */
export function formatStub({ full, source, tail, totalLines, store, cfg }) {
  const bytes = Buffer.byteLength(full, "utf8");
  const notable = notableLines(full, cfg.highlightPattern, cfg.stubHighlights);
  const terms = searchableTerms(store, full, cfg.stubTerms);
  const tailLineCount = countLines(tail);

  const card = [];
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
export function computeTail(full, maxTailLines) {
  return lastLines(full, maxTailLines);
}
