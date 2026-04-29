import { describe, expect, it } from "vitest";

import { parseArgs } from "./args.js";

describe("reality-alignment/config/args", () => {
  it("parses host commands with subcommands and string options", () => {
    const { command, options } = parseArgs([
      "wish",
      "add",
      "--instance",
      "core",
      "--title",
      "Build a calm path",
      "--description",
      "details",
      "--json",
    ]);
    expect(command).toBe("wish");
    expect(options).toEqual({
      json: true,
      subcommand: "add",
      instance: "core",
      title: "Build a calm path",
      description: "details",
    });
  });

  it("parses numeric options for check-ins", () => {
    const { options } = parseArgs([
      "checkin",
      "add",
      "--instance",
      "core",
      "--energy",
      "3",
      "--clarity",
      "4",
      "--congruence",
      "5",
      "--resistance",
      "2",
      "--note",
      "ok",
      "--wish",
      "First",
    ]);
    expect(options).toEqual({
      json: false,
      subcommand: "add",
      instance: "core",
      energy: 3,
      clarity: 4,
      congruence: 5,
      resistance: 2,
      note: "ok",
      wish: "First",
    });
  });

  it("parses query, label, and rationale and config-path", () => {
    const { options } = parseArgs([
      "step",
      "complete",
      "--instance",
      "core",
      "--query",
      "step-id",
      "--config-path",
      "/tmp/config.json",
      "--rationale",
      "because",
      "--label",
      "doubt",
    ]);
    expect(options).toMatchObject({
      subcommand: "complete",
      query: "step-id",
      configPath: "/tmp/config.json",
      rationale: "because",
      label: "doubt",
    });
  });

  it("does not promote the next token to subcommand when it is a flag", () => {
    const { command, options } = parseArgs(["wish", "--instance", "core"]);
    expect(command).toBe("wish");
    expect(options.subcommand).toBeUndefined();
    expect(options.instance).toBe("core");
  });

  it("does not promote a subcommand for top-level commands like review", () => {
    const { command, options } = parseArgs(["review", "weekly", "--instance", "core"]);
    expect(command).toBe("review");
    expect(options.subcommand).toBe("weekly");
  });

  it("rejects unknown arguments and missing values", () => {
    expect(() => parseArgs(["wish", "add", "--bogus"])).toThrow("Unknown argument: --bogus");
    expect(() => parseArgs(["wish", "add", "--instance"])).toThrow("Missing value for --instance");
    expect(() => parseArgs(["checkin", "add", "--energy", "abc"])).toThrow(
      "Expected a number for --energy",
    );
  });
});
