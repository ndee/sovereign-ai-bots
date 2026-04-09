import { describe, expect, it } from "vitest";

import { loadGolden } from "../__fixtures__/load.js";
import {
  buildMessageKey,
  compactText,
  createRegex,
  ensureTrailingSlash,
  extractDomain,
  matchGlob,
  normalizeEmailAddress,
  normalizeMessageId,
  normalizeThreadSubject,
  stripSingleTrailingNewline,
} from "./normalize.js";

describe("util/normalize", () => {
  it("matches the normalizeMessageId golden fixture", () => {
    const golden = loadGolden<Record<string, unknown>>("normalizeMessageId");
    expect({
      empty: normalizeMessageId(""),
      plain: normalizeMessageId("abc@example.com"),
      wrapped: normalizeMessageId("<ABC@Example.COM>"),
      trimmed: normalizeMessageId("  <abc@example.com>  "),
      noAt: normalizeMessageId("loose-id"),
      nonString: normalizeMessageId(42),
    }).toEqual(golden);
  });

  it("matches the normalizeEmailAddress golden fixture", () => {
    const golden = loadGolden<Record<string, unknown>>("normalizeEmailAddress");
    expect({
      simple: normalizeEmailAddress("Alice@Example.COM"),
      named: normalizeEmailAddress('"Alice" <Alice@Example.com>'),
      empty: normalizeEmailAddress(""),
      nonString: normalizeEmailAddress(undefined),
    }).toEqual(golden);
  });

  it("matches the extractDomain golden fixture", () => {
    const golden = loadGolden<Record<string, unknown>>("extractDomain");
    expect({
      plain: extractDomain("alice@example.com"),
      noAt: extractDomain("alice"),
      trailing: extractDomain("alice@"),
      uppercase: extractDomain("alice@Example.COM"),
      nonString: extractDomain(null),
    }).toEqual(golden);
  });

  it("matches the compactText golden fixture", () => {
    const golden = loadGolden<Record<string, unknown>>("compactText");
    expect({
      spaces: compactText("  hello   world  "),
      tabs: compactText("\thello\n\tworld\t"),
      undef: compactText(undefined),
      nullish: compactText(null),
    }).toEqual(golden);
  });

  it("matches the stripSingleTrailingNewline golden fixture", () => {
    const golden = loadGolden<Record<string, unknown>>("stripSingleTrailingNewline");
    expect({
      lf: stripSingleTrailingNewline("line\n"),
      crlf: stripSingleTrailingNewline("line\r\n"),
      none: stripSingleTrailingNewline("line"),
      double: stripSingleTrailingNewline("line\n\n"),
    }).toEqual(golden);
  });

  it("matches the ensureTrailingSlash golden fixture", () => {
    const golden = loadGolden<Record<string, unknown>>("ensureTrailingSlash");
    expect({
      none: ensureTrailingSlash("https://a.example"),
      already: ensureTrailingSlash("https://a.example/"),
    }).toEqual(golden);
  });

  it("matches the normalizeThreadSubject golden fixture", () => {
    const golden = loadGolden<Record<string, unknown>>("normalizeThreadSubject");
    expect({
      plain: normalizeThreadSubject("Meeting notes"),
      reprefix: normalizeThreadSubject("Re: Meeting notes"),
      aw: normalizeThreadSubject("AW: Meeting notes"),
      fwd: normalizeThreadSubject("Fwd: Meeting notes"),
      mixedCase: normalizeThreadSubject("  ReMix "),
      empty: normalizeThreadSubject(""),
    }).toEqual(golden);
  });

  it("matches the matchGlob golden fixture", () => {
    const golden = loadGolden<Record<string, unknown>>("matchGlob");
    expect({
      plain: matchGlob("alice@example.com", "alice@*"),
      caseInsensitive: matchGlob("Alice@Example.com", "alice@*.com"),
      no: matchGlob("bob@example.com", "alice@*"),
      nonString: matchGlob(42, "*"),
    }).toEqual(golden);
  });

  it("matches the buildMessageKey golden fixture", () => {
    const golden = loadGolden<Record<string, unknown>>("buildMessageKey");
    expect({
      withMessageId: buildMessageKey("<abc@ex>", 42),
      withoutMessageId: buildMessageKey(undefined, 99),
    }).toEqual(golden);
  });

  it("builds a regex with default flags when none are provided", () => {
    const regex = createRegex({ pattern: "hello" });
    expect(regex.test("HELLO WORLD")).toBe(true);
    expect(regex.flags).toBe("iu");
  });

  it("respects the flags override on createRegex", () => {
    const regex = createRegex({ pattern: "hello", flags: "g" });
    expect(regex.flags).toBe("g");
    expect(regex.test("Hello")).toBe(false);
    expect(regex.test("hello")).toBe(true);
  });

  it("normalizeThreadSubject handles nullish input", () => {
    expect(normalizeThreadSubject(null)).toBe("");
    expect(normalizeThreadSubject(undefined)).toBe("");
  });
});
