import { describe, expect, it } from "vitest";

import {
  compactText,
  computeHash,
  countMatchingPhrases,
  createExcerpt,
  decodeHtmlEntities,
  ensureTrailingSlash,
  formatConfidenceLabel,
  mergeUniqueStrings,
  normalizeComparable,
  normalizeTimestamp,
  nowIso,
  parseDurationMs,
  parseJsonSafely,
  parseRuntimeConfigDocument,
  resolveRelativeToBase,
  stripHtml,
  stripSingleTrailingNewline,
} from "./util.js";

describe("project-sentinel/util", () => {
  it("normalizes common text helpers", () => {
    expect(compactText(undefined)).toBe("");
    expect(compactText("  hello\nworld  ")).toBe("hello world");
    expect(stripSingleTrailingNewline("line\n")).toBe("line");
    expect(ensureTrailingSlash("https://example.com")).toBe("https://example.com/");
    expect(ensureTrailingSlash("https://example.com/")).toBe("https://example.com/");
    expect(resolveRelativeToBase("data/state.json", "/opt/project")).toBe(
      "/opt/project/data/state.json",
    );
    expect(resolveRelativeToBase("/var/state.json", "/opt/project")).toBe("/var/state.json");
    expect(normalizeComparable("  Matrix FEDERATION ")).toBe("matrix federation");
  });

  it("parses JSON and JSON-like runtime config safely", () => {
    expect(parseJsonSafely('{"ok":true}\n')).toEqual({ ok: true });
    expect(parseJsonSafely("not-json")).toBeNull();
    expect(parseRuntimeConfigDocument('{"count":2}')).toEqual({ count: 2 });
    expect(parseRuntimeConfigDocument("{ count: 2, nested: { ok: true } }")).toEqual({
      count: 2,
      nested: { ok: true },
    });
  });

  it("handles timestamps and durations", () => {
    expect(normalizeTimestamp("Fri, 17 Apr 2026 10:28:32 +0000")).toBe("2026-04-17T10:28:32.000Z");
    expect(normalizeTimestamp(undefined)).toBeUndefined();
    expect(normalizeTimestamp("nope")).toBeUndefined();
    expect(parseDurationMs("30m")).toBe(30 * 60 * 1000);
    expect(parseDurationMs("2h")).toBe(2 * 60 * 60 * 1000);
    expect(parseDurationMs("3days")).toBe(3 * 24 * 60 * 60 * 1000);
    expect(() => parseDurationMs("5s")).toThrow("Unsupported duration");
    expect(new Date(nowIso()).toISOString()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("formats confidence bands and counts phrase matches", () => {
    expect(formatConfidenceLabel(undefined)).toBe("unknown");
    expect(formatConfidenceLabel(80)).toBe("high (80%)");
    expect(formatConfidenceLabel(50)).toBe("medium (50%)");
    expect(formatConfidenceLabel(20)).toBe("low (20%)");
    expect(
      countMatchingPhrases("Matrix federation and OpenClaw gateway", [
        "matrix",
        "openclaw",
        "matrix",
      ]),
    ).toBe(2);
  });

  it("merges unique strings and normalizes HTML content", () => {
    expect(
      mergeUniqueStrings(
        ["matrix", "", "matrix", 7 as unknown as string],
        ["openclaw", " matrix "],
      ),
    ).toEqual(["matrix", "openclaw"]);
    expect(decodeHtmlEntities("Fish &amp; Chips &#x26; &#38;")).toBe("Fish & Chips & &");
    expect(stripHtml("<p>Hello <strong>world</strong></p>")).toBe("Hello world");
    expect(createExcerpt("<p>Hello world</p>", 20)).toBe("Hello world");
    expect(createExcerpt("a".repeat(30), 10)).toBe("aaaaaaaaa...");
    expect(createExcerpt(undefined, 10)).toBe("");
    expect(computeHash("same-input")).toHaveLength(16);
    expect(countMatchingPhrases("Matrix", [""])).toBe(0);
    expect(mergeUniqueStrings(undefined, ["matrix"])).toEqual(["matrix"]);
  });
});
