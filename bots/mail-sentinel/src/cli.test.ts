import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getFakeRuntime, resetFakeRuntime } from "./__fixtures__/fake-runtime.js";

vi.mock("./config/runtime.js", () => ({
  resolveToolRuntime: async () => getFakeRuntime(),
}));

vi.mock("./state/io.js", async () => {
  const actual = await vi.importActual<typeof import("./state/io.js")>("./state/io.js");
  return {
    ...actual,
    withLockedState: async <T>(_p: string, action: () => Promise<T>) => action(),
  };
});

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    randomUUID: () => "00000000-0000-0000-0000-000000000000",
  };
});

const { isMainModule, reportError, runCli } = await import("./cli.js");

const FIXED_NOW = new Date("2026-04-08T12:00:00.000Z");

describe("cli", () => {
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy types are unwieldy here
  let stdoutSpy: any;
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy types are unwieldy here
  let stderrSpy: any;

  beforeEach(() => {
    resetFakeRuntime();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    process.exitCode = undefined;
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.useRealTimers();
  });

  it("requires a command", async () => {
    await expect(runCli([])).rejects.toThrow("Expected a command");
  });

  it("requires an --instance flag", async () => {
    await expect(runCli(["scan"])).rejects.toThrow("Expected --instance <id>");
  });

  // `version` is dispatched before the --instance guard so an operator can ask
  // what code is live on a node whose instance is unconfigured or broken.
  it("dispatches version without requiring --instance", async () => {
    await runCli(["version", "--json"]);
    const payload = JSON.parse(String(stdoutSpy.mock.calls[0][0])) as Record<string, unknown>;
    expect(payload.component).toBe("mail-sentinel");
    expect(payload).toHaveProperty("commit");
    expect(payload).toHaveProperty("releaseId");
    expect(process.exitCode).toBeUndefined();
  });

  it("renders version as plain text without --json", async () => {
    await runCli(["version"]);
    expect(String(stdoutSpy.mock.calls[0][0])).toContain("Mail Sentinel ");
  });

  it("lists version among the known commands when none is given", async () => {
    await expect(runCli([])).rejects.toThrow("version");
  });

  it("dispatches scan", async () => {
    const runtime = getFakeRuntime();
    runtime.imapConfigured = false;
    await runCli(["scan", "--instance", "ms-core", "--json"]);
    expect(stdoutSpy).toHaveBeenCalled();
    expect(String(stdoutSpy.mock.calls[0]?.[0])).toContain('"configured": false');
  });

  it("dispatches digest", async () => {
    await runCli(["digest", "--instance", "ms-core"]);
    expect(String(stdoutSpy.mock.calls[0]?.[0])).toContain("No amber digest entries");
  });

  it("rejects feedback without an action", async () => {
    await expect(runCli(["feedback", "--instance", "ms-core", "--latest"])).rejects.toThrow(
      "Expected --action",
    );
  });

  it("rejects feedback with no selector (neither --latest, --alert-id, nor --ref)", async () => {
    await expect(
      runCli(["feedback", "--instance", "ms-core", "--action", "important"]),
    ).rejects.toThrow("Use exactly one of --alert-id, --latest, or --ref");
  });

  it("rejects feedback with both --latest and --alert-id", async () => {
    await expect(
      runCli([
        "feedback",
        "--instance",
        "ms-core",
        "--latest",
        "--alert-id",
        "x",
        "--action",
        "important",
      ]),
    ).rejects.toThrow("Use exactly one of --alert-id, --latest, or --ref");
  });

  it("rejects feedback with both --ref and --alert-id", async () => {
    await expect(
      runCli([
        "feedback",
        "--instance",
        "ms-core",
        "--ref",
        "abc",
        "--alert-id",
        "x",
        "--action",
        "important",
      ]),
    ).rejects.toThrow("Use exactly one of --alert-id, --latest, or --ref");
  });

  it("dispatches feedback when --latest is set and an alert exists", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts.push({
      alertId: "a1",
      zone: "red",
      category: "financial-relevance",
      subject: "s",
      from: "Alice <alice@example.com>",
      fromAddress: "alice@example.com",
      why: "w",
      sentAt: "2026-04-08T09:00:00Z",
      feedbackState: "pending",
      matchedRuleIds: [],
    });
    await runCli(["feedback", "--instance", "ms-core", "--latest", "--action", "important"]);
    expect(stdoutSpy).toHaveBeenCalled();
  });

  it("dispatches feedback via --ref and confirms the matched item", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts.push({
      alertId: "aaaaaaaa-0000-0000-0000-000000000000",
      shortRef: "aaaaaa",
      zone: "red",
      category: "financial-relevance",
      subject: "Invoice overdue",
      from: "Alice <alice@example.com>",
      fromAddress: "alice@example.com",
      why: "w",
      sentAt: "2026-04-08T09:00:00Z",
      feedbackState: "pending",
      matchedRuleIds: [],
    });
    await runCli(["feedback", "--instance", "ms-core", "--ref", "aaaaaa", "--action", "important"]);
    expect(String(stdoutSpy.mock.calls[0]?.[0])).toContain("[aaaaaa] 'Invoice overdue'");
    expect(process.exitCode).toBeUndefined();
  });

  it("sets a non-zero exit code when --ref feedback is ambiguous and applies no change", async () => {
    const runtime = getFakeRuntime();
    const base = {
      zone: "amber" as const,
      category: "financial-relevance" as const,
      from: "Alice <alice@example.com>",
      fromAddress: "alice@example.com",
      why: "w",
      sentAt: "2026-04-08T09:00:00Z",
      feedbackState: "pending" as const,
      matchedRuleIds: [],
    };
    runtime.state.alerts.push(
      {
        ...base,
        alertId: "aa000000-0000-0000-0000-000000000000",
        shortRef: "aa0000",
        subject: "One",
      },
      {
        ...base,
        alertId: "aa111111-0000-0000-0000-000000000000",
        shortRef: "aa1111",
        subject: "Two",
      },
    );
    await runCli(["feedback", "--instance", "ms-core", "--ref", "aa", "--action", "important"]);
    expect(String(stdoutSpy.mock.calls[0]?.[0])).toContain("Ambiguous: 'aa' matches 2 items");
    expect(process.exitCode).toBe(1);
    expect(runtime.state.alerts.every((a) => a.feedbackState === "pending")).toBe(true);
  });

  it("rejects explain with no selector (neither --latest, --alert-id, nor --ref)", async () => {
    await expect(runCli(["explain", "--instance", "ms-core"])).rejects.toThrow(
      "Use exactly one of --alert-id, --latest, or --ref",
    );
  });

  it("dispatches explain via --latest and prints the three sections", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts.push({
      alertId: "aaaaaaaa-0000-0000-0000-000000000000",
      shortRef: "aaaaaa",
      zone: "red",
      category: "financial-relevance",
      subject: "Invoice overdue",
      from: "Alice <alice@example.com>",
      fromAddress: "alice@example.com",
      why: "Payment failure may lock the account.",
      sentAt: "2026-04-08T09:00:00Z",
      feedbackState: "pending",
      reasons: ["amount detected"],
      matchedRuleIds: ["rule-amount"],
      policyModifiers: [],
      score: 5,
      adjustedScore: 5,
      confidence: 80,
      llmResult: {
        decisionRequired: true,
        financialRelevance: true,
        riskEscalation: false,
        confidence: 80,
        urgency: "high",
        reason: "Payment failure may lock the account.",
        deadlineDetected: false,
        amountDetected: true,
        suggestedZone: "red",
      },
    });
    await runCli(["explain", "--instance", "ms-core", "--latest"]);
    const out = String(stdoutSpy.mock.calls[0]?.[0]);
    expect(out).toContain("Explanation for [aaaaaa] 'Invoice overdue'");
    expect(out).toContain("Policy & heuristics:");
    expect(out).toContain("Semantic review:");
    expect(out).toContain("Zone decision:");
    expect(process.exitCode).toBeUndefined();
  });

  it("sets a non-zero exit code when --ref explain is ambiguous", async () => {
    const runtime = getFakeRuntime();
    const base = {
      zone: "amber" as const,
      category: "financial-relevance" as const,
      from: "Alice <alice@example.com>",
      fromAddress: "alice@example.com",
      why: "w",
      sentAt: "2026-04-08T09:00:00Z",
      feedbackState: "pending" as const,
      matchedRuleIds: [],
    };
    runtime.state.alerts.push(
      {
        ...base,
        alertId: "aa000000-0000-0000-0000-000000000000",
        shortRef: "aa0000",
        subject: "One",
      },
      {
        ...base,
        alertId: "aa111111-0000-0000-0000-000000000000",
        shortRef: "aa1111",
        subject: "Two",
      },
    );
    await runCli(["explain", "--instance", "ms-core", "--ref", "aa"]);
    expect(String(stdoutSpy.mock.calls[0]?.[0])).toContain("Ambiguous: 'aa' matches 2 items");
    expect(process.exitCode).toBe(1);
  });

  it("rejects list-alerts without a valid --view", async () => {
    await expect(runCli(["list-alerts", "--instance", "ms-core"])).rejects.toThrow(
      "Expected --view",
    );
  });

  it("dispatches list-alerts today view", async () => {
    await runCli(["list-alerts", "--instance", "ms-core", "--view", "today"]);
    expect(stdoutSpy).toHaveBeenCalled();
  });

  it("dispatches policy list", async () => {
    await runCli(["policy", "list", "--instance", "ms-core"]);
    expect(stdoutSpy).toHaveBeenCalled();
  });

  it("dispatches policy important-sender", async () => {
    await runCli(["policy", "important-sender", "--instance", "ms-core", "--query", "nobody"]);
    expect(stdoutSpy).toHaveBeenCalled();
  });

  it("dispatches policy add", async () => {
    await runCli(["policy", "add", "--instance", "ms-core", "--type", "sender", "--match", "a@b"]);
    expect(String(stdoutSpy.mock.calls[0]?.[0])).toContain("Policy ");
  });

  it("dispatches policy remove (not found)", async () => {
    await runCli(["policy", "remove", "--instance", "ms-core", "--id", "missing"]);
    expect(String(stdoutSpy.mock.calls[0]?.[0])).toContain("Policy missing not found");
  });

  it("dispatches policy remove (found)", async () => {
    const runtime = getFakeRuntime();
    runtime.policy.senderPolicies.push({ id: "to-remove", match: "a@b" });
    await runCli(["policy", "remove", "--instance", "ms-core", "--id", "to-remove"]);
    expect(String(stdoutSpy.mock.calls[0]?.[0])).toContain("Policy to-remove removed");
  });

  it("rejects unknown policy subcommands", async () => {
    await expect(runCli(["policy", "bogus", "--instance", "ms-core"])).rejects.toThrow(
      "Expected a policy subcommand",
    );
  });

  it("rejects unknown top-level commands", async () => {
    await expect(runCli(["nope", "--instance", "ms-core"])).rejects.toThrow(
      "Unknown command: nope",
    );
  });

  describe("reportError", () => {
    it("writes a JSON error payload when --json is present", () => {
      reportError(new Error("boom"), ["node", "cli", "--json"]);
      expect(stdoutSpy).toHaveBeenCalled();
      expect(String(stdoutSpy.mock.calls[0]?.[0])).toContain('"ok": false');
      expect(process.exitCode).toBe(1);
    });

    it("writes a plain error to stderr otherwise", () => {
      reportError(new Error("boom"), ["node", "cli"]);
      expect(stderrSpy).toHaveBeenCalledWith("boom\n");
    });

    it("stringifies non-Error rejection values", () => {
      reportError("string-boom", ["node", "cli"]);
      expect(stderrSpy).toHaveBeenCalledWith("string-boom\n");
    });
  });

  describe("isMainModule", () => {
    it("returns false when argv[1] is not a string", () => {
      const saved = process.argv[1];
      try {
        (process.argv as Array<string | undefined>)[1] = undefined;
        expect(isMainModule()).toBe(false);
      } finally {
        process.argv[1] = saved as string;
      }
    });

    it("returns false when the URL does not match import.meta.url", () => {
      // argv[1] is the test runner; import.meta.url is cli.ts in the source tree.
      expect(isMainModule()).toBe(false);
    });

    it("returns true when argv[1] resolves to the current module URL", async () => {
      const { fileURLToPath } = await import("node:url");
      const saved = process.argv[1];
      try {
        // cli.ts module url is the actual source file URL at runtime;
        // setting argv[1] to that file path must make isMainModule() true.
        process.argv[1] = fileURLToPath(new URL("./cli.ts", import.meta.url));
        expect(isMainModule()).toBe(true);
      } finally {
        process.argv[1] = saved as string;
      }
    });
  });
});
