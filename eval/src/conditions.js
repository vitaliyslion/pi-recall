// Condition wiring for the eval harness.
//
//   A — native Pi: no extensions at all (Pi's own tail-truncation + fullOutputPath footer).
//   C — pi-recall: ONLY the pi-recall extension factory loaded (capture -> index -> stub -> recall).
//
// Both use noExtensions:true so discovered/user extensions never pollute a run; extensionFactories
// load independently of that flag (resource-loader.js:681), so C still gets pi-recall.

import {
  DefaultResourceLoader,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";

// Fixed gate written as a project config (<cwd>/.pi/pi-recall.json, SPEC §6) for condition C so the
// capture threshold is held constant across runs and snapshots never touch disk during eval.
export const RECALL_PROJECT_CONFIG = {
  maxLines: 200,
  maxBytes: 5120,
  persist: false,
};

/**
 * Resolve the extension factories for a condition.
 * Returns { factories } on success, or { skip } when condition C's extension can't be loaded
 * (e.g. pi-recall's src/ doesn't exist yet) — the harness then skips C with this message.
 */
export async function resolveCondition(condition, extPath) {
  if (condition === "A") return { factories: [] };
  if (condition === "C") {
    try {
      // Resolve relative paths against the caller's cwd (not this module), then to a file URL.
      const abs =
        isAbsolute(extPath) || extPath.includes("://")
          ? extPath
          : resolve(process.cwd(), extPath);
      const spec = abs.includes("://") ? abs : pathToFileURL(abs).href;
      const mod = await import(spec);
      const factory = mod.default ?? mod.createRecallExtension ?? mod.recall;
      if (typeof factory !== "function") {
        throw new Error("module has no default extension factory export");
      }
      return { factories: [factory] };
    } catch (e) {
      return {
        skip: `condition C skipped: pi-recall extension not loadable at ${extPath} (${e.message})`,
      };
    }
  }
  return { skip: `unknown condition "${condition}"` };
}

export function makeLoader(cwd, factories) {
  return new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    extensionFactories: factories,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
}
