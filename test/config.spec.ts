import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, overGate } from "../src/config.ts";
import { makeTempDirs, type TempDirs } from "./helpers/tmp.ts";

describe("loadConfig (default < global < project)", () => {
  let dirs: TempDirs;
  beforeEach(async () => {
    dirs = await makeTempDirs();
  });
  afterEach(() => dirs.cleanup());

  async function writeGlobal(obj: Record<string, unknown>) {
    await mkdir(join(dirs.agentDir, "extensions"), { recursive: true });
    await writeFile(
      join(dirs.agentDir, "extensions", "pi-recall.json"),
      JSON.stringify(obj),
    );
  }
  async function writeProject(obj: Record<string, unknown>) {
    await mkdir(join(dirs.cwd, ".pi"), { recursive: true });
    await writeFile(
      join(dirs.cwd, ".pi", "pi-recall.json"),
      JSON.stringify(obj),
    );
  }

  it("falls back to defaults when no config files exist", () => {
    expect(loadConfig(dirs.cwd)).toEqual(DEFAULT_CONFIG);
  });

  it("layers project over global over defaults", async () => {
    await writeGlobal({ maxLines: 111, maxBytes: 1111 });
    await writeProject({ maxLines: 222 });
    const cfg = loadConfig(dirs.cwd);
    expect(cfg.maxLines).toBe(222); // project wins
    expect(cfg.maxBytes).toBe(1111); // inherited from global
    expect(cfg.persist).toBe(DEFAULT_CONFIG.persist); // untouched default
  });

  it("ignores unknown keys", async () => {
    await writeProject({ booboo: 1, maxLines: 50 });
    const cfg = loadConfig(dirs.cwd);
    expect(cfg.maxLines).toBe(50);
    expect("booboo" in cfg).toBe(false);
  });

  it("warns and falls back to defaults on invalid JSON", async () => {
    await mkdir(join(dirs.cwd, ".pi"), { recursive: true });
    await writeFile(join(dirs.cwd, ".pi", "pi-recall.json"), "{not json");
    const warnings: string[] = [];
    const cfg = loadConfig(dirs.cwd, (m) => warnings.push(m));
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(warnings.some((w) => w.includes("invalid config"))).toBe(true);
  });
});

describe("overGate", () => {
  it("triggers when the line count exceeds maxLines", () => {
    const cfg = { ...DEFAULT_CONFIG, maxLines: 3, maxBytes: 1_000_000 };
    expect(overGate("a\nb\nc", cfg)).toBe(false); // exactly 3 lines
    expect(overGate("a\nb\nc\nd", cfg)).toBe(true); // 4 lines
  });

  it("triggers when the byte size exceeds maxBytes", () => {
    const cfg = { ...DEFAULT_CONFIG, maxLines: 1_000_000, maxBytes: 4 };
    expect(overGate("abcd", cfg)).toBe(false); // exactly 4 bytes
    expect(overGate("abcde", cfg)).toBe(true); // 5 bytes
  });
});
