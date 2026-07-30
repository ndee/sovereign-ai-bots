import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StatusCommandResult } from "./commands/status.js";
import {
  executeOperatorCommand,
  MAX_MESSAGE_LENGTH,
  parseOperatorMessage,
  UNKNOWN_TEXT,
} from "./dispatch.js";
import { RATE_LIMIT_MAX_RUNS, RATE_LIMITED_TEXT } from "./guard.js";

const statusMocks = vi.hoisted(() => ({ getDiagnostics: vi.fn() }));
const explainMocks = vi.hoisted(() => ({ explainCode: vi.fn() }));

vi.mock("./commands/status.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./commands/status.js")>();
  return { ...original, getDiagnostics: statusMocks.getDiagnostics };
});
vi.mock("./commands/explain.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./commands/explain.js")>();
  return { ...original, explainCode: explainMocks.explainCode };
});

const BOT = "@node-operator:example.org";

const healthyResult: StatusCommandResult = {
  kind: "ok",
  diagnostics: {
    contractVersion: "2.0.0",
    overall: "healthy",
    checkedAt: "2026-07-30T12:00:00.000Z",
    headline: "All components are working normally.",
    components: [],
  },
};

let guardRoot: string;

beforeEach(async () => {
  guardRoot = await mkdtemp(join(tmpdir(), "node-operator-dispatch-guard-"));
  process.env.NODE_OPERATOR_GUARD_PATH = join(guardRoot, "guard.json");
  statusMocks.getDiagnostics.mockResolvedValue(healthyResult);
  explainMocks.explainCode.mockResolvedValue({ kind: "invalid-input" });
});

afterEach(async () => {
  statusMocks.getDiagnostics.mockReset();
  explainMocks.explainCode.mockReset();
  delete process.env.NODE_OPERATOR_GUARD_PATH;
  await rm(guardRoot, { recursive: true, force: true });
});

describe("parseOperatorMessage", () => {
  it("parses exact commands, case-insensitively, with optional bot mention prefixes", () => {
    expect(parseOperatorMessage("status", BOT)).toEqual({ command: "status" });
    expect(parseOperatorMessage("  HEALTH  ", BOT)).toEqual({ command: "health" });
    expect(parseOperatorMessage(`${BOT}: status`, BOT)).toEqual({ command: "status" });
    expect(parseOperatorMessage("@node-operator: help", BOT)).toEqual({ command: "help" });
    expect(parseOperatorMessage("node-operator: support", BOT)).toEqual({ command: "support" });
    expect(parseOperatorMessage("version", BOT)).toEqual({ command: "version" });
  });

  it("parses bounded arguments for explain and verify only", () => {
    expect(parseOperatorMessage("explain SAN-LLM-001", BOT)).toEqual({
      command: "explain",
      code: "SAN-LLM-001",
    });
    expect(parseOperatorMessage(`verify ${"a".repeat(32)}`, BOT)).toEqual({
      command: "verify",
      nonce: "a".repeat(32),
    });
    expect(parseOperatorMessage(`VERIFY ${"A".repeat(32)}`, BOT)).toEqual({ command: "unknown" });
  });

  it("never infers commands from natural language", () => {
    for (const text of [
      "how is the node doing?",
      "please run status",
      "status now please",
      "status; rm -rf /",
      "status && health",
      "explain",
      "explain SAN-LLM-001 SAN-MAIL-001",
      "verify",
      "verify not-hex",
      `verify ${"a".repeat(70)}`,
      "restart the node",
      "",
    ]) {
      expect(parseOperatorMessage(text, BOT)).toEqual({ command: "unknown" });
    }
  });

  it("bounds input length and type", () => {
    expect(parseOperatorMessage("s".repeat(MAX_MESSAGE_LENGTH + 1), BOT)).toEqual({
      command: "unknown",
    });
    expect(parseOperatorMessage(42, BOT)).toEqual({ command: "unknown" });
    expect(parseOperatorMessage(undefined, BOT)).toEqual({ command: "unknown" });
    expect(parseOperatorMessage("status", undefined)).toEqual({ command: "status" });
    expect(parseOperatorMessage("status", "")).toEqual({ command: "status" });
  });
});

describe("executeOperatorCommand", () => {
  it("runs fixed handlers for the simple commands", async () => {
    expect((await executeOperatorCommand({ command: "help" })).text).toContain(
      "I can help with your Sovereign AI Node",
    );
    expect((await executeOperatorCommand({ command: "support" })).text).toContain("Node Status");
    expect((await executeOperatorCommand({ command: "version" })).text).toContain("Node Operator");
    const status = await executeOperatorCommand({ command: "status" });
    expect(status.text).toContain("Node status: Healthy");
    expect(status.replyRelatesToTrigger).toBe(false);
  });

  it("verify returns the exact VERIFY_OK line and requests a reply relation", async () => {
    const nonce = "deadbeefdeadbeefdeadbeefdeadbeef";
    const outcome = await executeOperatorCommand({ command: "verify", nonce });
    expect(outcome.text).toBe(`VERIFY_OK ${nonce}`);
    expect(outcome.replyRelatesToTrigger).toBe(true);
    expect(outcome.exitCode).toBe(0);

    const invalid = await executeOperatorCommand({ command: "verify", nonce: "$(reboot)" });
    expect(invalid.text).not.toContain("reboot");
    expect(invalid.replyRelatesToTrigger).toBe(false);
    expect(invalid.exitCode).toBe(1);
  });

  it("returns fixed refusal text for unknown commands", async () => {
    const outcome = await executeOperatorCommand({ command: "unknown" });
    expect(outcome.text).toBe(UNKNOWN_TEXT);
    expect(outcome.exitCode).toBe(1);
  });

  it("guards diagnostics commands with the bounded rate limiter", async () => {
    for (let i = 0; i < RATE_LIMIT_MAX_RUNS; i += 1) {
      const outcome = await executeOperatorCommand({ command: "status" });
      expect(outcome.text).toContain("Node status:");
    }
    const throttled = await executeOperatorCommand({ command: "health" });
    expect(throttled.text).toBe(RATE_LIMITED_TEXT);
    expect(throttled.exitCode).toBe(1);
  });

  it("routes explain through validation and flags failed lookups", async () => {
    explainMocks.explainCode.mockResolvedValue({ kind: "unknown-code", code: "SAN-ZZZ-999" });
    const unknown = await executeOperatorCommand({ command: "explain", code: "SAN-ZZZ-999" });
    expect(unknown.exitCode).toBe(1);

    explainMocks.explainCode.mockResolvedValue({
      kind: "explained",
      definition: {
        id: "SAN-LLM-001",
        title: "t",
        explanation: "e",
        likelyCause: "c",
        userAction: "a",
        retryable: true,
        severity: "degraded",
      },
    });
    const explained = await executeOperatorCommand({ command: "explain", code: "SAN-LLM-001" });
    expect(explained.exitCode).toBe(0);
    expect(explained.text).toContain("SAN-LLM-001 — t");
  });
});

describe("mention prefix edge cases", () => {
  it("strips a bare mxid prefix without a colon and handles non-mxid bot ids", () => {
    expect(parseOperatorMessage("@node-operator:example.org status", BOT)).toEqual({
      command: "status",
    });
    // A bot id without the @-mxid shape: only the raw prefix forms apply.
    expect(parseOperatorMessage("oddbot: help", "oddbot")).toEqual({ command: "help" });
    expect(parseOperatorMessage("status", "oddbot")).toEqual({ command: "status" });
  });
});
