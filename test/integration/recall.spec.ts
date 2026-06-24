import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bigOutput, NEEDLE, repeatedLineOutput } from "../helpers/fixtures.ts";
import {
  makeRecall,
  type RecallHarness,
  sourceOf,
} from "../helpers/recall-session.ts";
import { makeTempDirs, type TempDirs } from "../helpers/tmp.ts";

describe("recall tool", () => {
  let dirs: TempDirs;
  let h: RecallHarness;
  let source: string;
  beforeEach(async () => {
    dirs = await makeTempDirs();
    h = await makeRecall({ cwd: dirs.cwd });
    const res = await h.runBash(
      "7f3a",
      bigOutput({ lines: 500, needleAt: 300 }),
      { command: "bash ./run-build.sh" },
    );
    source = sourceOf(res);
  });
  afterEach(async () => {
    h.dispose();
    await dirs.cleanup();
  });

  it("retrieves the buried needle, citing source, line and originating command", async () => {
    const text = await h.recall({ query: NEEDLE, source });
    expect(text).toContain(NEEDLE);
    expect(text).toMatch(new RegExp(`${source} @ line \\d+`));
    expect(text).toContain("run-build.sh"); // the command that produced the output is echoed back
  });

  it("scopes results to a single capture by source id", async () => {
    const other = sourceOf(
      await h.runBash("aaaa", bigOutput({ lines: 500, needleAt: 50 })), // also contains the needle
    );
    const scoped = await h.recall({ query: NEEDLE, source });
    expect(scoped).toContain(source);
    expect(scoped).not.toContain(other);
  });

  it("reports no matches cleanly", async () => {
    const text = await h.recall({ query: "absolutelynosuchtoken" });
    expect(text).toContain("no matches");
  });

  it("batches identical hits found on multiple lines into one block", async () => {
    // A fresh capture chunked one-line-per-doc, so the repeated line becomes several identical hits.
    const dirs2 = await makeTempDirs();
    const h2 = await makeRecall({ cwd: dirs2.cwd, config: { chunkLines: 1 } });
    try {
      const { text: out, at } = repeatedLineOutput({
        lines: 500,
        at: [10, 12, 25, 40],
      });
      const src = sourceOf(await h2.runBash("dupe", out));
      const text = await h2.recall({ query: NEEDLE, source: src, limit: 10 });
      // One header for all occurrences, not four separate blocks.
      expect(text.split("---")).toHaveLength(1);
      // First three lines listed, the rest summarized as "...N more".
      expect(text).toContain(`@ lines ${at[0]}, ${at[1]}, ${at[2]}, ...1 more`);
      // The duplicated body appears once.
      expect(text.match(new RegExp(NEEDLE, "g"))?.length).toBe(1);
    } finally {
      h2.dispose();
      await dirs2.cleanup();
    }
  });

  it("groups over the full match set so repeats don't crowd out distinct matches under a small limit", async () => {
    // The repeated line appears far more often than `limit`. If batching ran AFTER the search limit,
    // those repeats would fill the budget — hiding the distinct matches and undercounting occurrences.
    const dirs2 = await makeTempDirs();
    const h2 = await makeRecall({ cwd: dirs2.cwd, config: { chunkLines: 1 } });
    try {
      const lines: string[] = [];
      for (let i = 0; i < 8; i++)
        lines.push(`config ${NEEDLE} eviction policy mismatch`);
      lines.push(`${NEEDLE} distinct-alpha marker`);
      lines.push(`${NEEDLE} distinct-beta marker`);
      // Pad past the capture gate so the output is indexed rather than passed through untouched.
      for (let i = 0; i < 500; i++) lines.push(`filler log entry ${i} ok`);
      const src = sourceOf(await h2.runBash("crowd", lines.join("\n")));
      const text = await h2.recall({ query: NEEDLE, source: src, limit: 3 });
      // The repeated block reports every occurrence, even though 8 > limit.
      expect(text).toContain("...5 more");
      // The distinct matches survive instead of being crowded out by the repeats.
      expect(text).toContain("distinct-alpha");
      expect(text).toContain("distinct-beta");
    } finally {
      h2.dispose();
      await dirs2.cleanup();
    }
  });
});
