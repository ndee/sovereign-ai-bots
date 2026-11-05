import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

type Operation = {
  name: string;
  effect: "read" | "change";
  argv: string[];
  params?: Record<string, unknown>;
  slashCommand?: string;
};

const manifest = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "sovereign-bot.json"), "utf8"),
) as { toolTemplates: Array<{ openclawTypedTool: { operations: Operation[] } }> };
const operations = manifest.toolTemplates[0]?.openclawTypedTool.operations ?? [];

describe("mail-sentinel slash commands", () => {
  // `/version` must not depend on the chat model choosing the tool: a model
  // that skips it can invent a build number.
  it("declares /version on the version operation, which needs no instance", () => {
    const declared = operations.filter((operation) => operation.slashCommand !== undefined);
    expect(declared.map((operation) => [operation.slashCommand, operation.name])).toEqual([
      ["version", "version"],
    ]);
    expect(declared[0]?.argv).toEqual(["version", "--json"]);
  });
});
