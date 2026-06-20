// Drives a single (task, condition) trial: builds an isolated cwd, runs a headless Pi session under
// the condition's extensions, and returns the per-trial metrics.

import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtemp, mkdir, copyFile, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLoader, RECALL_PROJECT_CONFIG } from "./conditions.js";
import { analyzeMessages, checkAccuracy } from "./metrics.js";

// Headless no-op UI context for bindExtensions: every method is a no-op. Extensions that call
// ctx.ui.notify / setStatus (pi-recall does) must not throw in a non-interactive run.
const HEADLESS_UI = new Proxy({}, { get: () => () => undefined });

/**
 * Run one trial.
 * @param {object} a
 * @param {object} a.task     parsed task.json
 * @param {string} a.taskDir  directory containing fixture.sh
 * @param {"A"|"C"} a.condition
 * @param {Function[]} a.factories  extension factories for the condition (from resolveCondition)
 * @param {object|undefined} a.model  resolved Model, or undefined to use Pi's settings default
 */
export async function runTrial({ task, taskDir, condition, factories, model }) {
  // Isolated cwd per trial: copy in the fixture, never touch the committed tasks/ dir, and let the
  // in-memory session write nothing of its own.
  const cwd = await mkdtemp(join(tmpdir(), "pi-recall-eval-"));
  try {
    await copyFile(join(taskDir, "fixture.sh"), join(cwd, "fixture.sh"));
    await chmod(join(cwd, "fixture.sh"), 0o755);
    if (condition === "C") {
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(join(cwd, ".pi", "pi-recall.json"), JSON.stringify(RECALL_PROJECT_CONFIG));
    }

    const loader = makeLoader(cwd, factories);
    await loader.reload();

    const { session } = await createAgentSession({
      cwd,
      model, // undefined -> Pi picks from settings
      // read lets the model re-fetch fullOutputPath (A's only affordance); recall is pi-recall's
      // tool (C only — harmless name in A's allowlist). NOTE: the `tools` allowlist filters
      // extension tools too, so recall MUST be listed or the model never sees it.
      tools: ["bash", "read", "recall"],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
    });

    // The headless SDK path does not emit session_start on its own (the TUI/CLI calls bindExtensions).
    // pi-recall arms its capture hook in session_start, so we must trigger it here or C never captures.
    await session.bindExtensions({ uiContext: HEADLESS_UI, mode: "print" });

    const eventCounts = {};
    const unsub = session.subscribe((e) => {
      eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1;
    });

    let error = null;
    try {
      await session.prompt(task.prompt);
    } catch (e) {
      error = e?.message ?? String(e);
    }

    const messages = session.messages;
    const stats = typeof session.getSessionStats === "function" ? session.getSessionStats() : null;
    const ctx = typeof session.getContextUsage === "function" ? session.getContextUsage() : null;

    unsub();
    session.dispose();

    const m = analyzeMessages(messages);
    const accurate = checkAccuracy(m.finalAnswer, task.expect);
    // A turn that ended in stopReason "error"/"aborted" (e.g. provider 4xx) is a failed run even
    // though prompt() didn't throw — surface it instead of silently scoring it as an accuracy miss.
    if (error === null && m.apiError) error = m.apiError;

    return {
      ok: error === null,
      error,
      accurate,
      ...m,
      tokensTotal: stats?.tokens?.total ?? null,
      tokensInput: stats?.tokens?.input ?? null,
      tokensOutput: stats?.tokens?.output ?? null,
      contextTokens: ctx?.tokens ?? stats?.contextUsage?.tokens ?? null,
      cost: stats?.cost ?? null,
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
