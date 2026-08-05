import { beforeEach, describe, expect, it, vi } from "vitest";

import { getFakeRuntime, resetFakeRuntime } from "../__fixtures__/fake-runtime.js";

// Controllable tool-availability verdict (#324); hoisted for the mock factory.
const toolAvailabilityRef = vi.hoisted(() => ({
  current: {
    ok: true,
    executable: "/usr/local/bin/sovereign-tool",
    source: "default",
  } as unknown,
}));

vi.mock("../config/runtime.js", async () => {
  const actual =
    await vi.importActual<typeof import("../config/runtime.js")>("../config/runtime.js");
  return {
    ...actual,
    resolveToolRuntime: async () => getFakeRuntime(),
    checkToolAvailability: async () => toolAvailabilityRef.current,
  };
});

const { formatStatusResult, status } = await import("./status.js");

const OVERRIDE_REASON =
  "IMAP tool unavailable: /opt/custom/sovereign-tool not found. " +
  "Mail scanning cannot proceed until the tool is installed or configured. " +
  "(configured via SOVEREIGN_TOOL_EXECUTABLE)";

describe("commands/status", () => {
  beforeEach(() => {
    resetFakeRuntime();
    toolAvailabilityRef.current = {
      ok: true,
      executable: "/usr/local/bin/sovereign-tool",
      source: "default",
    };
  });

  it("requires an instance id", async () => {
    await expect(status({})).rejects.toThrow("Expected --instance <id>");
  });

  it("reports ready with the default tool source on a healthy fresh node", async () => {
    const result = await status({ instance: "ms-core" });
    expect(result).toEqual({
      ready: true,
      toolExecutable: "/usr/local/bin/sovereign-tool",
      toolExecutableSource: "default",
      degradationState: "healthy",
      consecutiveFailures: 0,
    });
    // A status report never carries a `reason` when ready.
    expect(result.reason).toBeUndefined();
  });

  it("reports ready with the override source when a configured executable is usable", async () => {
    toolAvailabilityRef.current = {
      ok: true,
      executable: "/opt/custom/sovereign-tool",
      source: "override",
    };
    const result = await status({ instance: "ms-core" });
    expect(result.ready).toBe(true);
    expect(result.toolExecutable).toBe("/opt/custom/sovereign-tool");
    expect(result.toolExecutableSource).toBe("override");
  });

  it("reports not-ready with the tool-unavailable reason when the default tool is missing", async () => {
    toolAvailabilityRef.current = {
      ok: false,
      executable: "/usr/local/bin/sovereign-tool",
      source: "default",
      reason:
        "IMAP tool unavailable: /usr/local/bin/sovereign-tool not found. " +
        "Mail scanning cannot proceed until the tool is installed or configured.",
    };
    const result = await status({ instance: "ms-core" });
    expect(result.ready).toBe(false);
    expect(result.reason).toBe(
      "IMAP tool unavailable: /usr/local/bin/sovereign-tool not found. " +
        "Mail scanning cannot proceed until the tool is installed or configured.",
    );
    expect(result.toolExecutableSource).toBe("default");
  });

  it("reports not-ready naming the override when a configured executable is broken", async () => {
    toolAvailabilityRef.current = {
      ok: false,
      executable: "/opt/custom/sovereign-tool",
      source: "override",
      reason: OVERRIDE_REASON,
    };
    const result = await status({ instance: "ms-core" });
    expect(result.ready).toBe(false);
    expect(result.toolExecutable).toBe("/opt/custom/sovereign-tool");
    expect(result.toolExecutableSource).toBe("override");
    expect(result.reason).toBe(OVERRIDE_REASON);
    // No secret-bearing config fields ride along.
    expect(result.reason).not.toMatch(/password|token|secret/iu);
  });

  it("mirrors the recorded degradation state, counters, and last error", async () => {
    const runtime = getFakeRuntime();
    runtime.state.degradationState = "tool-unavailable";
    runtime.state.consecutiveFailures = 2;
    runtime.state.lastPollAt = "2026-08-04T10:00:00.000Z";
    runtime.state.lastError = {
      code: "MAIL_SENTINEL_TOOL_UNAVAILABLE",
      message: "IMAP tool unavailable: /usr/local/bin/sovereign-tool not found.",
      retryable: true,
    };
    const result = await status({ instance: "ms-core" });
    expect(result.degradationState).toBe("tool-unavailable");
    expect(result.consecutiveFailures).toBe(2);
    expect(result.lastPollAt).toBe("2026-08-04T10:00:00.000Z");
    expect(result.lastError).toEqual({
      code: "MAIL_SENTINEL_TOOL_UNAVAILABLE",
      message: "IMAP tool unavailable: /usr/local/bin/sovereign-tool not found.",
      retryable: true,
    });
  });

  it("reports the healthy baseline for a state file without a recorded degradation state", async () => {
    const runtime = getFakeRuntime();
    runtime.state.degradationState = undefined;
    const result = await status({ instance: "ms-core" });
    expect(result.degradationState).toBe("healthy");
    expect(result.lastPollAt).toBeUndefined();
    expect(result.lastError).toBeUndefined();
  });
});

describe("commands/status > formatStatusResult", () => {
  it("renders a ready report", () => {
    expect(
      formatStatusResult({
        ready: true,
        toolExecutable: "/usr/local/bin/sovereign-tool",
        toolExecutableSource: "default",
        degradationState: "healthy",
        consecutiveFailures: 0,
      }),
    ).toBe(
      [
        "Mail Sentinel is ready.",
        "Tool executable: /usr/local/bin/sovereign-tool (default)",
        "Degradation state: healthy",
        "Consecutive failures: 0",
      ].join("\n"),
    );
  });

  it("renders a not-ready report with poll time, last error, and reason", () => {
    expect(
      formatStatusResult({
        ready: false,
        reason: OVERRIDE_REASON,
        toolExecutable: "/opt/custom/sovereign-tool",
        toolExecutableSource: "override",
        degradationState: "tool-unavailable",
        consecutiveFailures: 1,
        lastPollAt: "2026-08-04T10:00:00.000Z",
        lastError: {
          code: "MAIL_SENTINEL_TOOL_UNAVAILABLE",
          message: "IMAP tool unavailable: /opt/custom/sovereign-tool not found.",
          retryable: true,
        },
      }),
    ).toBe(
      [
        "Mail Sentinel is not ready.",
        "Tool executable: /opt/custom/sovereign-tool (override)",
        "Degradation state: tool-unavailable",
        "Consecutive failures: 1",
        "Last poll: 2026-08-04T10:00:00.000Z",
        "Last error: MAIL_SENTINEL_TOOL_UNAVAILABLE: " +
          "IMAP tool unavailable: /opt/custom/sovereign-tool not found.",
        OVERRIDE_REASON,
      ].join("\n"),
    );
  });
});
