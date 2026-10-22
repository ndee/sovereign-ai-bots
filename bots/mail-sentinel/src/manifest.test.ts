import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseArgs } from "./config/args.js";
import { DEFAULT_LLM_TIMEOUT_MS, DEFAULT_SCAN_BUDGET_MS } from "./constants.js";

type Param = {
  type: "string" | "boolean";
  enum?: string[];
  pattern?: string;
  maxLength?: number;
  argv: string[];
};
type Operation = {
  name: string;
  effect: "read" | "change";
  argv: string[];
  params?: Record<string, Param>;
  required?: string[];
  exactlyOneOf?: string[][];
  confirm?: "always" | { param: string; values: string[] };
  confirmPreviewArgv?: string[];
};
type ToolTemplate = {
  allowedCommands: string[];
  openclawBundledPlugins: string[];
  openclawToolNames: string[];
  openclawTypedTool: { name: string; script: string; operations: Operation[] };
  openclawScanAgent: { toolNames: string[] };
};

const manifest = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "sovereign-bot.json"), "utf8"),
) as { toolTemplates: ToolTemplate[]; hostResources: Array<{ spec: { source?: string } }> };
const template = manifest.toolTemplates[0] as ToolTemplate;
const operations = template.openclawTypedTool.operations;
const operation = (name: string): Operation => {
  const found = operations.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`missing operation ${name}`);
  }
  return found;
};

const SAMPLES: Record<string, string> = {
  alertId: "3f2a1b9c-0d4e-4f5a-8b6c-7d8e9f0a1b2c",
  id: "3f2a1b9c-0d4e-4f5a-8b6c-7d8e9f0a1b2c",
  delay: "4h",
};

// Every argv the typed tool can build for an operation: the fixed argv plus
// each parameter, once per enum value.
const sampleArgvs = (entry: Operation): string[][] => {
  const fixed = entry.argv.map((token) => (token === "<tool-instance-id>" ? "core" : token));
  const variants: string[][] = [fixed];
  for (const [name, param] of Object.entries(entry.params ?? {})) {
    const values =
      param.type === "boolean" ? [""] : (param.enum ?? [SAMPLES[name] ?? "Example Sender"]);
    for (const value of values) {
      if (param.pattern !== undefined) {
        expect(new RegExp(param.pattern, "u").test(value)).toBe(true);
      }
      variants.push([
        ...fixed,
        ...param.argv.map((token) => (token === "{value}" ? value : token)),
      ]);
    }
  }
  return variants.map((argv) => [...argv, ...(entry.confirmPreviewArgv ?? [])]);
};

describe("Mail Sentinel typed tool manifest", () => {
  it("offers no shell commands and no generic tools to the chat agent", () => {
    expect(template.allowedCommands).toEqual([]);
    expect(template.openclawToolNames).toEqual([]);
    expect(template.openclawBundledPlugins).toEqual(["llm-task"]);
    expect(template.openclawTypedTool.name).toBe("mail_sentinel");
  });

  it("runs the same build the workspace and the scan timer use", () => {
    expect(manifest.hostResources.map((resource) => resource.spec.source)).toContain(
      template.openclawTypedTool.script,
    );
  });

  it("gives the scan its own agent with llm-task only", () => {
    expect(template.openclawScanAgent).toEqual({ toolNames: ["llm-task"] });
  });

  it("keeps the scan out of chat", () => {
    expect(operations.map((entry) => entry.name)).not.toContain("scan");
    expect(operations.flatMap((entry) => entry.argv)).not.toContain("scan");
  });

  it("marks exactly the state-changing operations as changes", () => {
    expect(
      operations.filter((entry) => entry.effect === "change").map((entry) => entry.name),
    ).toEqual(["feedback", "policy-important-sender", "policy-add", "policy-remove"]);
  });

  it("asks for confirmation on every change that lowers alerting", () => {
    expect(operation("feedback").confirm).toEqual({
      param: "action",
      values: ["not-important", "less-often", "reduce", "digest-only"],
    });
    expect(operation("feedback").confirmPreviewArgv).toEqual(["--dry-run"]);
    expect(operation("policy-remove").confirm).toBe("always");
    expect(operation("policy-add").confirm).toBeUndefined();
    expect(operation("policy-add").params?.minZone?.enum).toEqual(["red", "amber"]);
    expect(operation("policy-add").params?.type?.enum).toEqual(["sender", "domain", "receiver"]);
    expect(operation("policy-important-sender").confirm).toBeUndefined();
  });

  it("offers the feedback actions the CLI supports, except mute", () => {
    expect(operation("feedback").params?.action?.enum).toEqual([
      "important",
      "not-important",
      "less-often",
      "remind-later",
      "always-like-this",
      "reduce",
      "digest-only",
    ]);
    expect(operation("feedback").exactlyOneOf).toEqual([["alertId", "latest"]]);
  });

  it("bounds the reminder delay", () => {
    const pattern = new RegExp(operation("feedback").params?.delay?.pattern ?? "", "u");
    for (const value of ["1m", "999m", "4h", "99h", "1d", "7d"]) {
      expect(pattern.test(value)).toBe(true);
    }
    for (const value of ["0m", "1000m", "100h", "8d", "30d", "4 h", "-4h"]) {
      expect(pattern.test(value)).toBe(false);
    }
  });

  it("builds only argv the CLI parser accepts", () => {
    const commands = new Set([
      "version",
      "status",
      "reconcile",
      "integrity",
      "digest",
      "feedback",
      "explain",
      "list-alerts",
      "policy",
    ]);
    for (const entry of operations) {
      for (const argv of sampleArgvs(entry)) {
        const parsed = parseArgs(argv);
        expect(commands.has(parsed.command ?? "")).toBe(true);
        expect(parsed.options.json).toBe(true);
        if (parsed.command !== "version") {
          expect(parsed.options.instance).toBe("core");
        }
        if (parsed.command === "policy") {
          expect(["list", "important-sender", "add", "remove"]).toContain(
            parsed.options.subcommand,
          );
        }
      }
    }
  });
});

describe("Mail Sentinel review latency budget", () => {
  const shipped = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "sovereign-bot.json"), "utf8"),
  ) as {
    configDefaults: { llmTimeoutMs?: unknown };
    hostResources: Array<{ id: string; spec: { timeoutStartSec?: number } }>;
  };

  it("ships a 60 s gateway-side review limit, the same as the runtime default", () => {
    expect(shipped.configDefaults.llmTimeoutMs).toBe(60_000);
    expect(DEFAULT_LLM_TIMEOUT_MS).toBe(60_000);
  });

  it("ends the worst-case scan loop by 255 s, leaving at least 45 s of the unit limit", () => {
    const scanUnit = shipped.hostResources.find((resource) => resource.id === "scan-service");
    const unitLimitMs = (scanUnit?.spec.timeoutStartSec ?? 0) * 1000;
    // No review starts after the budget; the last one ends at the client kill,
    // 15 s after the gateway-side limit.
    const loopEndMs = DEFAULT_SCAN_BUDGET_MS + DEFAULT_LLM_TIMEOUT_MS + 15_000;
    expect(loopEndMs).toBeLessThanOrEqual(255_000);
    expect(unitLimitMs - loopEndMs).toBeGreaterThanOrEqual(45_000);
  });
});
