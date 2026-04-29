import { describe, expect, it } from "vitest";

import {
  clampScore,
  compactText,
  ensureNonEmptyString,
  nowIso,
  parseRuntimeConfigDocument,
  resolveRelativeToBase,
  slugify,
  stripSingleTrailingNewline,
} from "./util.js";

describe("reality-alignment/util", () => {
  it("strips a single trailing newline", () => {
    expect(stripSingleTrailingNewline("hello\n")).toBe("hello");
    expect(stripSingleTrailingNewline("hello\r\n")).toBe("hello");
    expect(stripSingleTrailingNewline("hello")).toBe("hello");
  });

  it("resolves paths relative to a base directory", () => {
    expect(resolveRelativeToBase("/etc/abs", "/tmp")).toBe("/etc/abs");
    expect(resolveRelativeToBase("data/file.json", "/var/work")).toBe("/var/work/data/file.json");
  });

  it("parses runtime config documents in JSON or JSON5 form", () => {
    expect(parseRuntimeConfigDocument('{"a": 1}')).toEqual({ a: 1 });
    expect(parseRuntimeConfigDocument("{ a: 2 }")).toEqual({ a: 2 });
  });

  it("returns ISO timestamps", () => {
    const value = nowIso();
    expect(new Date(value).toISOString()).toBe(value);
  });

  it("compacts whitespace and trims null/undefined", () => {
    expect(compactText("  hello   world\n\t!  ")).toBe("hello world !");
    expect(compactText(null)).toBe("");
    expect(compactText(undefined)).toBe("");
  });

  it("slugifies titles and clamps length", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("---a---b---")).toBe("a-b");
    expect(slugify("x".repeat(200)).length).toBe(64);
  });

  it("clamps scores into the 1-5 integer range", () => {
    expect(clampScore(1)).toBe(1);
    expect(clampScore(5)).toBe(5);
    expect(clampScore("3")).toBe(3);
    expect(clampScore(2.4)).toBe(2);
    expect(() => clampScore(0)).toThrow("Expected a score between 1 and 5");
    expect(() => clampScore(6)).toThrow("Expected a score between 1 and 5");
    expect(() => clampScore("abc")).toThrow("Expected a numeric score between 1 and 5");
  });

  it("validates non-empty strings", () => {
    expect(ensureNonEmptyString("  hi  ", "x")).toBe("hi");
    expect(() => ensureNonEmptyString("   ", "title")).toThrow(
      "Expected a non-empty value for title",
    );
    expect(() => ensureNonEmptyString(undefined, "title")).toThrow(
      "Expected a non-empty value for title",
    );
  });
});
