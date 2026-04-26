import { describe, expect, it } from "vitest";

import { parseArgs } from "./args.js";

describe("wealth-alignment/args", () => {
  it("parses all keyed options", () => {
    const result = parseArgs([
      "import",
      "--instance",
      "wealth-alignment-core",
      "--config-path",
      "/tmp/c.json",
      "--id",
      "doc-1",
      "--path",
      "file.txt",
      "--kind",
      "bank_statement",
      "--month",
      "2026-04",
      "--currency",
      "USD",
      "--institution",
      "Example",
      "--notes",
      "test",
      "--json",
    ]);
    expect(result.command).toBe("import");
    expect(result.options).toEqual({
      json: true,
      instance: "wealth-alignment-core",
      configPath: "/tmp/c.json",
      id: "doc-1",
      path: "file.txt",
      kind: "bank_statement",
      month: "2026-04",
      currency: "USD",
      institution: "Example",
      notes: "test",
    });
  });

  it("rejects unknown arguments", () => {
    expect(() => parseArgs(["help", "--bogus"])).toThrow(/Unknown argument/);
  });

  it("rejects keyed options with no value", () => {
    expect(() => parseArgs(["help", "--instance"])).toThrow(/Missing value/);
  });

  it("returns undefined command for empty argv", () => {
    expect(parseArgs([]).command).toBeUndefined();
  });

  it("parses --use-vision as a boolean flag", () => {
    const result = parseArgs(["import", "--instance", "x", "--use-vision"]);
    expect(result.options.useVision).toBe(true);
  });
});
