import { describe, expect, it } from "vitest";

import { loadGolden } from "../__fixtures__/load.js";
import { parseJsonSafely, parseRuntimeConfigDocument, resolveRelativeToBase } from "./paths.js";

describe("util/paths", () => {
  it("matches the parseJsonSafely golden fixture", () => {
    const golden = loadGolden<Record<string, unknown>>("parseJsonSafely");
    expect({
      valid: parseJsonSafely('{"a":1}\n'),
      invalid: parseJsonSafely("not json"),
    }).toEqual(golden);
  });

  it("resolves a relative path against the provided base", () => {
    expect(resolveRelativeToBase("data/state.json", "/opt/mail")).toBe("/opt/mail/data/state.json");
  });

  it("leaves an absolute path untouched", () => {
    expect(resolveRelativeToBase("/var/state.json", "/opt/mail")).toBe("/var/state.json");
  });

  it("parses strict JSON via JSON.parse first", () => {
    expect(parseRuntimeConfigDocument('{"a": 1, "b": "hi"}')).toEqual({ a: 1, b: "hi" });
  });

  it("falls back to JS expression evaluation for JSON5-style trailing commas", () => {
    const parsed = parseRuntimeConfigDocument('{ a: 1, b: "hi", }') as { a: number; b: string };
    expect(parsed).toEqual({ a: 1, b: "hi" });
  });
});
