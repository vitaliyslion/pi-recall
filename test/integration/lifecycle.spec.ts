import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bigOutput, NEEDLE } from "../helpers/fixtures.ts";
import { makeRecall, type RecallHarness } from "../helpers/recall-session.ts";
import { makeTempDirs, type TempDirs } from "../helpers/tmp.ts";

describe("session lifecycle", () => {
  let dirs: TempDirs;
  const harnesses: RecallHarness[] = [];
  beforeEach(async () => {
    dirs = await makeTempDirs();
    harnesses.length = 0;
  });
  afterEach(async () => {
    for (const h of harnesses) h.dispose();
    await dirs.cleanup();
  });

  it("persists on shutdown and restores into a fresh session (V2 round-trip)", async () => {
    const sessionId = "round-trip-1";
    const a = await makeRecall({ cwd: dirs.cwd, sessionId });
    harnesses.push(a);
    await a.runBash("7f3a", bigOutput({ lines: 500, needleAt: 300 }));
    await a.shutdown("quit");

    const b = await makeRecall({ cwd: dirs.cwd, sessionId, autoStart: false });
    harnesses.push(b);
    await b.start("resume");
    expect(b.ui.notified("restored")).toBe(true);
    expect(await b.recall({ query: NEEDLE, source: "exec:7f3a" })).toContain(
      NEEDLE,
    );
  });

  it("--recall-off passes everything through and reports off in the status line", async () => {
    const h = await makeRecall({ cwd: dirs.cwd, autoStart: false });
    harnesses.push(h);
    h.runner.setFlagValue("recall-off", true);
    await h.start("startup");
    const res = await h.runBash(
      "abcd",
      bigOutput({ lines: 500, needleAt: 300 }),
    );
    expect(res).toBeUndefined();
    expect(h.ui.statuses["pi-recall"]).toMatch(/off/);
  });

  it("/recall-status reports effective config and index stats", async () => {
    const h = await makeRecall({ cwd: dirs.cwd });
    harnesses.push(h);
    await h.runBash("7f3a", bigOutput({ lines: 500, needleAt: 300 }));
    await h.runCommand("recall-status");
    const msg = h.ui.notifications.map((n) => n.message).join("\n");
    expect(msg).toContain("pi-recall status");
    expect(msg).toMatch(/captures:\s+1/);
  });
});
