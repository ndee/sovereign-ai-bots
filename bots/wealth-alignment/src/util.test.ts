import { describe, expect, it } from "vitest";

import {
  compactText,
  currentYearMonth,
  dedupeStrings,
  formatAmount,
  isYearMonth,
  nowIso,
  previousYearMonth,
  resolveRelativeToBase,
  round2,
  stripSingleTrailingNewline,
  sumAmounts,
  yearMonthOf,
} from "./util.js";

describe("wealth-alignment/util", () => {
  it("compacts text", () => {
    expect(compactText("  hello  world  ")).toBe("hello world");
    expect(compactText(undefined)).toBe("");
  });

  it("strips single trailing newline", () => {
    expect(stripSingleTrailingNewline("abc\n")).toBe("abc");
    expect(stripSingleTrailingNewline("abc\r\n")).toBe("abc");
    expect(stripSingleTrailingNewline("abc")).toBe("abc");
  });

  it("resolves relative paths to a base", () => {
    expect(resolveRelativeToBase("/abs/path", "/base")).toBe("/abs/path");
    expect(resolveRelativeToBase("file.txt", "/base")).toBe("/base/file.txt");
  });

  it("returns ISO timestamps", () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("validates and computes year-months", () => {
    expect(isYearMonth("2026-04")).toBe(true);
    expect(isYearMonth("2026-13")).toBe(false);
    expect(isYearMonth("not-a-month")).toBe(false);
    expect(currentYearMonth(new Date(Date.UTC(2026, 0, 5)))).toBe("2026-01");
    expect(currentYearMonth(new Date(Date.UTC(2026, 11, 5)))).toBe("2026-12");
    expect(yearMonthOf("2026-04-15")).toBe("2026-04");
    expect(yearMonthOf("not-a-date")).toBeUndefined();
    expect(previousYearMonth("2026-01")).toBe("2025-12");
    expect(previousYearMonth("2026-04")).toBe("2026-03");
  });

  it("formats amounts and rounds", () => {
    expect(formatAmount(1234.5, "EUR")).toBe("EUR 1234.50");
    expect(formatAmount(-50, "EUR")).toBe("-EUR 50.00");
    expect(round2(1.005)).toBeGreaterThan(0);
    expect(sumAmounts([1.1, 2.2, 3.3])).toBe(6.6);
  });

  it("dedupes strings preserving order", () => {
    expect(dedupeStrings(["a", "b", "a", "c"])).toEqual(["a", "b", "c"]);
  });
});
