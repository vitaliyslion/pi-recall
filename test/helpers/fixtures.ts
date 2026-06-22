export const NEEDLE = "ZEBRACORN_4f9a";

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
