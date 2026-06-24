export const NEEDLE = "ZEBRACORN_4f9a";

/**
 * Output where one distinctive line recurs verbatim at several positions, surrounded by unique
 * filler. Used to exercise recall's batching of identical hits. Returns the text and the line
 * numbers the repeated line lands on.
 */
export function repeatedLineOutput({
  lines = 50,
  needle = NEEDLE,
  at = [10, 12, 25, 40],
} = {}): { text: string; at: number[] } {
  const dupe = `config ${needle} eviction policy mismatch`;
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    out.push(at.includes(i) ? dupe : `line ${i}: routine log entry ${i} ok`);
  }
  return { text: out.join("\n"), at: [...at] };
}

export function bigOutput({ lines = 1500, needleAt = 600 } = {}): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    if (i === needleAt)
      out.push(`line ${i}: ERROR ${NEEDLE} eviction policy mismatch here`);
    else if (i === 5)
      out.push(`line ${i}: WARNING retry backoff timeout pending`);
    else
      out.push(
        `line ${i}: routine log entry alpha beta gamma delta ${(i * 7) % 1000} ok`,
      );
  }
  return out.join("\n");
}
