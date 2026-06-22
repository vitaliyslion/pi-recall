import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bigOutput, NEEDLE } from "../helpers/fixtures.ts";
import {
  makeRecall,
  type RecallHarness,
  textOf,
} from "../helpers/recall-session.ts";
import { makeTempDirs, type TempDirs } from "../helpers/tmp.ts";

// These feed canned output through Pi's bash tool (mocked exec backend — no process spawned) and the
// REAL extension runner, so Pi's truncation, temp-file (fullOutputPath) and footer behavior are
// genuine — the footer regexes in src/index.ts are exercised against actual Pi output.
describe("capture hook (mocked bash, real runner)", () => {
  let dirs: TempDirs;
  let h: RecallHarness;
  beforeEach(async () => {
    dirs = await makeTempDirs();
    h = await makeRecall({
      cwd: dirs.cwd,
      config: { maxLines: 200, maxBytes: 5120 },
    });
  });
  afterEach(async () => {
    h.dispose();
    await dirs.cleanup();
  });

  it("registers the recall tool, recall-off flag and recall-status command", () => {
    expect(h.runner.getToolDefinition("recall")).toBeTruthy();
    expect([...h.runner.getFlagValues().keys()]).toContain("recall-off");
    expect(h.runner.getCommand("recall-status")).toBeTruthy();
  });

  it("passes small output through untouched", async () => {
    const res = await h.runBash("0001", "line a\nline b\nline c");
    expect(res).toBeUndefined();
  });

  it("captures moderate output inline (over our gate, under Pi's truncation) and hides the needle", async () => {
    // 500 lines: over pi-recall's gate but under Pi's 2000-line / 50KB truncation → inline path.
    const res = await h.runBash(
      "7f3a",
      bigOutput({ lines: 500, needleAt: 300 }),
    );
    const stub = textOf(res);
    expect(stub).toContain("pi-recall");
    expect(stub).toContain("exec:7f3a");
    expect(stub).not.toContain(NEEDLE);
    expect(stub).toMatch(/Searchable terms:/);
  });

  it("captures Pi-truncated output and reports the COMPLETE line count", async () => {
    // 3000 lines → Pi truncates and writes a temp file; pi-recall must read the whole thing back.
    const res = await h.runBash(
      "d00d",
      bigOutput({ lines: 3000, needleAt: 1500 }),
    );
    const stub = textOf(res);
    const lines = Number(/full output \((\d+) lines/.exec(stub)?.[1] ?? 0);
    expect(lines).toBeGreaterThanOrEqual(3000); // not Pi's kept tail
    const hit = await h.recall({ query: NEEDLE, source: "exec:d00d" });
    expect(hit).toContain(NEEDLE); // a line buried above Pi's tail is still recallable
  });

  it("handles a FAILED truncated command: strips Pi's footer/temp path, keeps the exit status", async () => {
    const res = await h.runBash(
      "f00d",
      bigOutput({ lines: 3000, needleAt: 200 }),
      {
        exitCode: 1,
      },
    );
    const stub = textOf(res);
    expect(stub).toContain("exec:f00d");
    expect(stub).not.toContain("Full output:"); // Pi's footer dropped
    expect(stub).not.toMatch(/\/tmp\/|pi-bash/); // Pi's temp path dropped
    expect(stub).toContain("Command exited with code 1"); // real status kept
    const lines = Number(/full output \((\d+) lines/.exec(stub)?.[1] ?? 0);
    expect(lines).toBeGreaterThanOrEqual(3000);
    const hit = await h.recall({ query: NEEDLE, source: "exec:f00d" });
    expect(hit).toContain(NEEDLE); // buried above Pi's kept tail
  });

  it("captures large error output too (the gate is size-only, not error-gated)", async () => {
    const res = await h.runBash(
      "e44d",
      bigOutput({ lines: 500, needleAt: 250 }),
      {
        exitCode: 1,
      },
    );
    const stub = textOf(res);
    expect(stub).toContain("exec:e44d");
    expect(stub).not.toContain(NEEDLE);
    const hit = await h.recall({ query: NEEDLE, source: "exec:e44d" });
    expect(hit).toContain(NEEDLE);
  });
});
