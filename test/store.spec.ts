import { utimes } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { RecallStore } from "../src/store.ts";
import { bigOutput, NEEDLE } from "./helpers/fixtures.ts";
import { makeTempDirs, type TempDirs } from "./helpers/tmp.ts";

describe("RecallStore", () => {
  let dirs: TempDirs;
  beforeEach(async () => {
    dirs = await makeTempDirs();
  });
  afterEach(() => dirs.cleanup());

  it("indexes and retrieves a buried needle via BM25", async () => {
    const store = new RecallStore(DEFAULT_CONFIG);
    await store.add("exec:a", bigOutput(), "cmd a");
    const r = await store.search(NEEDLE);
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0].document.text).toContain(NEEDLE);
  });

  it("scopes search to a single capture via the enum source", async () => {
    const store = new RecallStore(DEFAULT_CONFIG);
    await store.add("exec:a", bigOutput({ needleAt: 100 }), "cmd a");
    await store.add("exec:b", "nothing interesting here\nplain text", "cmd b");
    expect((await store.search(NEEDLE, "exec:a")).hits.length).toBeGreaterThan(
      0,
    );
    expect((await store.search(NEEDLE, "exec:b")).hits.length).toBe(0);
  });

  it("reports zero hits for a missing term", async () => {
    const store = new RecallStore(DEFAULT_CONFIG);
    await store.add("exec:a", bigOutput(), "cmd a");
    expect((await store.search("absolutelynosuchtoken")).hits.length).toBe(0);
  });

  it("tracks capture count, chunk count and the command mapping", async () => {
    const store = new RecallStore({ ...DEFAULT_CONFIG, chunkLines: 20 });
    const chunks = await store.add(
      "exec:a",
      bigOutput({ lines: 100 }),
      "bash ./x.sh",
    );
    expect(chunks).toBe(5); // 100 lines / 20 per chunk
    expect(store.captureCount).toBe(1);
    expect(await store.docCount()).toBe(5);
    expect(store.commandFor("exec:a")).toBe("bash ./x.sh");
  });

  it("tokenizes via Orama and tallies occurrences", async () => {
    const store = new RecallStore(DEFAULT_CONFIG);
    await store.add("exec:a", "hello world hello\nplain", "cmd");
    const [helloTok] = store.tokenize("hello");
    expect(store.tokenize("hello world")).toContain(helloTok);
    expect(store.tokenOccurrences()[helloTok]).toBeGreaterThan(0);
  });

  it("persists a snapshot and restores it into a fresh store (V2 round-trip)", async () => {
    const a = new RecallStore(DEFAULT_CONFIG);
    await a.restore("sess-1"); // binds the session id; no snapshot yet
    await a.add("exec:a", bigOutput(), "cmd a");
    const path = await a.persist();
    expect(path).not.toBeNull();
    // Guard the redirect: the snapshot must land under the temp agent dir, never the real ~/.pi.
    expect(path?.startsWith(dirs.agentDir)).toBe(true);
    expect(await a.snapshotSize()).toBeGreaterThan(0);

    const b = new RecallStore(DEFAULT_CONFIG);
    expect(await b.restore("sess-1")).toBe(true);
    expect((await b.search(NEEDLE, "exec:a")).hits[0]?.document.text).toContain(
      NEEDLE,
    );
  });

  it("persists the savedTokens counter and restores it into a fresh store", async () => {
    const a = new RecallStore(DEFAULT_CONFIG);
    await a.restore("sess-tok"); // no sidecar yet → counter stays 0
    expect(a.savedTokens).toBe(0);
    a.savedTokens += 4096;
    await a.persist();

    const b = new RecallStore(DEFAULT_CONFIG);
    await b.restore("sess-tok");
    expect(b.savedTokens).toBe(4096);
  });

  it("mints a 5-char git-style source id decoupled from the long provider id", () => {
    const store = new RecallStore(DEFAULT_CONFIG);
    const src = store.shortSource("toolu_01AbcdefghijklmnopqrstuV");
    expect(src).toMatch(/^exec:[0-9a-f]{5}$/);
    // Deterministic: same tool-call id always hashes to the same short id.
    expect(store.shortSource("toolu_01AbcdefghijklmnopqrstuV")).toBe(src);
    // Two providers' ids that share a long constant prefix still get distinct ids.
    expect(store.shortSource("call_xyz")).not.toBe(src);
  });

  it("lengthens the source id by one on collision (git-style)", async () => {
    const store = new RecallStore(DEFAULT_CONFIG);
    const id = "toolu_collide";
    const first = store.shortSource(id);
    // Key it, then ask again with the SAME id → 5-char prefix is taken, so it grows to 6.
    await store.add(first, "x\ny", "cmd");
    const second = store.shortSource(id);
    expect(second.length).toBe(first.length + 1);
    expect(second.startsWith(first)).toBe(true);
  });

  it("evicts snapshots older than the TTL", async () => {
    const store = new RecallStore({ ...DEFAULT_CONFIG, snapshotTtlDays: 7 });
    await store.restore("old-sess");
    await store.add("exec:a", "x\ny", "cmd");
    const path = await store.persist();
    const eightDaysAgo = Date.now() / 1000 - 8 * 24 * 60 * 60;
    await utimes(path as string, eightDaysAgo, eightDaysAgo);
    expect(await store.evictStale()).toBeGreaterThanOrEqual(1);
  });
});
