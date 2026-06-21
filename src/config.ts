// Configuration (SPEC §6).
//
// The factory `(pi) => void` receives no config object, so config is a JSON file layered over code
// defaults — the idiomatic Pi pattern (as in the `sandbox` example extension):
//   global  : ~/.pi/agent/extensions/pi-recall.json  (getAgentDir()/extensions/pi-recall.json)
//   project : <cwd>/.pi/pi-recall.json               (takes precedence)
// A bad/missing file is non-fatal: warn and fall back to defaults. Every key has a default, so
// pi-recall works with zero configuration.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Snapshot serialization format, passed through to @orama/plugin-data-persistence. */
export type PersistFormat = "json" | "binary" | "dpack";

export interface RecallConfig {
  enabled: boolean;
  maxLines: number;
  maxBytes: number;
  persist: boolean;
  persistFormat: PersistFormat;
  chunkLines: number;
  snapshotTtlDays: number;
  recallLimit: number;
  tailLines: number;
  stubTerms: number;
  stubHighlights: number;
  highlightPattern: string;
}

export const DEFAULT_CONFIG: RecallConfig = {
  enabled: true,
  maxLines: 200,
  maxBytes: 5120,
  persist: true,
  persistFormat: "json",
  chunkLines: 20,
  snapshotTtlDays: 7,
  recallLimit: 5,
  tailLines: 40,
  stubTerms: 12,
  stubHighlights: 3,
  highlightPattern:
    "error|warn|fail|exception|fatal|panic|traceback|denied|timeout|✗",
};

const KNOWN_KEYS = new Set(
  Object.keys(DEFAULT_CONFIG) as (keyof RecallConfig)[],
);

type Warn = (msg: string) => void;

function readJsonIfExists(path: string, warn?: Warn): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (e) {
    warn?.(
      `pi-recall: ignoring invalid config ${path}: ${e instanceof Error ? e.message : e}`,
    );
    return {};
  }
}

/** Shallow merge of known config keys only (the config schema is flat — §6 table). */
function mergeKnown(
  base: RecallConfig,
  overrides: Record<string, unknown>,
): RecallConfig {
  const out = { ...base } as Record<string, unknown>;
  for (const k of KNOWN_KEYS) {
    if (overrides[k] !== undefined) out[k] = overrides[k];
  }
  return out as unknown as RecallConfig;
}

/**
 * Load effective config: DEFAULT_CONFIG < global < project (project wins).
 * `warn` is a sink for non-fatal parse warnings.
 */
export function loadConfig(cwd: string, warn?: Warn): RecallConfig {
  const global = readJsonIfExists(
    join(getAgentDir(), "extensions", "pi-recall.json"),
    warn,
  );
  const project = readJsonIfExists(join(cwd, ".pi", "pi-recall.json"), warn);
  return mergeKnown(mergeKnown(DEFAULT_CONFIG, global), project);
}

/**
 * Does `text` exceed pi-recall's own capture gate? Whichever limit is hit first wins (§5.1, §6).
 */
export function overGate(text: string, cfg: RecallConfig): boolean {
  if (Buffer.byteLength(text, "utf8") > cfg.maxBytes) return true;
  // Count newlines + 1 without splitting (cheap on large blobs).
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return lines > cfg.maxLines;
}
