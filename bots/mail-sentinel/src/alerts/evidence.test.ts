import { describe, expect, it } from "vitest";
import {
  buildExcerpt,
  EXCERPT_MAX_CHARS,
  EXCERPT_MAX_LINES,
  formatSignalChip,
  SIGNAL_CHIP_LIMIT,
} from "./evidence.js";

describe("alerts/evidence buildExcerpt", () => {
  it("returns a compacted single-line snippet unchanged when within caps", () => {
    expect(buildExcerpt("Please pay $500 for invoice.")).toBe("Please pay $500 for invoice.");
  });

  it("collapses runs of internal whitespace within each line", () => {
    expect(buildExcerpt("Please   pay    now")).toBe("Please pay now");
  });

  it("returns undefined for a non-string snippet", () => {
    expect(buildExcerpt(undefined)).toBeUndefined();
    expect(buildExcerpt(null)).toBeUndefined();
    expect(buildExcerpt(42)).toBeUndefined();
  });

  it("returns undefined for an empty or whitespace-only snippet", () => {
    expect(buildExcerpt("")).toBeUndefined();
    expect(buildExcerpt("   \n  \t ")).toBeUndefined();
  });

  it("keeps up to the line cap, dropping blank lines, and marks truncation", () => {
    const snippet = Array.from({ length: EXCERPT_MAX_LINES + 3 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    const result = buildExcerpt(snippet) as string;
    expect(result.split("\n")).toHaveLength(EXCERPT_MAX_LINES);
    expect(result.endsWith("…")).toBe(true);
    expect(result.startsWith("line 1\nline 2")).toBe(true);
  });

  it("drops blank interior lines before applying the line cap", () => {
    const result = buildExcerpt("a\n\n\nb\n\nc") as string;
    expect(result).toBe("a\nb\nc");
    expect(result.endsWith("…")).toBe(false);
  });

  it("caps an overly long single line by characters with a trailing ellipsis", () => {
    const long = "x".repeat(EXCERPT_MAX_CHARS + 50);
    const result = buildExcerpt(long) as string;
    expect([...result]).toHaveLength(EXCERPT_MAX_CHARS);
    expect(result.endsWith("…")).toBe(true);
  });

  it("does not split a multi-byte codepoint when char-capping", () => {
    // Each emoji is a single codepoint but multiple UTF-16 units; spreading
    // counts codepoints so we never cut one in half.
    const emoji = "😀".repeat(EXCERPT_MAX_CHARS + 10);
    const result = buildExcerpt(emoji) as string;
    expect([...result]).toHaveLength(EXCERPT_MAX_CHARS);
    // The ellipsis is the final codepoint and the rest are whole emoji.
    expect([...result].slice(0, -1).every((cp) => cp === "😀")).toBe(true);
  });

  it("does not append an ellipsis when exactly at the char cap", () => {
    const exact = "y".repeat(EXCERPT_MAX_CHARS);
    const result = buildExcerpt(exact) as string;
    expect(result).toBe(exact);
    expect(result.endsWith("…")).toBe(false);
  });
});

describe("alerts/evidence formatSignalChip", () => {
  it("joins reasons with a middot separator", () => {
    expect(formatSignalChip(["deadline detected", "amount over threshold"])).toBe(
      "deadline detected · amount over threshold",
    );
  });

  it("returns undefined when reasons is not an array", () => {
    expect(formatSignalChip(undefined)).toBeUndefined();
  });

  it("returns undefined when there are no usable reasons", () => {
    expect(formatSignalChip([])).toBeUndefined();
    expect(formatSignalChip(["", "   "])).toBeUndefined();
  });

  it("compacts and de-duplicates reasons", () => {
    expect(formatSignalChip(["  spam  ", "spam", "urgent"])).toBe("spam · urgent");
  });

  it("caps at the default limit and adds a +N more suffix", () => {
    const chip = formatSignalChip(["a", "b", "c", "d", "e"]) as string;
    expect(chip).toBe("a · b · c · +2 more");
    expect(SIGNAL_CHIP_LIMIT).toBe(3);
  });

  it("honours a custom limit", () => {
    expect(formatSignalChip(["a", "b", "c"], 1)).toBe("a · +2 more");
  });

  it("omits the +N suffix when reasons fit within the limit", () => {
    expect(formatSignalChip(["a", "b"])).toBe("a · b");
  });
});
