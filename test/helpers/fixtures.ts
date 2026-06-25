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

/**
 * A synthetic test-run log: many near-identical `PASS src/.../<name>.spec.ts` lines (the repetitive
 * boilerplate that should NOT surface as searchable terms) plus a couple of failures and one
 * distinctive error line. `distinctive` lists the tokens (already lower-cased to the tokenizer's
 * normalized form) that good distinctiveness-ranking should surface; `boilerplate` lists the
 * repetitive path/status tokens it should drop.
 */
export function testRunOutput(): {
  text: string;
  distinctive: string[];
  boilerplate: string[];
} {
  const names = [
    "button",
    "input",
    "modal",
    "dropdown",
    "tooltip",
    "avatar",
    "badge",
    "spinner",
    "table",
    "pagination",
    "breadcrumb",
    "accordion",
    "carousel",
    "slider",
    "switch",
    "checkbox",
    "radio",
    "select",
    "textarea",
    "datepicker",
  ];
  const out: string[] = [];
  for (let pass = 0; pass < 10; pass++) {
    for (const name of names) {
      out.push(`PASS src/components/${name}/${name}.spec.ts`);
    }
  }
  out.push("FAIL src/api/client.spec.ts");
  out.push(
    "  ● ZebracornClient › fetches user › TypeError: cannot read property 'foo' of undefined",
  );
  out.push("    at ZebracornClient.fetchUser (src/api/client.ts:42:18)");
  return {
    text: out.join("\n"),
    distinctive: ["zebracornclient", "typeerror", "undefined"],
    boilerplate: ["pass", "spec", "src", "ts", "components"],
  };
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
