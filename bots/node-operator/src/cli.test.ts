import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isMainModule, parseInvocation, runCli, UNKNOWN_COMMAND_TEXT } from "./cli.js";
import type { StatusCommandResult } from "./commands/status.js";
import { CONCURRENT_TEXT, RATE_LIMIT_MAX_RUNS, RATE_LIMITED_TEXT } from "./guard.js";

const statusMocks = vi.hoisted(() => ({
  getDiagnostics: vi.fn(),
}));
const explainMocks = vi.hoisted(() => ({
  explainCode: vi.fn(),
}));
const matrixReplyMocks = vi.hoisted(() => ({
  sendOwnRoomMessage: vi.fn(async () => true),
}));

vi.mock("./commands/status.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./commands/status.js")>();
  return { ...original, getDiagnostics: statusMocks.getDiagnostics };
});
vi.mock("./commands/explain.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./commands/explain.js")>();
  return { ...original, explainCode: explainMocks.explainCode };
});
vi.mock("./matrix-reply.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./matrix-reply.js")>();
  return { ...original, sendOwnRoomMessage: matrixReplyMocks.sendOwnRoomMessage };
});

const healthyResult: StatusCommandResult = {
  kind: "ok",
  diagnostics: {
    overall: "healthy",
    checkedAt: "2026-07-29T12:00:00.000Z",
    headline: "All components are working normally.",
    components: [
      { id: "matrix", label: "Matrix", status: "healthy", summary: "Matrix is reachable." },
    ],
  },
};

let written: string[];
let originalExitCode: typeof process.exitCode;
let guardRoot: string;

beforeEach(async () => {
  guardRoot = await mkdtemp(join(tmpdir(), "node-operator-cli-guard-"));
  process.env.NODE_OPERATOR_GUARD_PATH = join(guardRoot, "guard.json");
  written = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  originalExitCode = process.exitCode;
  statusMocks.getDiagnostics.mockResolvedValue(healthyResult);
  explainMocks.explainCode.mockResolvedValue({ kind: "invalid-input" });
});

afterEach(async () => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  statusMocks.getDiagnostics.mockReset();
  explainMocks.explainCode.mockReset();
  matrixReplyMocks.sendOwnRoomMessage.mockReset();
  matrixReplyMocks.sendOwnRoomMessage.mockResolvedValue(true);
  delete process.env.NODE_OPERATOR_GUARD_PATH;
  await rm(guardRoot, { recursive: true, force: true });
});

const output = (): string => written.join("");

describe("parseInvocation", () => {
  it("parses command, positional argument and --json", () => {
    expect(parseInvocation(["explain", "SAN-LLM-001", "--json"])).toEqual({
      command: "explain",
      argument: "SAN-LLM-001",
      json: true,
    });
  });

  it("ignores --instance and its value, and extra positionals", () => {
    expect(
      parseInvocation(["status", "--instance", "node-operator-core", "extra", "more"]),
    ).toEqual({
      command: "status",
      argument: "extra",
      json: false,
    });
  });

  it("handles an empty argv", () => {
    expect(parseInvocation([])).toEqual({ command: undefined, argument: undefined, json: false });
  });
});

describe("runCli", () => {
  it("renders status text", async () => {
    await runCli(["status"]);
    expect(output()).toContain("Node status: Healthy");
    expect(output()).toContain("open Node Status for details.");
  });

  it("renders health text", async () => {
    await runCli(["health"]);
    expect(output()).toContain("Node status: Healthy");
    expect(output()).toContain("  Matrix is reachable.");
  });

  it("emits validated diagnostics for --json and a marker when unavailable", async () => {
    await runCli(["status", "--json"]);
    expect(JSON.parse(output()).overall).toBe("healthy");

    written = [];
    statusMocks.getDiagnostics.mockResolvedValue({ kind: "unavailable" });
    await runCli(["health", "--json"]);
    expect(JSON.parse(output())).toEqual({ unavailable: true });
  });

  it("explains a code and flags unsuccessful lookups with a non-zero exit", async () => {
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
    await runCli(["explain", "SAN-LLM-001"]);
    expect(output()).toContain("SAN-LLM-001 — t");
    expect(process.exitCode).toBe(originalExitCode);

    written = [];
    explainMocks.explainCode.mockResolvedValue({ kind: "invalid-input" });
    await runCli(["explain", "nonsense"]);
    expect(process.exitCode).toBe(1);

    process.exitCode = originalExitCode;
    written = [];
    explainMocks.explainCode.mockResolvedValue({ kind: "unknown-code", code: "SAN-ZZZ-999" });
    await runCli(["explain", "SAN-ZZZ-999"]);
    expect(process.exitCode).toBe(1);
  });

  it("renders support and help", async () => {
    await runCli(["support"]);
    expect(output()).toContain("Node Status");

    written = [];
    await runCli(["help"]);
    expect(output()).toContain("status — a short summary");
  });

  it("renders version in both forms without touching the node CLI", async () => {
    await runCli(["version"]);
    expect(output()).toContain("Node Operator unknown");

    written = [];
    await runCli(["version", "--json"]);
    const parsed = JSON.parse(output());
    expect(parsed.component).toBe("node-operator");
    expect(parsed.identityComplete).toBe(false);
    expect(statusMocks.getDiagnostics).not.toHaveBeenCalled();
  });

  it("rejects unknown commands with help and a non-zero exit", async () => {
    await runCli(["reboot"]);
    expect(output()).toContain("I don't know that command.");
    expect(process.exitCode).toBe(1);

    process.exitCode = originalExitCode;
    written = [];
    await runCli([]);
    expect(output().trim()).toBe(UNKNOWN_COMMAND_TEXT);
    expect(process.exitCode).toBe(1);
  });
});

describe("runCli verify", () => {
  it("echoes a valid challenge and posts it to the room deterministically", async () => {
    await runCli(["verify", "deadbeefdeadbeefdeadbeefdeadbeef"]);
    expect(output()).toContain("Verification deadbeefdeadbeefdeadbeefdeadbeef confirmed.");
    expect(statusMocks.getDiagnostics).not.toHaveBeenCalled();
    // The nonce echo must not depend on the LLM relaying tool output: the
    // binary posts it to the bot's own room itself.
    expect(matrixReplyMocks.sendOwnRoomMessage).toHaveBeenCalledWith(
      expect.stringContaining("Verification deadbeefdeadbeefdeadbeefdeadbeef confirmed."),
    );
    expect(process.exitCode).toBe(originalExitCode);
  });

  it("still prints the echo when the direct room post fails", async () => {
    matrixReplyMocks.sendOwnRoomMessage.mockResolvedValueOnce(false);
    await runCli(["verify", "deadbeefdeadbeefdeadbeefdeadbeef"]);
    expect(output()).toContain("Verification deadbeefdeadbeefdeadbeefdeadbeef confirmed.");
  });

  it("rejects a malformed challenge without echoing or posting it", async () => {
    await runCli(["verify", "$(reboot)"]);
    expect(output()).toContain("doesn't look like a verification challenge");
    expect(output()).not.toContain("reboot");
    expect(matrixReplyMocks.sendOwnRoomMessage).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe("runCli diagnostics guard", () => {
  it("rate-limits repeated diagnostic commands with fixed copy", async () => {
    for (let i = 0; i < RATE_LIMIT_MAX_RUNS; i += 1) {
      written = [];
      await runCli(["status"]);
      expect(output()).toContain("Node status:");
    }
    written = [];
    await runCli(["status"]);
    expect(output().trim()).toBe(RATE_LIMITED_TEXT);
    expect(process.exitCode).toBe(1);
  });

  it("refuses a concurrent diagnostics run with fixed copy", async () => {
    let releaseDiagnostics: (() => void) | undefined;
    statusMocks.getDiagnostics.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseDiagnostics = () => resolve(healthyResult);
        }),
    );
    const first = runCli(["health"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    written = [];
    await runCli(["status"]);
    expect(output().trim()).toBe(CONCURRENT_TEXT);
    releaseDiagnostics?.();
    await first;
  });

  it("does not guard fixed-text commands", async () => {
    for (let i = 0; i < RATE_LIMIT_MAX_RUNS + 2; i += 1) {
      written = [];
      await runCli(["help"]);
      expect(output()).toContain("I can help with your Sovereign AI Node");
    }
  });
});

describe("isMainModule", () => {
  it("is false under the test runner and when argv[1] is missing", () => {
    expect(isMainModule()).toBe(false);
    const original = process.argv[1];
    process.argv[1] = undefined as unknown as string;
    expect(isMainModule()).toBe(false);
    process.argv[1] = original as string;
  });
});
