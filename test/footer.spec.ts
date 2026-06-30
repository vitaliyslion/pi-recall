import { describe, expect, it } from "vitest";
import { estimateTokens, fmtTokens, footerStatus } from "../src/footer.ts";

describe("estimateTokens", () => {
  it("is the chars/4 heuristic, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1); // 4 chars
    expect(estimateTokens("abcde")).toBe(2); // 5 chars → ceil(1.25)
    expect(estimateTokens("a".repeat(4000))).toBe(1000);
  });
});

describe("fmtTokens", () => {
  it("shows counts under 1000 verbatim", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
  });
  it("humanizes thousands with one decimal", () => {
    expect(fmtTokens(1000)).toBe("1.0K");
    expect(fmtTokens(12_345)).toBe("12.3K");
    expect(fmtTokens(999_999)).toBe("1000.0K");
  });
  it("humanizes millions with one decimal", () => {
    expect(fmtTokens(1_000_000)).toBe("1.0M");
    expect(fmtTokens(2_500_000)).toBe("2.5M");
  });
});

describe("footerStatus", () => {
  it("shows a tick and the humanized savings when active", () => {
    expect(footerStatus({ active: true, savedTokens: 0 })).toBe(
      "pi-recall: ✓ 0",
    );
    expect(footerStatus({ active: true, savedTokens: 12_345 })).toBe(
      "pi-recall: ✓ 12.3K",
    );
  });
  it("shows a bare cross when inactive, regardless of savings", () => {
    expect(footerStatus({ active: false, savedTokens: 0 })).toBe(
      "pi-recall: ✗",
    );
    expect(footerStatus({ active: false, savedTokens: 99_999 })).toBe(
      "pi-recall: ✗",
    );
  });
});
