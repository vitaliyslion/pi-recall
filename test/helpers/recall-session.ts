// Integration harness: loads the real pi-recall extension into a real Pi runtime (no model calls)
// and exposes the real ExtensionRunner. Tests drive genuine events through it —
// runner.emitToolResult(), the recall tool's execute(), the /recall-status command — exactly as Pi
// would, instead of a hand-rolled fake ExtensionAPI.
//
// Bash is NOT executed: runBash() drives Pi's real bash *tool* through a mocked BashOperations
// backend that streams canned output and returns an exit code. No process is spawned (safe + CI
// stable), yet Pi still performs its real truncation, temp-file (fullOutputPath) and footer work,
// so src/index.ts's footer regexes are exercised against genuine Pi output.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession,
  createBashToolDefinition,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionRunner,
  ExtensionUIContext,
  SessionStartEvent,
  SessionShutdownEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import piRecall from "../../src/index.ts";

type Content = ToolResultEvent["content"];
export type EmitResult = Awaited<ReturnType<ExtensionRunner["emitToolResult"]>>;

/** The model-visible text of a hook result (text parts joined; "" when nothing was replaced). */
export function textOf(res: EmitResult): string {
  if (!res) return "";
  return (res.content ?? [])
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("");
}

/** Notifications and statuses the extension pushed through ctx.ui, captured for assertions. */
export interface CapturedUI {
  notifications: Array<{ level: string; message: string }>;
  statuses: Record<string, string>;
  /** True if any notification's message includes `needle`. */
  notified: (needle: string) => boolean;
}

function makeCapturingUI(): { ui: ExtensionUIContext; captured: CapturedUI } {
  const notifications: CapturedUI["notifications"] = [];
  const statuses: Record<string, string> = {};
  const base = {
    notify: (message: string, level?: string) =>
      notifications.push({ level: level ?? "info", message }),
    setStatus: (key: string, value: string) => {
      statuses[key] = value;
    },
  };
  // pi-recall only uses notify/setStatus; default every other UI method to a no-op so the headless
  // run never throws on an unimplemented affordance.
  const ui = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop as keyof typeof target];
      return () => undefined;
    },
  }) as unknown as ExtensionUIContext;
  const captured: CapturedUI = {
    notifications,
    statuses,
    notified: (needle) => notifications.some((n) => n.message.includes(needle)),
  };
  return { ui, captured };
}

export interface MakeRecallOptions {
  cwd: string;
  /** Fixed session id (so a second harness can restore the first's snapshot). Default: in-memory. */
  sessionId?: string;
  /** Project config written to <cwd>/.pi/pi-recall.json before the session starts. */
  config?: Record<string, unknown>;
  /** Emit session_start automatically. Set false to set flags before start (e.g. --recall-off). */
  autoStart?: boolean;
}

export interface RecallHarness {
  runner: ExtensionRunner;
  ui: CapturedUI;
  sessionId: string;
  start: (reason?: SessionStartEvent["reason"]) => Promise<void>;
  shutdown: (reason?: SessionShutdownEvent["reason"]) => Promise<void>;
  /**
   * Feed `output` through Pi's bash tool (mocked exec backend — no real process) and the capture
   * hook. `opts.exitCode` non-zero makes Pi throw like a failed command; `opts.command` is the
   * label recorded on the event (echoed back by recall).
   */
  runBash: (
    id: string,
    output: string,
    opts?: { exitCode?: number; command?: string },
  ) => Promise<EmitResult>;
  /** Invoke the recall tool; returns the model-visible text. */
  recall: (args: {
    query: string;
    source?: string;
    limit?: number;
  }) => Promise<string>;
  /** Invoke a registered slash command (e.g. "recall-status"). */
  runCommand: (name: string, args?: string) => Promise<void>;
  dispose: () => void;
}

export async function makeRecall(
  opts: MakeRecallOptions,
): Promise<RecallHarness> {
  const { cwd, sessionId, config, autoStart = true } = opts;

  if (config) {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "pi-recall.json"), JSON.stringify(config));
  }

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    extensionFactories: [piRecall],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  const sessionManager = sessionId
    ? SessionManager.create(cwd, join(cwd, ".sessions"), { id: sessionId })
    : SessionManager.inMemory(cwd);

  const { session } = await createAgentSession({
    cwd,
    tools: ["bash", "recall"],
    resourceLoader: loader,
    sessionManager,
  });

  const { ui, captured } = makeCapturingUI();
  // Headless bind: the SDK path does not emit session_start on its own (the TUI/CLI does), so tests
  // emit it via start() — pi-recall arms its capture hook there.
  await session.bindExtensions({ uiContext: ui, mode: "print" });
  const runner = session.extensionRunner;

  const emitToolResult = (event: ToolResultEvent) =>
    runner.emitToolResult(event);

  const start: RecallHarness["start"] = async (reason = "startup") => {
    await runner.emit({ type: "session_start", reason });
  };
  const shutdown: RecallHarness["shutdown"] = async (reason = "quit") => {
    await runner.emit({ type: "session_shutdown", reason });
  };

  const runBash: RecallHarness["runBash"] = async (id, output, opts = {}) => {
    const { exitCode = 0, command = "bash ./run-build.sh" } = opts;
    // Mocked exec backend: stream the canned output, return the exit code, spawn nothing. Pi's bash
    // tool still does the real truncation / temp-file / footer handling around it.
    const bashDef = createBashToolDefinition(cwd, {
      operations: {
        async exec(_command, _cwd, { onData }) {
          if (output) onData(Buffer.from(output, "utf8"));
          return { exitCode };
        },
      },
    });
    let content: Content;
    let details: unknown;
    let isError: boolean;
    try {
      const r = await bashDef.execute(
        id,
        { command },
        undefined,
        undefined,
        runner.createContext(),
      );
      content = r.content;
      details = r.details;
      isError = false;
    } catch (e) {
      // Pi's bash throws on non-zero exit with the footer + status baked into the message; the
      // agent-session turns that into an error tool_result with no details — replicate it here.
      content = [
        { type: "text", text: e instanceof Error ? e.message : String(e) },
      ];
      details = undefined;
      isError = true;
    }
    return emitToolResult({
      type: "tool_result",
      toolName: "bash",
      toolCallId: id,
      input: { command },
      content,
      isError,
      details,
    } as ToolResultEvent);
  };

  const recall: RecallHarness["recall"] = async (args) => {
    const tool = runner.getToolDefinition("recall");
    if (!tool) throw new Error("recall tool not registered");
    const r = await tool.execute(
      "call",
      args,
      undefined,
      undefined,
      runner.createContext(),
    );
    return r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  };

  const runCommand: RecallHarness["runCommand"] = async (name, args = "") => {
    const cmd = runner.getCommand(name);
    if (!cmd) throw new Error(`command not registered: ${name}`);
    await cmd.handler(args, runner.createCommandContext());
  };

  if (autoStart) await start();

  return {
    runner,
    ui: captured,
    sessionId: session.sessionId,
    start,
    shutdown,
    runBash,
    recall,
    runCommand,
    dispose: () => session.dispose(),
  };
}
