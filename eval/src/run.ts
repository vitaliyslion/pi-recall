// Eval harness CLI entry. Drives every (task × condition × trial) and prints + persists a report.
//
//   node src/run.ts [--tasks all|id,id] [--conditions A,C] [--trials N]
//                   [--model provider/id] [--ext <path>] [--out <file>]
//
// Conditions: A = native Pi, C = pi-recall (skipped with a message until the extension exists).
// NOTE: runs make real, paid model calls — keep the task set small and prefer a cheap --model.

import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { resolveCondition } from "./conditions.ts";
import { runTrial, type Task, type TrialRecord } from "./harness.ts";
import { aggregate, type Aggregated, printReport } from "./report.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL_ROOT = join(HERE, "..");
const TASKS_DIR = join(EVAL_ROOT, "tasks");
const RESULTS_DIR = join(EVAL_ROOT, "results");
const DEFAULT_EXT = join(EVAL_ROOT, "..", "src", "index.ts"); // pi-recall extension entry

interface Args {
  tasks: string;
  conditions: string[];
  trials: number;
  model: string | null;
  ext: string;
  outFile: string | null;
  help: boolean;
}

interface LoadedTask {
  task: Task;
  taskDir: string;
  id: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    tasks: "all",
    conditions: ["A", "C"],
    trials: 3,
    model: null,
    ext: DEFAULT_EXT,
    outFile: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--tasks") out.tasks = next();
    else if (a === "--conditions")
      out.conditions = next()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === "--trials") out.trials = Number(next());
    else if (a === "--model") out.model = next();
    else if (a === "--ext") out.ext = next();
    else if (a === "--out") out.outFile = next();
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

async function loadTasks(filter: string): Promise<LoadedTask[]> {
  const entries = await readdir(TASKS_DIR, { withFileTypes: true });
  const ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const want =
    filter === "all" ? null : new Set(filter.split(",").map((s) => s.trim()));
  const tasks: LoadedTask[] = [];
  for (const id of ids) {
    if (want && !want.has(id)) continue;
    const taskDir = join(TASKS_DIR, id);
    const task = JSON.parse(
      await readFile(join(taskDir, "task.json"), "utf8"),
    ) as Task;
    tasks.push({ task, taskDir, id });
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

async function resolveModel(
  spec: string | null,
): Promise<Model<any> | undefined> {
  if (!spec) return undefined; // SDK uses settings default
  const slash = spec.indexOf("/");
  if (slash < 0)
    throw new Error(`--model must be "provider/id", got "${spec}"`);
  const provider = spec.slice(0, slash);
  const id = spec.slice(slash + 1);
  const { getModel } = await import("@earendil-works/pi-ai");
  return (getModel as (provider: string, modelId: string) => Model<any>)(
    provider,
    id,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node src/run.ts [--tasks all|id,..] [--conditions A,C] [--trials N] [--model provider/id] [--ext path] [--out file]",
    );
    return;
  }

  const tasks = await loadTasks(args.tasks);
  if (!tasks.length) {
    console.error(`No tasks matched "${args.tasks}" in ${TASKS_DIR}`);
    process.exit(1);
  }
  const model = await resolveModel(args.model);

  console.log(
    `pi-recall eval — ${tasks.length} task(s), conditions [${args.conditions.join(", ")}], ${args.trials} trial(s) each`,
  );
  console.log(`model: ${args.model ?? "(settings default)"}`);

  // Resolve conditions once (this is where C is skipped if the extension isn't built).
  const condFactories: Record<string, ExtensionFactory[]> = {};
  const activeConditions: string[] = [];
  for (const cond of args.conditions) {
    const r = await resolveCondition(cond, args.ext);
    if ("skip" in r) {
      console.log(`! ${r.skip}`);
      continue;
    }
    condFactories[cond] = r.factories;
    activeConditions.push(cond);
  }
  if (!activeConditions.length) {
    console.error("No runnable conditions.");
    process.exit(1);
  }

  // results[taskId][cond] = aggregated; rawTrials keeps every record for the JSON file.
  const results: Record<string, Record<string, Aggregated>> = {};
  const rawTrials: Array<
    { taskId: string; condition: string; trial: number } & TrialRecord
  > = [];
  for (const { task, taskDir, id } of tasks) {
    results[id] = {};
    for (const cond of activeConditions) {
      const trials: TrialRecord[] = [];
      for (let t = 0; t < args.trials; t++) {
        process.stdout.write(
          `  ${id} [${cond}] trial ${t + 1}/${args.trials} ... `,
        );
        const rec = await runTrial({
          task,
          taskDir,
          condition: cond,
          factories: condFactories[cond],
          model,
        });
        trials.push(rec);
        rawTrials.push({ taskId: id, condition: cond, trial: t, ...rec });
        console.log(
          `${rec.ok ? (rec.accurate ? "OK accurate" : "OK miss") : "ERROR"}${cond === "C" ? ` (recall:${rec.recallCalls}, capt:${rec.captured})` : ""}`,
        );
      }
      results[id][cond] = aggregate(trials);
    }
  }

  printReport(results, activeConditions);

  await mkdir(RESULTS_DIR, { recursive: true });
  const outFile =
    args.outFile ??
    join(RESULTS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(
    outFile,
    JSON.stringify({ args: { ...args }, results, rawTrials }, null, 2),
  );
  console.log(`raw results -> ${outFile}`);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
