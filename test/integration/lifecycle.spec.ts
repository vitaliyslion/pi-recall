import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bigOutput, NEEDLE } from "../helpers/fixtures.ts";
import {
  makeRecall,
  type RecallHarness,
  sourceOf,
} from "../helpers/recall-session.ts";
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
    const res = await a.runBash(
      "7f3a",
      bigOutput({ lines: 500, needleAt: 300 }),
    );
    const source = sourceOf(res);
    await a.shutdown("quit");

    const b = await makeRecall({ cwd: dirs.cwd, sessionId, autoStart: false });
    harnesses.push(b);
    await b.start("resume");
    expect(b.ui.notified("restored")).toBe(true);
    expect(await b.recall({ query: NEEDLE, source })).toContain(NEEDLE);
  });

  it("--recall-off passes everything through and shows a cross in the status line", async () => {
    const h = await makeRecall({ cwd: dirs.cwd, autoStart: false });
    harnesses.push(h);
    h.runner.setFlagValue("recall-off", true);
    await h.start("startup");
    const res = await h.runBash(
      "abcd",
      bigOutput({ lines: 500, needleAt: 300 }),
    );
    expect(res).toBeUndefined();
    expect(h.ui.statuses["pi-recall"]).toBe("pi-recall: ✗");
  });

  it("disabled via config shows a cross in the status line", async () => {
    const h = await makeRecall({ cwd: dirs.cwd, config: { enabled: false } });
    harnesses.push(h);
    expect(h.ui.statuses["pi-recall"]).toBe("pi-recall: ✗");
  });

  it("starts idle at zero, then the footer grows with captured savings", async () => {
    const h = await makeRecall({ cwd: dirs.cwd });
    harnesses.push(h);
    // session_start sets the footer before any capture.
    expect(h.ui.statuses["pi-recall"]).toBe("pi-recall: ✓ 0");

    await h.runBash("7f3a", bigOutput({ lines: 500, needleAt: 300 }));
    // A big output well over the gate yields a humanized (K-scale) savings count.
    expect(h.ui.statuses["pi-recall"]).toMatch(/^pi-recall: ✓ \d+\.\dK$/);
  });

  it("a below-gate output leaves the savings footer unchanged", async () => {
    const h = await makeRecall({ cwd: dirs.cwd });
    harnesses.push(h);
    const res = await h.runBash("aaaa", "tiny output\nsecond line");
    expect(res).toBeUndefined(); // passed through, nothing captured
    expect(h.ui.statuses["pi-recall"]).toBe("pi-recall: ✓ 0");
  });

  it("restores the accumulated savings footer on resume", async () => {
    const sessionId = "savings-resume-1";
    const a = await makeRecall({ cwd: dirs.cwd, sessionId });
    harnesses.push(a);
    await a.runBash("7f3a", bigOutput({ lines: 500, needleAt: 300 }));
    const footerBefore = a.ui.statuses["pi-recall"];
    expect(footerBefore).toMatch(/^pi-recall: ✓ \d+\.\dK$/);
    await a.shutdown("quit");

    const b = await makeRecall({ cwd: dirs.cwd, sessionId, autoStart: false });
    harnesses.push(b);
    await b.start("resume");
    // The footer comes back with the prior total, not reset to ✓ 0.
    expect(b.ui.statuses["pi-recall"]).toBe(footerBefore);
  });

  it("/recall-status reports effective config and index stats", async () => {
    const h = await makeRecall({ cwd: dirs.cwd });
    harnesses.push(h);
    await h.runBash("7f3a", bigOutput({ lines: 500, needleAt: 300 }));
    await h.runCommand("recall-status");
    const msg = h.ui.notifications.map((n) => n.message).join("\n");
    expect(msg).toContain("pi-recall status");
    expect(msg).toMatch(/captures:\s+1/);
    // The capture recorded a positive token-savings total.
    expect(msg).toMatch(/tokens saved:\s+[1-9]\d*/);
  });
});
