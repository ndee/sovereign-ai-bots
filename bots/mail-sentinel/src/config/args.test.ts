import { describe, expect, it } from "vitest";

import { loadGolden } from "../__fixtures__/load.js";
import { parseArgs } from "./args.js";

describe("config/args", () => {
  it("matches the parseArgs scan golden fixture", () => {
    expect(parseArgs(["scan", "--instance", "ms-core", "--json"])).toEqual(
      loadGolden("parseArgs.scan"),
    );
  });

  it("matches the parseArgs feedback golden fixture", () => {
    expect(
      parseArgs([
        "feedback",
        "--instance",
        "ms-core",
        "--latest",
        "--action",
        "remind-later",
        "--delay",
        "4h",
        "--json",
      ]),
    ).toEqual(loadGolden("parseArgs.feedback"));
  });

  it("parses a feedback --ref value", () => {
    const { command, options } = parseArgs([
      "feedback",
      "--instance",
      "ms-core",
      "--ref",
      "a1b2c3",
      "--action",
      "not-important",
    ]);
    expect(command).toBe("feedback");
    expect(options.ref).toBe("a1b2c3");
  });

  it("matches the parseArgs policyAdd golden fixture", () => {
    expect(
      parseArgs([
        "policy",
        "add",
        "--instance",
        "ms-core",
        "--type",
        "sender",
        "--match",
        "alice@example.com",
        "--min-zone",
        "amber",
        "--json",
      ]),
    ).toEqual(loadGolden("parseArgs.policyAdd"));
  });

  it("matches the parseArgs listAlerts golden fixture", () => {
    expect(
      parseArgs(["list-alerts", "--instance", "ms-core", "--view", "today", "--json"]),
    ).toEqual(loadGolden("parseArgs.listAlerts"));
  });

  it("throws on unknown arguments (matches the error fixture)", () => {
    const golden = loadGolden<{ message: string }>("parseArgs.unknown");
    expect(() => parseArgs(["scan", "--instance", "ms-core", "--bogus"])).toThrow(golden.message);
  });

  it("throws when a keyed option is missing its value (matches the error fixture)", () => {
    const golden = loadGolden<{ message: string }>("parseArgs.missingValue");
    expect(() => parseArgs(["scan", "--instance"])).toThrow(golden.message);
  });

  it("recognizes every keyed option", () => {
    const args = [
      "policy",
      "add",
      "--instance",
      "ms",
      "--config-path",
      "/cfg.json5",
      "--alert-id",
      "a1",
      "--action",
      "important",
      "--delay",
      "4h",
      "--view",
      "today",
      "--limit",
      "5",
      "--type",
      "sender",
      "--match",
      "a@b",
      "--min-zone",
      "amber",
      "--max-zone",
      "red",
      "--boost",
      "1",
      "--reason",
      "because",
      "--id",
      "p-1",
      "--category",
      "financial",
      "--schedule",
      "09:00-17:00",
      "--pattern",
      "invoice",
      "--scope",
      "subject",
      "--target",
      "cc",
      "--contains",
      "freigegeben",
      "--amount-threshold",
      "100",
      "--query",
      "alice",
      "--announce",
      "--latest",
      "--json",
    ];
    const parsed = parseArgs(args);
    expect(parsed.command).toBe("policy");
    expect(parsed.options.subcommand).toBe("add");
    expect(parsed.options.instance).toBe("ms");
    expect(parsed.options.scope).toBe("subject");
    expect(parsed.options.target).toBe("cc");
    expect(parsed.options.contains).toBe("freigegeben");
    expect(parsed.options.announce).toBe(true);
    expect(parsed.options.latest).toBe(true);
    expect(parsed.options.json).toBe(true);
  });

  it("returns undefined command for an empty argv", () => {
    expect(parseArgs([])).toEqual({ command: undefined, options: { json: false } });
  });

  it("does not treat `policy --json` as a subcommand", () => {
    const parsed = parseArgs(["policy", "--json"]);
    expect(parsed.options.subcommand).toBeUndefined();
    expect(parsed.options.json).toBe(true);
  });
});
