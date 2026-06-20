// OPTIONAL transcript miner (SPEC §7 "mine real transcripts for buried-answer tasks").
//
// Secondary tool, NOT on the default run path. Scans the user's Pi session JSONL files for large /
// truncated `bash` results — the shape that motivates pi-recall — and emits task *candidates* for
// human review under eval/mined/. It never writes into the committed tasks/ suite: a human turns a
// promising candidate into a real fixture (a frozen fixture.sh + a question + an expected regex).
//
//   node src/mine.js [--limit N] [--min-bytes N] [--sessions <dir>]
//
// Session format (docs/session-format.md): JSONL, one entry per line, entries of
//   {type:"message", id, parentId, message:<AgentMessage>}.
// A model bash call is an assistant message with a {type:"toolCall", name:"bash"} block; its result
// is a later {role:"toolResult", toolName:"bash", details?:{fullOutputPath}} message. Inline/user
// bash is a {role:"bashExecution", command, output, truncated, fullOutputPath} message.

import { readdir, readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL_ROOT = join(HERE, "..");
const DEFAULT_SESSIONS = join(homedir(), ".pi", "agent", "sessions");
const OUT_DIR = join(EVAL_ROOT, "mined");

function parseArgs(argv) {
  const out = { limit: 20, minBytes: 5120, sessions: DEFAULT_SESSIONS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--min-bytes") out.minBytes = Number(argv[++i]);
    else if (a === "--sessions") out.sessions = argv[++i];
  }
  return out;
}

async function* walkJsonl(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(p);
    else if (e.isFile() && p.endsWith(".jsonl")) yield p;
  }
}

const textLen = (content) =>
  Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text).join("").length : 0;
const textOf = (content) =>
  Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text).join("") : "";

/** Pull candidate buried-output bash captures from one session file. */
async function mineFile(file, minBytes) {
  const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
  const commandByCallId = new Map();
  const candidates = [];
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "message") continue;
    const m = entry.message;
    if (!m) continue;

    if (m.role === "assistant") {
      for (const c of m.content ?? []) {
        if (c?.type === "toolCall" && c.name === "bash") {
          commandByCallId.set(c.id, c.arguments?.command ?? "");
        }
      }
    } else if (m.role === "toolResult" && m.toolName === "bash") {
      const bytes = textLen(m.content);
      const fullOutputPath = m.details?.fullOutputPath;
      if (bytes >= minBytes || fullOutputPath) {
        candidates.push({
          file,
          command: commandByCallId.get(m.toolCallId) ?? "(unknown command)",
          bytes,
          truncated: Boolean(fullOutputPath),
          fullOutputPath: fullOutputPath ?? null,
          fullOutputExists: fullOutputPath ? existsSync(fullOutputPath) : false,
          sampleTail: textOf(m.content).slice(-400),
        });
      }
    } else if (m.role === "bashExecution" && (m.truncated || (m.output?.length ?? 0) >= minBytes)) {
      candidates.push({
        file,
        command: m.command ?? "(unknown command)",
        bytes: m.output?.length ?? 0,
        truncated: Boolean(m.truncated),
        fullOutputPath: m.fullOutputPath ?? null,
        fullOutputExists: m.fullOutputPath ? existsSync(m.fullOutputPath) : false,
        sampleTail: (m.output ?? "").slice(-400),
      });
    }
  }
  return candidates;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Mining sessions under ${args.sessions} (min ${args.minBytes} bytes)...`);

  const all = [];
  for await (const file of walkJsonl(args.sessions)) {
    try {
      all.push(...(await mineFile(file, args.minBytes)));
    } catch (e) {
      console.warn(`  skip ${file}: ${e.message}`);
    }
  }
  all.sort((a, b) => b.bytes - a.bytes);
  const picked = all.slice(0, args.limit);

  if (!picked.length) {
    console.log("No large/truncated bash captures found. Nothing to mine.");
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });
  let i = 0;
  for (const c of picked) {
    i++;
    const slug = String(i).padStart(3, "0");
    const dir = join(OUT_DIR, `candidate-${slug}`);
    await mkdir(dir, { recursive: true });
    // Candidate skeleton: a human fills prompt + expected, freezes the output into fixture.sh.
    await writeFile(
      join(dir, "candidate.json"),
      JSON.stringify(
        {
          fromSession: c.file,
          command: c.command,
          bytes: c.bytes,
          truncated: c.truncated,
          fullOutputPath: c.fullOutputPath,
          fullOutputExists: c.fullOutputExists,
          sampleTail: c.sampleTail,
          TODO: "Freeze output into fixture.sh, write a question whose answer is buried in the head/middle, set expect.pattern.",
        },
        null,
        2,
      ),
    );
    console.log(`  candidate-${slug}: ${c.bytes} bytes, truncated=${c.truncated}  $ ${String(c.command).split("\n")[0].slice(0, 80)}`);
  }
  console.log(`\n${picked.length} candidate(s) -> ${OUT_DIR} (review, then promote good ones into tasks/).`);
  void stat;
}

main().catch((e) => {
  console.error("MINER ERROR:", e);
  process.exit(1);
});
