// Aggregation + reporting. Turns raw per-trial records into rates/means per (task, condition) and
// prints an A-vs-C comparison. The headline the harness makes legible (SPEC §7): C lowers
// tokens-into-context while holding/raising accuracy, with a non-trivial recall rate.

const rate = (arr, pred) => (arr.length ? arr.filter(pred).length / arr.length : null);
const mean = (arr, pick) => {
  const xs = arr.map(pick).filter((x) => typeof x === "number");
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};

export function aggregate(trials) {
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

const pct = (x) => (x === null ? "  -" : `${Math.round(x * 100)}%`.padStart(4));
const num = (x) => (x === null ? "-" : x >= 1000 ? Math.round(x).toLocaleString("en-US") : String(Math.round(x)));
const money = (x) => (x === null ? "-" : `$${x.toFixed(4)}`);

/** results: { [taskId]: { [condition]: aggregated } } */
export function printReport(results, conditions) {
  const cols = ["acc", "recall", "rerun", "reread", "capt", "bashChars", "ctxTok", "cost"];
  console.log("");
  for (const [taskId, byCond] of Object.entries(results)) {
    console.log(`■ ${taskId}`);
    console.log(`    cond  acc  recall rerun reread capt   bashChars   ctxTok      cost`);
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
    const A = byCond.A, C = byCond.C;
    if (A && C && A.bashResultChars && C.bashResultChars) {
      const saved = 1 - C.bashResultChars / A.bashResultChars;
      const mag = Math.abs(Math.round(saved * 100));
      const dir = saved >= 0 ? "lower" : "higher";
      console.log(`    Δ  bash-output chars into context: ${mag}% ${dir} under C`);
    }
    console.log("");
  }
  void cols;
}
