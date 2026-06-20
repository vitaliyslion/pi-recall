// Embedded Orama index lifecycle (SPEC §5.2). Owns create / restore / add / search / persist / evict.
//
// Schema and persistence are exactly as the V2 probe validated (probes/v2-orama/):
//   - `source` is type `enum` (NOT `string`) so where:{source:{eq}} is an exact scope, not a
//     tokenized fuzzy match.
//   - file persistence lives in @orama/plugin-data-persistence/server (the bare entry is in-memory).

import { create, insertMultiple, search, count } from "@orama/orama";
import {
  persistToFile,
  restoreFromFile,
} from "@orama/plugin-data-persistence/server";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const SCHEMA = { text: "string", source: "enum", startLine: "number" };

/** Directory holding per-session snapshots: getAgentDir()/pi-recall/. */
function dataDir() {
  return join(getAgentDir(), "pi-recall");
}

function snapshotPath(sessionId, format) {
  const ext = format === "json" ? "json" : "msp";
  return join(dataDir(), `${sessionId}.${ext}`);
}

export class RecallStore {
  /** @param {import("./config.js").RecallConfig} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    this.db = create({ schema: SCHEMA });
    this.sessionId = undefined;
    /** command text per source, for stubs/recall hits (§5.3). */
    this.commands = new Map();
    this.captureCount = 0;
  }

  /**
   * Bind to a session and restore its snapshot from disk if one exists (§5.2 lifecycle).
   * @param {string} sessionId
   */
  async restore(sessionId) {
    this.sessionId = sessionId;
    if (!this.cfg.persist) return false;
    const path = snapshotPath(sessionId, this.cfg.persistFormat);
    if (!existsSync(path)) return false;
    try {
      this.db = await restoreFromFile(this.cfg.persistFormat, path);
      return true;
    } catch {
      // Corrupt/incompatible snapshot — start fresh rather than failing the session.
      this.db = create({ schema: SCHEMA });
      return false;
    }
  }

  /**
   * Chunk `full` into ~chunkLines-line groups and insert under `source` (§5.2).
   * @param {string} source  e.g. "exec:<toolCallId>"
   * @param {string} full    the complete, un-truncated output
   * @param {string} command the originating bash command
   */
  async add(source, full, command) {
    const lines = full.split("\n");
    const step = Math.max(1, this.cfg.chunkLines);
    const docs = [];
    for (let i = 0; i < lines.length; i += step) {
      docs.push({
        text: lines.slice(i, i + step).join("\n"),
        source,
        startLine: i,
      });
    }
    await insertMultiple(this.db, docs);
    this.commands.set(source, command);
    this.captureCount++;
    return docs.length;
  }

  /**
   * BM25 search, optionally scoped to one capture (§5.5).
   * @param {string} query
   * @param {string} [source]
   * @param {number} [limit]
   */
  async search(query, source, limit) {
    return search(this.db, {
      term: query,
      where: source ? { source: { eq: source } } : undefined,
      limit: limit ?? this.cfg.recallLimit,
    });
  }

  /** Orama's own tokenizer — same normalization the index stores, so terms are copy-paste-searchable. */
  tokenize(text) {
    return this.db.tokenizer.tokenize(text, undefined, "text");
  }

  /** Per-token document-frequency over the whole index (for demoting common tokens in stubs, §5.4). */
  tokenOccurrences() {
    return this.db.data?.index?.tokenOccurrences?.text ?? {};
  }

  commandFor(source) {
    return this.commands.get(source);
  }

  async docCount() {
    return count(this.db);
  }

  /** Persist the index to disk for cross-session restore. No-op when persist is off. */
  async persist() {
    if (!this.cfg.persist || !this.sessionId) return null;
    await mkdir(dataDir(), { recursive: true });
    const path = snapshotPath(this.sessionId, this.cfg.persistFormat);
    await persistToFile(this.db, this.cfg.persistFormat, path);
    return path;
  }

  /** Snapshot size on disk, or null if none/persist off. */
  async snapshotSize() {
    if (!this.cfg.persist || !this.sessionId) return null;
    const path = snapshotPath(this.sessionId, this.cfg.persistFormat);
    try {
      return (await stat(path)).size;
    } catch {
      return null;
    }
  }

  /** Drop snapshot files older than snapshotTtlDays (§5.2 eviction). Touches nothing else. */
  async evictStale() {
    const dir = dataDir();
    if (!existsSync(dir)) return 0;
    const ttlMs = this.cfg.snapshotTtlDays * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - ttlMs;
    let removed = 0;
    try {
      for (const name of await readdir(dir)) {
        const p = join(dir, name);
        try {
          const s = await stat(p);
          if (s.isFile() && s.mtimeMs < cutoff) {
            await rm(p, { force: true });
            removed++;
          }
        } catch {
          // skip files we can't stat/remove
        }
      }
    } catch {
      // dir vanished — nothing to evict
    }
    return removed;
  }
}
