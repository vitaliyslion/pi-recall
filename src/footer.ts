// Footer status string for Pi's status bar 

const TICK = "✓";
const CROSS = "✗";

/** Rough token estimate — the standard ~4-chars-per-token heuristic; mirrors Pi's own estimateTokens
 *  (chars/4) so this footer's number stays on the same scale as Pi's context-usage display. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Humanize a token count: <1000 verbatim, then K, then M. */
export function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// The status-bar string. Active → tick + humanized session token savings; inactive → a bare cross
export function footerStatus(opts: {
  active: boolean;
  savedTokens: number;
}): string {
  if (!opts.active) return `pi-recall: ${CROSS}`;
  return `pi-recall: ${TICK} ${fmtTokens(opts.savedTokens)}`;
}
