import { describe, expect, it } from "vitest";

import { parseArgs } from "./args.js";

describe("project-sentinel/config/args", () => {
  it("parses feedback arguments", () => {
    expect(
      parseArgs([
        "feedback",
        "--instance",
        "ps-core",
        "--config-path",
        "/tmp/runtime.json5",
        "--signal-id",
        "abc",
        "--action",
        "always-alert",
        "--json",
      ]),
    ).toEqual({
      command: "feedback",
      options: {
        json: true,
        instance: "ps-core",
        configPath: "/tmp/runtime.json5",
        signalId: "abc",
        action: "always-alert",
      },
    });
  });

  it("parses sources subcommands and latest flag", () => {
    expect(
      parseArgs(["sources", "enable", "--instance", "ps-core", "--id", "ubuntu-security"]),
    ).toEqual({
      command: "sources",
      options: {
        json: false,
        subcommand: "enable",
        instance: "ps-core",
        id: "ubuntu-security",
      },
    });
    expect(parseArgs(["sources", "--instance", "ps-core"])).toEqual({
      command: "sources",
      options: {
        json: false,
        instance: "ps-core",
      },
    });
    expect(parseArgs(["sources", "list", "--instance", "ps-core"])).toEqual({
      command: "sources",
      options: {
        json: false,
        subcommand: "list",
        instance: "ps-core",
      },
    });
    expect(
      parseArgs(["feedback", "--instance", "ps-core", "--latest", "--action", "not-relevant"]),
    ).toEqual({
      command: "feedback",
      options: {
        json: false,
        instance: "ps-core",
        latest: true,
        action: "not-relevant",
      },
    });
  });

  it("rejects unknown arguments and missing values", () => {
    expect(() => parseArgs(["scan", "--bogus"])).toThrow("Unknown argument: --bogus");
    expect(() => parseArgs(["scan", "--instance"])).toThrow("Missing value for --instance");
  });
});
