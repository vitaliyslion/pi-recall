import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bigOutput, NEEDLE } from "../helpers/fixtures.ts";
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
});
