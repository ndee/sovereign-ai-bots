import { describe, expect, it } from "vitest";

import { joinLines, printOutput } from "./format.js";

describe("wealth-alignment/format", () => {
  it("joins lines, dropping undefined entries", () => {
    expect(joinLines(["a", undefined, "b"])).toBe("a\nb");
  });

  it("prints JSON or formatted text", () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      printOutput({ a: 1 }, { json: true }, () => "ignored");
      printOutput({ a: 1 }, { json: false }, (value) => `value=${String(value.a)}`);
    } finally {
      process.stdout.write = original;
    }
    expect(chunks[0]).toContain('"a": 1');
    expect(chunks[1]).toContain("value=1");
  });
});
