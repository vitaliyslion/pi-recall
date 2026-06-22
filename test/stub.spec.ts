import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type RecallConfig } from "../src/config.ts";
import { RecallStore } from "../src/store.ts";
import { computeTail, formatStub } from "../src/stub.ts";
import { bigOutput, NEEDLE } from "./helpers/fixtures.ts";

// formatStub indexes via a real in-memory RecallStore (no disk) so its searchable terms come from
// the same tokenizer the index uses — exactly the production flow (store.add then formatStub).
async function stubFor(
  full: string,
  cfg: RecallConfig = DEFAULT_CONFIG,
  source = "exec:7f3a",
): Promise<string> {
  const store = new RecallStore(cfg);
  await store.add(source, full, "bash ./run-build.sh");
  const tail = computeTail(full, cfg.tailLines);
  const totalLines = full.split("\n").length;
  return formatStub({ full, source, tail, totalLines, store, cfg });
}

describe("formatStub", () => {
  it("carries the marker, source id and complete line count", async () => {
    const full = bigOutput();
    const text = await stubFor(full);
    expect(text).toContain("pi-recall");
    expect(text).toContain("exec:7f3a");
    expect(text).toContain(`full output (${full.split("\n").length} lines`);
  });

  it("hides the buried needle while surfacing terms and a notable highlight", async () => {
    const text = await stubFor(bigOutput());
    expect(text).not.toContain(NEEDLE); // indexed, not shown
    expect(text).toMatch(/Searchable terms:/);
    expect(text).toMatch(/Notable:/);
  });

  it("shows the configured tail at the top of the stub", async () => {
    const full = bigOutput({ lines: 100, needleAt: 10 });
    const cfg = { ...DEFAULT_CONFIG, tailLines: 5 };
    const text = await stubFor(full, cfg);
    expect(text).toContain("Showing the last 5 lines");
    expect(text.startsWith(full.split("\n").slice(-5).join("\n"))).toBe(true);
  });

  it("omits the Notable/Searchable sections when disabled", async () => {
    const cfg = { ...DEFAULT_CONFIG, stubHighlights: 0, stubTerms: 0 };
    const text = await stubFor("just\nsome\nplain\nlines\nhere", cfg);
    expect(text).not.toMatch(/Notable:/);
    expect(text).not.toMatch(/Searchable terms:/);
  });
});

describe("computeTail", () => {
  it("returns the last N lines, or all of them when fewer exist", () => {
    expect(computeTail("a\nb\nc\nd", 2)).toBe("c\nd");
    expect(computeTail("a\nb", 5)).toBe("a\nb");
  });
});
