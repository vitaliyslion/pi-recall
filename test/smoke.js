// In-process smoke test for the §1 exit criterion — no model calls.
//
// Drives the extension factory through a fake ExtensionAPI:
//   session_start -> tool_result(big bash output) -> assert stub replaces view
//   -> recall(buried needle) retrieves it -> session_shutdown persists
//   -> a fresh factory restores the snapshot and recall still finds the needle.
//
// Run: node test/smoke.js   (exit 0 = pass, 1 = fail)

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import piRecall from "../src/index.js";

let failed = false;
function check(name, cond, detail = "") {
  const ok = !!cond;
  if (!ok) failed = true;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const NEEDLE = "ZEBRACORN_4f9a";

function bigOutput({ lines = 1500, needleAt = 600 } = {}) {
  const out = [];
  for (let i = 0; i < lines; i++) {
    if (i === needleAt) out.push(`line ${i}: ERROR ${NEEDLE} eviction policy mismatch here`);
    else if (i === 5) out.push(`line ${i}: WARNING retry backoff timeout pending`);
    else out.push(`line ${i}: routine log entry alpha beta gamma delta ${(i * 7) % 1000} ok`);
  }
  return out.join("\n");
}

/** Minimal fake ExtensionAPI capturing handlers/tools/commands/flags. */
function makeFakePi() {
  const handlers = {};
  const flags = {};
  const tools = {};
  const commands = {};
  return {
    _handlers: handlers,
    _tools: tools,
    _commands: commands,
    _flags: flags,
    on(event, handler) {
      (handlers[event] ??= []).push(handler);
    },
    registerFlag(name, opts) {
      flags[name] = opts.default;
    },
    getFlag(name) {
      return flags[name];
    },
    registerTool(tool) {
      tools[tool.name] = tool;
    },
    registerCommand(name, opts) {
      commands[name] = opts;
    },
    async fire(event, ev, ctx) {
      let result;
      for (const h of handlers[event] ?? []) {
        const r = await h(ev, ctx);
        if (r !== undefined) result = r;
      }
      return result;
    },
  };
}

function makeCtx(cwd, sessionId) {
  const notifications = [];
  const statuses = {};
  return {
    cwd,
    ui: {
      notify: (m, t) => notifications.push([t, m]),
      setStatus: (k, v) => (statuses[k] = v),
    },
    sessionManager: { getSessionId: () => sessionId },
    _notifications: notifications,
    _statuses: statuses,
  };
}

function bashEvent({ toolCallId, content, fullOutputPath, isError = false }) {
  return {
    type: "tool_result",
    toolName: "bash",
    toolCallId,
    input: { command: "bash ./run-build.sh" },
    content: [{ type: "text", text: content }],
    isError,
    details: fullOutputPath ? { fullOutputPath, truncation: { truncated: true } } : undefined,
  };
}

async function main() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-recall-smoke-"));
  // Persist snapshots into a temp agent dir so we don't touch the real ~/.pi.
  const agentDir = await mkdtemp(join(tmpdir(), "pi-recall-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const sessionId = "smoke-session-1";

  try {
    check("agent dir redirected to temp (snapshots won't touch real ~/.pi)", getAgentDir() === agentDir, getAgentDir());
    // Project config: small gate so a moderate output is captured; persist on (default format json).
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "pi-recall.json"), JSON.stringify({ maxLines: 200, maxBytes: 5120 }));

    // ── pass 1: capture + recall in a live session ──────────────────────────────────────────────
    const pi = makeFakePi();
    piRecall(pi);
    check("registered recall tool", !!pi._tools.recall);
    check("registered recall-status command", !!pi._commands["recall-status"]);
    check("registered recall-off flag", "recall-off" in pi._flags);

    const ctx = makeCtx(cwd, sessionId);
    await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);

    // (a) inline content over our gate, Pi did NOT truncate (no fullOutputPath).
    const big = bigOutput();
    const res = await pi.fire("tool_result", bashEvent({ toolCallId: "7f3a", content: big }), ctx);
    const stubText = res?.content?.[0]?.text ?? "";
    check("hook returned a replacement", !!res && !!stubText);
    check("stub carries pi-recall marker", stubText.includes("pi-recall"));
    check("stub carries source id exec:7f3a", stubText.includes("exec:7f3a"));
    check("stub does NOT leak the buried needle", !stubText.includes(NEEDLE), "needle should be indexed, not shown");
    check("stub shows a notable highlight", /Notable:/.test(stubText));
    check("stub lists searchable terms", /Searchable terms:/.test(stubText));

    // (a2) A FAILED truncated command: Pi throws, so there is NO details.fullOutputPath — the footer
    //      (and the temp-file path) ride mid-text inside event.content, before "Command exited…".
    //      pi-recall must (1) recover the complete output from the footer's path so recall covers the
    //      whole thing, and (2) strip the footer so the model isn't pointed at a /tmp re-read.
    const completeOutput = bigOutput({ lines: 1500, needleAt: 200 }); // needle buried ABOVE Pi's kept tail
    const tempPath = join(cwd, "pi-bash-deadbeef.log");
    await writeFile(tempPath, completeOutput);
    const keptTail = completeOutput.split("\n").slice(-40).join("\n"); // Pi keeps only a small tail
    const failedContent =
      `${keptTail}\n\n[Showing lines 1461-1500 of 1500 (50.0KB limit). Full output: ${tempPath}]\n\nCommand exited with code 1`;
    const resFoot = await pi.fire(
      "tool_result",
      bashEvent({ toolCallId: "f00d", content: failedContent, isError: true }),
      ctx,
    );
    const footStub = resFoot?.content?.[0]?.text ?? "";
    check("failed-command output is captured", !!resFoot && footStub.includes("exec:f00d"));
    check("stub drops Pi's 'Full output' footer", !footStub.includes("Full output:"));
    check("stub drops Pi's temp path", !footStub.includes("pi-bash-deadbeef"));
    check("stub keeps the real exit status", footStub.includes("Command exited with code 1"));
    const footLines = Number(/full output \((\d+) lines/.exec(footStub)?.[1] ?? 0);
    check("stub reports the COMPLETE line count, not Pi's 40-line tail", footLines >= 1500, `${footLines} lines`);
    const footHit = await pi._tools.recall.execute("call-f", { query: NEEDLE, source: "exec:f00d" }, undefined, undefined, ctx);
    check("recall reaches lines buried above Pi's kept tail", (footHit?.content?.[0]?.text ?? "").includes(NEEDLE));

    // (b) small output below gate → passed through (no replacement).
    const small = "line a\nline b\nline c";
    const resSmall = await pi.fire("tool_result", bashEvent({ toolCallId: "0001", content: small }), ctx);
    check("small output passes through untouched", resSmall === undefined);

    // (b2) a FAILED command with large output is still captured (gate is size-only, not error-gated).
    const resErr = await pi.fire("tool_result", bashEvent({ toolCallId: "e44d", content: bigOutput(), isError: true }), ctx);
    const errStub = resErr?.content?.[0]?.text ?? "";
    check("large error output is still captured", !!resErr && errStub.includes("exec:e44d"));
    check("error stub does NOT leak the buried needle", !errStub.includes(NEEDLE));
    const errHit = await pi._tools.recall.execute("call-e", { query: NEEDLE, source: "exec:e44d" }, undefined, undefined, ctx);
    check("recall retrieves needle from a failed command", (errHit?.content?.[0]?.text ?? "").includes(NEEDLE));

    // (c) recall the buried needle, scoped to the capture.
    const recall = pi._tools.recall;
    const hit = await recall.execute("call-1", { query: NEEDLE, source: "exec:7f3a" }, undefined, undefined, ctx);
    const hitText = hit?.content?.[0]?.text ?? "";
    check("recall retrieves the buried needle", hitText.includes(NEEDLE), hitText.slice(0, 80));
    check("recall hit cites source + line", /exec:7f3a @ line \d+/.test(hitText));
    check("recall hit shows originating command", hitText.includes("run-build.sh"));

    // (d) recall with no match.
    const miss = await recall.execute("call-2", { query: "absolutelynosuchtoken" }, undefined, undefined, ctx);
    check("recall reports no matches cleanly", (miss?.content?.[0]?.text ?? "").includes("no matches"));

    // (e) persist on shutdown.
    await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

    // ── pass 2: a fresh factory restores the snapshot and recall still works (V2 round-trip) ──────
    const pi2 = makeFakePi();
    piRecall(pi2);
    const ctx2 = makeCtx(cwd, sessionId);
    await pi2.fire("session_start", { type: "session_start", reason: "resume" }, ctx2);
    const restored = ctx2._notifications.some(([, m]) => m.includes("restored"));
    check("session restored a prior snapshot", restored);

    const hit2 = await pi2._tools.recall.execute("c", { query: NEEDLE, source: "exec:7f3a" }, undefined, undefined, ctx2);
    check("recall finds the needle AFTER restore", (hit2?.content?.[0]?.text ?? "").includes(NEEDLE));

    // ── pass 3: --recall-off disables capture ─────────────────────────────────────────────────────
    const pi3 = makeFakePi();
    piRecall(pi3);
    pi3._flags["recall-off"] = true;
    const ctx3 = makeCtx(cwd, sessionId);
    await pi3.fire("session_start", { type: "session_start", reason: "startup" }, ctx3);
    const resOff = await pi3.fire("tool_result", bashEvent({ toolCallId: "abcd", content: bigOutput() }), ctx3);
    check("--recall-off passes everything through", resOff === undefined);

    console.log("");
    console.log(failed ? "SMOKE: FAIL" : "SMOKE: PASS — capture → index → stub → recall → persist/restore all work");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("SMOKE ERROR:", e);
  process.exit(1);
});
