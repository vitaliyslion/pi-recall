// Post-run metric extraction. Source of truth is session.messages (deterministic, model-agnostic
// to parse); token totals come from getSessionStats(). Maps to SPEC §7's three metric families:
//   1. tokens-into-context  -> bashResultChars (chars of the bash result that entered context) + tokens
//   2. answer accuracy      -> finalAnswer vs task.expect (programmatic regex/substring)
//   3. recall behavior      -> recallCalls / bashCalls (reruns) / rereadFullOutput
//
// AgentMessage shapes (from @earendil-works/pi-ai):
//   assistant: { role:"assistant", content:[ {type:"text",text} | {type:"toolCall",id,name,arguments} ], usage }
//   toolResult:{ role:"toolResult", toolName, content:[ {type:"text",text} ], isError }
// We read these structurally (the SDK's AgentMessage union lives in a transitive dep), so the local
// EvalMessage/ContentBlock shapes below describe just the fields this analysis touches.

const FULLOUTPUT_PATH_RE = /fulloutput|pi-bash|\/tmp\/|tmpdir|\.pi[\\/]/i;

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  arguments?: Record<string, unknown>;
}

export interface EvalMessage {
  role?: string;
  content?: ContentBlock[];
  stopReason?: string;
  errorMessage?: string;
  toolName?: string;
}

/** task.json's `expect`: a regex `pattern` or a case-insensitive `substring`. */
export interface ExpectSpec {
  pattern?: string;
  substring?: string;
}

export interface Metrics {
  bashCalls: number;
  recallCalls: number;
  readCalls: number;
  rereadFullOutput: boolean;
  bashResultChars: number;
  captured: boolean;
  finalAnswer: string;
  apiError: string | null; // assistant turn that ended in stopReason "error"/"aborted"
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : "";
  }
  return (content as ContentBlock[])
    .filter((c) => c?.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

/** Analyze a finished session's messages into behavioral metrics. */
export function analyzeMessages(
  messages: readonly EvalMessage[] | undefined,
  { stubMarker = "pi-recall" }: { stubMarker?: string } = {},
): Metrics {
  let bashCalls = 0;
  let recallCalls = 0;
  let readCalls = 0;
  let rereadFullOutput = false;
  let bashResultChars = 0;
  let captured = false;
  let finalAnswer = "";
  let apiError: string | null = null;

  for (const m of messages ?? []) {
    if (m.role === "assistant") {
      if (m.stopReason === "error" || m.stopReason === "aborted") {
        apiError = m.errorMessage ?? `assistant stopReason: ${m.stopReason}`;
      }
      const text = textOf(m.content).trim();
      if (text) finalAnswer = text; // keep last non-empty assistant text as the answer
      for (const c of m.content ?? []) {
        if (c?.type !== "toolCall") continue;
        if (c.name === "bash") bashCalls++;
        else if (c.name === "recall") recallCalls++;
        else if (c.name === "read") {
          readCalls++;
          const p = String(
            c.arguments?.path ??
              c.arguments?.file ??
              c.arguments?.file_path ??
              "",
          );
          if (FULLOUTPUT_PATH_RE.test(p)) rereadFullOutput = true;
        }
      }
    } else if (m.role === "toolResult" && m.toolName === "bash") {
      const text = textOf(m.content);
      bashResultChars += text.length;
      if (text.includes(stubMarker)) captured = true;
    }
  }

  return {
    bashCalls,
    recallCalls,
    readCalls,
    rereadFullOutput,
    bashResultChars,
    captured,
    finalAnswer,
    apiError,
  };
}

/** Programmatic accuracy check against task.expect ({pattern} regex or {substring}). */
export function checkAccuracy(
  answer: string | undefined,
  expect: ExpectSpec | undefined,
): boolean | null {
  if (!expect) return null;
  const a = answer ?? "";
  if (expect.pattern) return new RegExp(expect.pattern, "i").test(a);
  if (expect.substring) {
    return a.toLowerCase().includes(String(expect.substring).toLowerCase());
  }
  return null;
}
