// Embedded Orama index lifecycle (SPEC §5.2). Owns create / restore / add / search / persist / evict.
//
// Schema and persistence are exactly as the V2 probe validated (probes/v2-orama/):
//   - `source` is type `enum` (NOT `string`) so where:{source:{eq}} is an exact scope, not a
//     tokenized fuzzy match.
//   - file persistence lives in @orama/plugin-data-persistence/server (the bare entry is in-memory).

import { count, create, insertMultiple, search } from "@orama/orama";
import type { AnyOrama, Results } from "@orama/orama";
import {
  persistToFile,
  restoreFromFile,
} from "@orama/plugin-data-persistence/server";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PersistFormat, RecallConfig } from "./config.ts";

/** A single indexed chunk — one slice of an earlier command's complete output. */
export interface RecallDoc {
  text: string;
  source: string;
  startLine: number;
}

const SCHEMA = {
  text: "string",
  source: "enum",
  startLine: "number",
} as const;

/** Directory holding per-session snapshots: getAgentDir()/pi-recall/. */
function dataDir(): string {
  return join(getAgentDir(), "pi-recall");
}

function snapshotPath(sessionId: string, format: PersistFormat): string {
  const ext = format === "json" ? "json" : "msp";
  return join(dataDir(), `${sessionId}.${ext}`);
}

export class RecallStore {
  cfg: RecallConfig;
  db: AnyOrama;
  sessionId: string | undefined;
  /** command text per source, for stubs/recall hits (§5.3). */
  commands: Map<string, string>;
  captureCount: number;

  constructor(cfg: RecallConfig) {
    this.cfg = cfg;
    this.db = create({ schema: SCHEMA });
    this.sessionId = undefined;
    this.commands = new Map();
    this.captureCount = 0;
  }

  /** Bind to a session and restore its snapshot from disk if one exists (§5.2 lifecycle). */
  async restore(sessionId: string): Promise<boolean> {
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
   * `source` is e.g. "exec:<toolCallId>"; `full` is the complete, un-truncated output.
   */
  async add(source: string, full: string, command: string): Promise<number> {
    const lines = full.split("\n");
    const step = Math.max(1, this.cfg.chunkLines);
    const docs: RecallDoc[] = [];
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

  /** BM25 search, optionally scoped to one capture (§5.5). */
  async search(
    query: string,
    source?: string,
    limit?: number,
  ): Promise<Results<RecallDoc>> {
    return search<AnyOrama, RecallDoc>(this.db, {
      term: query,
      where: source ? { source: { eq: source } } : undefined,
      limit: limit ?? this.cfg.recallLimit,
    });
  }

  /** Orama's own tokenizer — same normalization the index stores, so terms are copy-paste-searchable. */
  tokenize(text: string): string[] {
    return this.db.tokenizer.tokenize(text, undefined, "text");
  }

  /** Per-token document-frequency over the whole index (for demoting common tokens in stubs, §5.4). */
  tokenOccurrences(): Record<string, number> {
    // tokenOccurrences is internal to Orama's default index store (keyed property → token → count)
    // and not surfaced by the public method types; reach into it deliberately for the "text" prop.
    const index = this.db.data.index as {
      tokenOccurrences?: Record<string, Record<string, number>>;
    };
    return index.tokenOccurrences?.text ?? {};
  }

  commandFor(source: string): string | undefined {
    return this.commands.get(source);
  }

  async docCount(): Promise<number> {
    return count(this.db);
  }

  /** Persist the index to disk for cross-session restore. No-op when persist is off. */
  async persist(): Promise<string | null> {
    if (!this.cfg.persist || !this.sessionId) return null;
    await mkdir(dataDir(), { recursive: true });
    const path = snapshotPath(this.sessionId, this.cfg.persistFormat);
    await persistToFile(this.db, this.cfg.persistFormat, path);
    return path;
  }

  /** Snapshot size on disk, or null if none/persist off. */
  async snapshotSize(): Promise<number | null> {
    if (!this.cfg.persist || !this.sessionId) return null;
    const path = snapshotPath(this.sessionId, this.cfg.persistFormat);
    try {
      return (await stat(path)).size;
    } catch {
      return null;
    }
  }

  /** Drop snapshot files older than snapshotTtlDays (§5.2 eviction). Touches nothing else. */
  async evictStale(): Promise<number> {
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
