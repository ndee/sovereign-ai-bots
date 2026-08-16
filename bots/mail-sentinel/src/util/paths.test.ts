import { describe, expect, it } from "vitest";

import { loadGolden } from "../__fixtures__/load.js";
import {
  parseJsonAfterPreamble,
  parseJsonSafely,
  parseRuntimeConfigDocument,
  resolveRelativeToBase,
} from "./paths.js";

// Verbatim stdout captured from `/bin/sh -lc` on Raspberry Pi OS, where
// /etc/profile.d/wifi-check.sh prints the rfkill notice to stdout (gettext -s)
// ahead of the real pipeline output.
const RFKILL_BANNER =
  "\nWi-Fi is currently blocked by rfkill.\nUse raspi-config to set the country before use.\n\n";

describe("util/paths", () => {
  it("matches the parseJsonSafely golden fixture", () => {
    const golden = loadGolden<Record<string, unknown>>("parseJsonSafely");
    expect({
      valid: parseJsonSafely('{"a":1}\n'),
      invalid: parseJsonSafely("not json"),
    }).toEqual(golden);
  });

  it("parses clean JSON unchanged", () => {
    expect(parseJsonAfterPreamble('{"a":1}\n')).toEqual({ a: 1 });
    expect(parseJsonAfterPreamble('[{"a":1}]\n')).toEqual([{ a: 1 }]);
  });

  it("recovers an object payload printed after a login-shell banner", () => {
    expect(
      parseJsonAfterPreamble(`${RFKILL_BANNER}{"suggested_zone":"red","confidence":88}\n`),
    ).toEqual({ suggested_zone: "red", confidence: 88 });
  });

  it("recovers an array payload printed after a login-shell banner", () => {
    expect(parseJsonAfterPreamble(`${RFKILL_BANNER}[{"output":{"text":"hi"}}]`)).toEqual([
      { output: { text: "hi" } },
    ]);
  });

  it("recovers JSON wrapped in a markdown code fence", () => {
    expect(parseJsonAfterPreamble('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  // The lobster pipeline emits a top-level array, so the array branch of the
  // trailing-noise scan needs the same guarantee as the object branch.
  it("recovers an array payload with both a preamble and trailing noise", () => {
    expect(parseJsonAfterPreamble(`${RFKILL_BANNER}[{"a":1}]\ndone.`)).toEqual([{ a: 1 }]);
  });

  it("returns null when there is no JSON at all", () => {
    expect(parseJsonAfterPreamble(RFKILL_BANNER)).toBeNull();
    expect(parseJsonAfterPreamble("")).toBeNull();
  });

  it("returns null when the payload after the preamble is malformed", () => {
    expect(parseJsonAfterPreamble(`${RFKILL_BANNER}{"a": `)).toBeNull();
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
