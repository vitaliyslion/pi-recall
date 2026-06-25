// Results visualizer. Bakes every results/*.json into one self-contained eval/report.html so runs
// can be charted and compared in a browser. No server, no build step — re-run to pick up new runs.
//
//   node src/viz.ts [--out <file>]
//
// All UI/chart logic lives in web/template.html; this just injects the data
// into the `/*__DATA__*/` token and writes the file.

import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL_ROOT = join(HERE, "..");
const RESULTS_DIR = join(EVAL_ROOT, "results");
const TEMPLATE = join(EVAL_ROOT, "web", "template.html");
const DEFAULT_OUT = join(EVAL_ROOT, "report.html");
const DATA_TOKEN = "/*__DATA__*/[]";

/** One run as the UI consumes it: parsed JSON plus file identity and a sortable timestamp. */
interface Run {
  file: string;
  label: string;
  time: string; // ISO, from file mtime (reliable; custom --out names don't encode a timestamp)
  args: unknown;
  results: unknown;
  rawTrials: unknown;
}

async function loadRuns(): Promise<Run[]> {
  let entries: string[];
  try {
    entries = (await readdir(RESULTS_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const runs: Run[] = [];
  for (const file of entries) {
    const full = join(RESULTS_DIR, file);
    try {
      const [raw, st] = await Promise.all([readFile(full, "utf8"), stat(full)]);
      const parsed = JSON.parse(raw) as {
        args?: unknown;
        results?: unknown;
        rawTrials?: unknown;
      };
      runs.push({
        file,
        label: file.replace(/\.json$/, ""),
        time: st.mtime.toISOString(),
        args: parsed.args ?? null,
        results: parsed.results ?? {},
        rawTrials: parsed.rawTrials ?? [],
      });
    } catch (e) {
      console.warn(`! skipping ${file}: ${(e as Error).message}`);
    }
  }
  return runs.sort((a, b) => a.time.localeCompare(b.time));
}

function parseOut(argv: string[]): string {
  const i = argv.indexOf("--out");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : DEFAULT_OUT;
}

async function main(): Promise<void> {
  const out = parseOut(process.argv.slice(2));
  const runs = await loadRuns();
  if (!runs.length) {
    console.warn(`No result files in ${RESULTS_DIR} — generating an empty report.`);
  }

  const template = await readFile(TEMPLATE, "utf8");
  if (!template.includes(DATA_TOKEN)) {
    throw new Error(`template ${TEMPLATE} is missing the ${DATA_TOKEN} token`);
  }
  const html = template.replace(DATA_TOKEN, JSON.stringify(runs));

  await writeFile(out, html);
  console.log(`wrote ${out} (${runs.length} run${runs.length === 1 ? "" : "s"})`);
}

main().catch((e) => {
  console.error("VIZ ERROR:", e);
  process.exit(1);
});
