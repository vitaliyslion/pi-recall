// Aggregation + reporting. Turns raw per-trial records into rates/means per (task, condition) and
// prints an A-vs-C comparison. The headline the harness makes legible (SPEC §7): C lowers
// tokens-into-context while holding/raising accuracy, with a non-trivial recall rate.

import type { TrialRecord } from "./harness.ts";

const rate = <T>(arr: T[], pred: (t: T) => boolean): number | null =>
  arr.length ? arr.filter(pred).length / arr.length : null;
const mean = <T>(
  arr: T[],
  pick: (t: T) => number | null | undefined,
): number | null => {
  const xs = arr.map(pick).filter((x): x is number => typeof x === "number");
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};

/** Per-(task, condition) rollup of a set of trials. */
export interface Aggregated {
  n: number;
  accuracyRate: number | null;
  recallRate: number | null;
  rerunRate: number | null;
  rereadRate: number | null;
  captureRate: number | null;
  errorRate: number | null;
  bashResultChars: number | null;
  tokensTotal: number | null;
  contextTokens: number | null;
  cost: number | null;
}

export function aggregate(trials: TrialRecord[]): Aggregated {
  return {
    n: trials.length,
    accuracyRate: rate(trials, (t) => t.accurate === true),
    recallRate: rate(trials, (t) => t.recallCalls > 0),
    rerunRate: rate(trials, (t) => t.bashCalls > 1),
    rereadRate: rate(trials, (t) => t.rereadFullOutput),
    captureRate: rate(trials, (t) => t.captured),
    errorRate: rate(trials, (t) => !t.ok),
    bashResultChars: mean(trials, (t) => t.bashResultChars),
    tokensTotal: mean(trials, (t) => t.tokensTotal),
    contextTokens: mean(trials, (t) => t.contextTokens),
    cost: mean(trials, (t) => t.cost),
  };
}

const pct = (x: number | null): string =>
  x === null ? "  -" : `${Math.round(x * 100)}%`.padStart(4);
const num = (x: number | null): string =>
  x === null
    ? "-"
    : x >= 1000
      ? Math.round(x).toLocaleString("en-US")
      : String(Math.round(x));
const money = (x: number | null): string =>
  x === null ? "-" : `$${x.toFixed(4)}`;

/** results: { [taskId]: { [condition]: aggregated } } */
export function printReport(
  results: Record<string, Record<string, Aggregated>>,
  conditions: string[],
): void {
  console.log("");
  for (const [taskId, byCond] of Object.entries(results)) {
    console.log(`■ ${taskId}`);
    console.log(
      `    cond  acc  recall rerun reread capt   bashChars   ctxTok      cost`,
    );
    for (const cond of conditions) {
      const a = byCond[cond];
      if (!a) {
        console.log(`    ${cond}     (skipped)`);
        continue;
      }
      console.log(
        `    ${cond}   ${pct(a.accuracyRate)} ${pct(a.recallRate)}  ${pct(a.rerunRate)}  ${pct(a.rereadRate)}  ${pct(a.captureRate)}  ${num(a.bashResultChars).padStart(9)}  ${num(a.contextTokens).padStart(8)}  ${money(a.cost).padStart(9)}   (n=${a.n}${a.errorRate ? `, err ${pct(a.errorRate)}` : ""})`,
      );
    }
    // Per-task headline delta A->C when both present.
    const A = byCond.A;
    const C = byCond.C;
    if (A && C && A.bashResultChars && C.bashResultChars) {
      const saved = 1 - C.bashResultChars / A.bashResultChars;
      const mag = Math.abs(Math.round(saved * 100));
      const dir = saved >= 0 ? "lower" : "higher";
      console.log(
        `    Δ  bash-output chars into context: ${mag}% ${dir} under C`,
      );
    }
    console.log("");
  }
}
