import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFile = vi.fn();
const writeFile = vi.fn();
const rm = vi.fn();

vi.mock("node:fs/promises", () => ({
  readFile,
  writeFile,
  rm,
  mkdir: vi.fn().mockResolvedValue(undefined),
  open: vi.fn(),
  rename: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn(),
}));

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    randomUUID: () => "00000000-0000-0000-0000-000000000000",
  };
});

// Dynamic import after mocks.
const { MailSentinelRuntime, resolveToolRuntime } = await import("./runtime.js");
const { setExecFileAsync } = await import("../imap/exec.js");

const makeRuntimeConfig = (overrides: Record<string, unknown> = {}) => ({
  sovereignTools: {
    instances: [
      {
        id: "ms-core",
        config: {
          agentId: "mail-sentinel",
          imapConfigured: "true",
          imapInstanceId: "ms-imap",
          statePath: "data/state.json",
          rulesPath: "config/rules.json",
          policyPath: "config/policy.json",
          lookbackWindow: "2h",
          defaultReminderDelay: "6h",
          digestInterval: "12h",
          openclawUrl: "http://localhost:9999",
          llmModel: "test-model",
          llmTimeoutMs: 1000,
          matrixAdminBaseUrl: "https://matrix.example",
          matrixAlertRoomId: "!room:example",
          ...overrides,
        },
      },
    ],
  },
  openclawProfile: {
    agents: [
      {
        id: "mail-sentinel",
        workspace: "/tmp/ms-workspace",
        matrix: { accessTokenSecretRef: "env:MAIL_SENTINEL_TEST_TOKEN" },
      },
    ],
  },
  matrix: {
    adminBaseUrl: "https://matrix.example",
    alertRoom: { roomId: "!room:example" },
  },
  imap: { status: "configured" },
  openclaw: { runtimeConfigPath: "/tmp/runtime.json5" },
});

describe("config/runtime", () => {
  beforeEach(() => {
    readFile.mockReset();
    writeFile.mockReset();
    rm.mockReset();
    process.env.MAIL_SENTINEL_TEST_TOKEN = "test-token";
    process.env.SOVEREIGN_TOOL_EXECUTABLE = "/usr/bin/sovereign-tool";
  });
  afterEach(() => {
    delete process.env.MAIL_SENTINEL_TEST_TOKEN;
    delete process.env.SOVEREIGN_TOOL_EXECUTABLE;
  });

  describe("load", () => {
    it("loads a runtime config and resolves paths relative to the workspace", async () => {
      const runtimeConfig = makeRuntimeConfig();
      readFile
        .mockResolvedValueOnce(JSON.stringify(runtimeConfig)) // main config
        .mockResolvedValueOnce(JSON.stringify({ gateway: { auth: { token: "gw-token" } } })); // gateway runtime
      const runtime = new MailSentinelRuntime("ms-core", "/tmp/config.json5");
      await runtime.load();
      expect(runtime.statePath).toBe("/tmp/ms-workspace/data/state.json");
      expect(runtime.rulesPath).toBe("/tmp/ms-workspace/config/rules.json");
      expect(runtime.policyPath).toBe("/tmp/ms-workspace/config/policy.json");
      expect(runtime.lookbackWindow).toBe("2h");
      expect(runtime.defaultReminderDelay).toBe("6h");
      expect(runtime.digestInterval).toBe("12h");
      expect(runtime.imapInstanceId).toBe("ms-imap");
      expect(runtime.openclawUrl).toBe("http://localhost:9999");
      expect(runtime.llmModel).toBe("test-model");
      expect(runtime.llmTimeoutMs).toBe(1000);
      expect(runtime.imapConfigured).toBe(true);
      expect(runtime.openclawToken).toBe("gw-token");
      expect(runtime.matrix.roomId).toBe("!room:example");
      expect(runtime.matrix.accessToken).toBe("test-token");
    });

    it("uses default values when the tool config omits fields", async () => {
      const runtimeConfig = makeRuntimeConfig() as unknown as {
        sovereignTools: { instances: Array<{ id: string; config: Record<string, unknown> }> };
        openclawProfile: { agents: Array<{ id: string; workspace: string }> };
        openclaw: { runtimeConfigPath?: string };
      };
      runtimeConfig.sovereignTools.instances[0]!.config = { agentId: "mail-sentinel" };
      readFile
        .mockResolvedValueOnce(JSON.stringify(runtimeConfig))
        .mockRejectedValueOnce(new Error("no gateway runtime")); // openclaw runtime read fails
      const runtime = new MailSentinelRuntime("ms-core", "/tmp/config.json5");
      await runtime.load();
      expect(runtime.statePath).toBe("/tmp/ms-workspace/data/mail-sentinel-state.json");
      expect(runtime.lookbackWindow).toBe("1h");
      expect(runtime.defaultReminderDelay).toBe("4h");
      expect(runtime.digestInterval).toBe("12h");
      expect(runtime.openclawToken).toBeUndefined();
      expect(runtime.imapConfigured).toBe(true);
    });

    it("throws when the instance is not found", async () => {
      const runtimeConfig = makeRuntimeConfig();
      runtimeConfig.sovereignTools.instances = [];
      readFile.mockResolvedValueOnce(JSON.stringify(runtimeConfig));
      const runtime = new MailSentinelRuntime("missing", "/tmp/config.json5");
      await expect(runtime.load()).rejects.toThrow("Tool instance 'missing' was not found");
    });

    it("throws when sovereignTools is entirely missing", async () => {
      readFile.mockResolvedValueOnce(JSON.stringify({ openclawProfile: { agents: [] } }));
      const runtime = new MailSentinelRuntime("ms-core", "/tmp/config.json5");
      await expect(runtime.load()).rejects.toThrow("Tool instance 'ms-core' was not found");
    });

    it("throws when the tool has no config at all (uses defaults)", async () => {
      readFile.mockResolvedValueOnce(
        JSON.stringify({
          sovereignTools: { instances: [{ id: "ms-core" }] },
          openclawProfile: { agents: [] },
        }),
      );
      const runtime = new MailSentinelRuntime("ms-core", "/tmp/config.json5");
      await expect(runtime.load()).rejects.toThrow(
        "Mail Sentinel agent 'mail-sentinel' was not found",
      );
    });

    it("throws when openclawProfile is entirely missing", async () => {
      readFile.mockResolvedValueOnce(
        JSON.stringify({
          sovereignTools: { instances: [{ id: "ms-core", config: { agentId: "mail-sentinel" } }] },
        }),
      );
      const runtime = new MailSentinelRuntime("ms-core", "/tmp/config.json5");
      await expect(runtime.load()).rejects.toThrow(
        "Mail Sentinel agent 'mail-sentinel' was not found",
      );
    });

    it("throws when the agent is not found", async () => {
      const runtimeConfig = makeRuntimeConfig();
      runtimeConfig.openclawProfile.agents = [];
      readFile.mockResolvedValueOnce(JSON.stringify(runtimeConfig));
      const runtime = new MailSentinelRuntime("ms-core", "/tmp/config.json5");
      await expect(runtime.load()).rejects.toThrow(
        "Mail Sentinel agent 'mail-sentinel' was not found",
      );
    });

    it("treats imap.status=configured as imapConfigured when tool config omits the flag", async () => {
      const runtimeConfig = makeRuntimeConfig();
      const instance = runtimeConfig.sovereignTools.instances[0];
      if (instance?.config !== undefined) {
        delete (instance.config as Record<string, unknown>).imapConfigured;
      }
      readFile
        .mockResolvedValueOnce(JSON.stringify(runtimeConfig))
        .mockRejectedValueOnce(new Error("no runtime"));
      const runtime = new MailSentinelRuntime("ms-core", "/tmp/config.json5");
      await runtime.load();
      expect(runtime.imapConfigured).toBe(true);
    });

    it("falls back to DEFAULT_CONFIG_PATH and the SOVEREIGN_NODE_CONFIG env var", async () => {
      process.env.SOVEREIGN_NODE_CONFIG = "/env/config.json5";
      try {
        const runtime = new MailSentinelRuntime("ms-core");
        expect(runtime.configPath).toBe("/env/config.json5");
      } finally {
        delete process.env.SOVEREIGN_NODE_CONFIG;
      }
      const runtime = new MailSentinelRuntime("ms-core");
      expect(runtime.configPath).toBe("/etc/sovereign-node/sovereign-node.json5");
    });

    it("returns undefined gateway token when openclaw.runtimeConfigPath is missing", async () => {
      const runtimeConfig = makeRuntimeConfig() as unknown as {
        openclaw: Record<string, unknown>;
      };
      runtimeConfig.openclaw = {};
      readFile.mockResolvedValueOnce(JSON.stringify(runtimeConfig));
      const runtime = new MailSentinelRuntime("ms-core", "/tmp/config.json5");
      await runtime.load();
      expect(runtime.openclawToken).toBeUndefined();
    });

    it("returns undefined gateway token when the token field is not a string", async () => {
      const runtimeConfig = makeRuntimeConfig();
      readFile
        .mockResolvedValueOnce(JSON.stringify(runtimeConfig))
        .mockResolvedValueOnce(JSON.stringify({ gateway: { auth: { token: 42 } } }));
      const runtime = new MailSentinelRuntime("ms-core", "/tmp/config.json5");
      await runtime.load();
      expect(runtime.openclawToken).toBeUndefined();
    });
  });

  describe("readRules", () => {
    const loadRuntime = async () => {
      const runtimeConfig = makeRuntimeConfig();
      readFile
        .mockResolvedValueOnce(JSON.stringify(runtimeConfig))
        .mockRejectedValueOnce(new Error("no runtime"));
      const runtime = new MailSentinelRuntime("ms-core", "/tmp/config.json5");
      await runtime.load();
      return runtime;
    };

    it("parses a well-formed rules document", async () => {
      const runtime = await loadRuntime();
      readFile.mockResolvedValueOnce(
        JSON.stringify({
          version: 2,
          thresholds: { candidate: 3, alert: 4, category: 4 },
          zoneThresholds: {
            redMinConfidence: 75,
            amberMinConfidence: 40,
            redMinHeuristicScore: 4,
            amberMinHeuristicScore: 3,
          },
          defaultReminderDelay: "2h",
          senderWeights: { "a@b": 1 },
          domainWeights: { b: 1 },
          rules: [],
        }),
      );
      const rules = await runtime.readRules();
      expect(rules.thresholds.candidate).toBe(3);
      expect(rules.defaultReminderDelay).toBe("2h");
    });

    it("applies defaults when the rules document omits threshold fields", async () => {
      const runtime = await loadRuntime();
      readFile.mockResolvedValueOnce(JSON.stringify({}));
      const rules = await runtime.readRules();
      expect(rules.version).toBe(2);
      expect(rules.thresholds.candidate).toBe(3);
      expect(rules.zoneThresholds.redMinConfidence).toBe(75);
      expect(rules.defaultReminderDelay).toBeUndefined();
      expect(rules.senderWeights).toEqual({});
      expect(rules.rules).toEqual([]);
      expect(rules.bulk).toEqual({
        enabled: true,
        minSignals: 2,
        minLinks: 8,
        grayConfidence: 0.7,
      });
    });

    it("honours an explicit bulk config block", async () => {
      const runtime = await loadRuntime();
      readFile.mockResolvedValueOnce(
        JSON.stringify({
          bulk: { enabled: false, minSignals: 3, minLinks: 12, grayConfidence: 0.9 },
        }),
      );
      const rules = await runtime.readRules();
      expect(rules.bulk).toEqual({
        enabled: false,
        minSignals: 3,
        minLinks: 12,
        grayConfidence: 0.9,
      });
    });

    it("throws when the rules file is missing or invalid", async () => {
      const runtime = await loadRuntime();
      const error = Object.assign(new Error("not found"), { code: "ENOENT" });
      readFile.mockRejectedValueOnce(error);
      await expect(runtime.readRules()).rejects.toThrow("rules at");
    });
  });

  describe("runTool", () => {
    const loadRuntime = async () => {
      const runtimeConfig = makeRuntimeConfig();
      readFile
        .mockResolvedValueOnce(JSON.stringify(runtimeConfig))
        .mockRejectedValueOnce(new Error("no runtime"));
      const runtime = new MailSentinelRuntime("ms-core", "/tmp/config.json5");
      await runtime.load();
      return runtime;
    };

    it("wraps ok=true payloads and returns the result field", async () => {
      const runtime = await loadRuntime();
      const runner = vi.fn().mockResolvedValue({
        stdout: JSON.stringify({ ok: true, result: { hello: "world" } }),
        stderr: "",
      });
      const previous = setExecFileAsync(runner);
      try {
        await expect(runtime.runTool(["imap-search-mail"], ["--a", "b"])).resolves.toEqual({
          hello: "world",
        });
      } finally {
        setExecFileAsync(previous);
      }
    });

    it("returns the raw payload when ok is not true", async () => {
      const runtime = await loadRuntime();
      const runner = vi.fn().mockResolvedValue({ stdout: '{"messages": []}', stderr: "" });
      const previous = setExecFileAsync(runner);
      try {
        await expect(runtime.runTool(["imap-search-mail"], [])).resolves.toEqual({ messages: [] });
      } finally {
        setExecFileAsync(previous);
      }
    });

    it("throws a descriptive error when execFile rejects", async () => {
      const runtime = await loadRuntime();
      const runner = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("boom"), { stdout: "", stderr: "tool died" }));
      const previous = setExecFileAsync(runner);
      try {
        await expect(runtime.runTool(["imap-search-mail"], [])).rejects.toThrow(
          "imap-search-mail failed: tool died",
        );
      } finally {
        setExecFileAsync(previous);
      }
    });

    it("falls back to stdout when stderr is empty", async () => {
      const runtime = await loadRuntime();
      const runner = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("boom"), { stdout: "stdout-msg", stderr: "" }));
      const previous = setExecFileAsync(runner);
      try {
        await expect(runtime.runTool(["imap-search-mail"], [])).rejects.toThrow(
          "imap-search-mail failed: stdout-msg",
        );
      } finally {
        setExecFileAsync(previous);
      }
    });

    it("falls back to error.message when neither stdout nor stderr are strings", async () => {
      const runtime = await loadRuntime();
      const runner = vi.fn().mockRejectedValue(new Error("boom"));
      const previous = setExecFileAsync(runner);
      try {
        await expect(runtime.runTool(["imap-search-mail"], [])).rejects.toThrow(
          "imap-search-mail failed: boom",
        );
      } finally {
        setExecFileAsync(previous);
      }
    });

    it("uses DEFAULT_TOOL_EXECUTABLE when SOVEREIGN_TOOL_EXECUTABLE is unset", async () => {
      delete process.env.SOVEREIGN_TOOL_EXECUTABLE;
      const runtime = await loadRuntime();
      let capturedExecutable = "";
      const runner = vi.fn().mockImplementation((file) => {
        capturedExecutable = String(file);
        return Promise.resolve({ stdout: "{}", stderr: "" });
      });
      const previous = setExecFileAsync(runner);
      try {
        await runtime.runTool(["imap-search-mail"], []);
      } finally {
        setExecFileAsync(previous);
      }
      expect(capturedExecutable).toBe("/usr/local/bin/sovereign-tool");
    });
  });

  describe("searchMail and readMail", () => {
    it("delegates to runTool with the correct arguments", async () => {
      const runtimeConfig = makeRuntimeConfig();
      readFile
        .mockResolvedValueOnce(JSON.stringify(runtimeConfig))
        .mockRejectedValueOnce(new Error("no runtime"));
      const runtime = new MailSentinelRuntime("ms-core", "/tmp/config.json5");
      await runtime.load();
      const runner = vi.fn().mockResolvedValue({
        stdout: JSON.stringify({ ok: true, result: { messages: [] } }),
        stderr: "",
      });
      const previous = setExecFileAsync(runner);
      try {
        await runtime.searchMail(5);
        expect(runner.mock.calls[0]?.[1]).toContain("--limit");
        runner.mockResolvedValueOnce({
          stdout: JSON.stringify({ ok: true, result: { message: { uid: 1 } } }),
          stderr: "",
        });
        await runtime.readMail(42);
        expect(runner.mock.calls[1]?.[1]).toContain("--message-id");
      } finally {
        setExecFileAsync(previous);
      }
    });
  });

  describe("sendMatrixRoomMessage", () => {
    const loadRuntime = async () => {
      const runtimeConfig = makeRuntimeConfig();
      readFile
        .mockResolvedValueOnce(JSON.stringify(runtimeConfig))
        .mockRejectedValueOnce(new Error("no runtime"));
      const runtime = new MailSentinelRuntime("ms-core", "/tmp/config.json5");
      await runtime.load();
      return runtime;
    };

    it("posts a JSON body via fetch for a plain-text string message", async () => {
      const runtime = await loadRuntime();
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);
      try {
        await runtime.sendMatrixRoomMessage("hello world");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(String(url)).toContain("/_matrix/client/v3/rooms/");
        expect(init.method).toBe("PUT");
        const payload = JSON.parse(init.body);
        expect(payload.body).toBe("hello world");
        expect(payload.msgtype).toBe("m.text");
        expect(payload.format).toBeUndefined();
        expect(payload.formatted_body).toBeUndefined();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("posts an HTML-formatted body when given a MatrixMessageBody", async () => {
      const runtime = await loadRuntime();
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);
      try {
        await runtime.sendMatrixRoomMessage({
          body: "plain fallback",
          formattedBody: "<p><strong>HTML</strong></p>",
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const init = fetchMock.mock.calls[0]![1];
        const payload = JSON.parse(init.body);
        expect(payload.msgtype).toBe("m.text");
        expect(payload.body).toBe("plain fallback");
        expect(payload.format).toBe("org.matrix.custom.html");
        expect(payload.formatted_body).toBe("<p><strong>HTML</strong></p>");
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("throws if the Matrix admin base URL is missing", async () => {
      const runtime = await loadRuntime();
      runtime.matrix.adminBaseUrl = undefined;
      await expect(runtime.sendMatrixRoomMessage("hi")).rejects.toThrow(
        "Matrix admin base URL or room ID is not configured",
      );
    });

    it("throws on a non-ok response", async () => {
      const runtime = await loadRuntime();
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
      vi.stubGlobal("fetch", fetchMock);
      try {
        await expect(runtime.sendMatrixRoomMessage("hi")).rejects.toThrow(
          "Failed to send Matrix room message (503)",
        );
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe("classifyCandidate", () => {
    const loadRuntime = async () => {
      const runtimeConfig = makeRuntimeConfig();
      readFile
        .mockResolvedValueOnce(JSON.stringify(runtimeConfig))
        .mockRejectedValueOnce(new Error("no runtime"));
      const runtime = new MailSentinelRuntime("ms-core", "/tmp/config.json5");
      await runtime.load();
      return runtime;
    };

    const sampleCandidate = {
      subject: "s",
      from: "f",
      snippet: "x",
      threadContext: [],
      heuristicSignals: {
        candidateScore: 0,
        category: "decision-required",
        categoryScores: {},
        matchedRules: [],
        reasons: [],
      },
      policyHints: [],
      extractedSignals: { deadlineDetected: false, amountDetected: false, amount: null },
    };

    it("calls lobster and normalizes the JSON payload", async () => {
      const runtime = await loadRuntime();
      const runner = vi.fn().mockResolvedValue({
        stdout: JSON.stringify([
          {
            details: {
              json: {
                decision_required: true,
                financial_relevance: false,
                risk_escalation: false,
                confidence: 72,
                urgency: "medium",
                reason: "ok",
                deadline_detected: false,
                amount_detected: false,
                suggested_zone: "amber",
              },
            },
          },
        ]),
        stderr: "",
      });
      const previous = setExecFileAsync(runner);
      writeFile.mockResolvedValue(undefined);
      rm.mockResolvedValue(undefined);
      try {
        const result = await runtime.classifyCandidate(sampleCandidate);
        expect(result.decisionRequired).toBe(true);
        expect(result.confidence).toBe(72);
        expect(writeFile).toHaveBeenCalled();
        expect(rm).toHaveBeenCalled();
        expect(runner).toHaveBeenCalledTimes(1);
        const firstCall = runner.mock.calls[0];
        expect(firstCall).toBeDefined();
        const [executable, lobsterArgs] = firstCall as [string, readonly string[]];
        expect(executable).toBe("lobster");
        const pipeline = lobsterArgs[0];
        expect(pipeline).toContain('--session-key "agent:mail-sentinel:main"');
        expect(pipeline).toContain("--tool llm-task");
        expect(pipeline).toContain("--action json");
      } finally {
        setExecFileAsync(previous);
      }
    });

    it("throws when lobster returns no JSON payload", async () => {
      const runtime = await loadRuntime();
      const runner = vi.fn().mockResolvedValue({ stdout: "null", stderr: "" });
      const previous = setExecFileAsync(runner);
      writeFile.mockResolvedValue(undefined);
      rm.mockResolvedValue(undefined);
      try {
        await expect(runtime.classifyCandidate(sampleCandidate)).rejects.toThrow(
          "lobster classification returned no structured JSON payload",
        );
      } finally {
        setExecFileAsync(previous);
      }
    });

    it("handles classifyCandidate errors with stdout-only content", async () => {
      const runtimeConfig = makeRuntimeConfig();
      readFile
        .mockResolvedValueOnce(JSON.stringify(runtimeConfig))
        .mockRejectedValueOnce(new Error("no runtime"));
      const runtime = new MailSentinelRuntime("ms-core", "/tmp/config.json5");
      await runtime.load();
      const runner = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("boom"), { stdout: "stdout-only", stderr: "" }));
      const previous = setExecFileAsync(runner);
      writeFile.mockResolvedValue(undefined);
      rm.mockResolvedValue(undefined);
      try {
        await expect(runtime.classifyCandidate(sampleCandidate)).rejects.toThrow(
          "lobster classification failed: stdout-only",
        );
      } finally {
        setExecFileAsync(previous);
      }
    });

    it("handles classifyCandidate errors with neither stdout nor stderr as strings", async () => {
      const runtimeConfig = makeRuntimeConfig();
      readFile
        .mockResolvedValueOnce(JSON.stringify(runtimeConfig))
        .mockRejectedValueOnce(new Error("no runtime"));
      const runtime = new MailSentinelRuntime("ms-core", "/tmp/config.json5");
      await runtime.load();
      const runner = vi.fn().mockRejectedValue(new Error("plain error"));
      const previous = setExecFileAsync(runner);
      writeFile.mockResolvedValue(undefined);
      rm.mockResolvedValue(undefined);
      try {
        await expect(runtime.classifyCandidate(sampleCandidate)).rejects.toThrow(
          "lobster classification failed: plain error",
        );
      } finally {
        setExecFileAsync(previous);
      }
    });

    it("handles output.data fallback branch", async () => {
      const runtimeConfig = makeRuntimeConfig();
      readFile
        .mockResolvedValueOnce(JSON.stringify(runtimeConfig))
        .mockRejectedValueOnce(new Error("no runtime"));
      const runtime = new MailSentinelRuntime("ms-core", "/tmp/config.json5");
      await runtime.load();
      const runner = vi.fn().mockResolvedValue({
        stdout: JSON.stringify([
          {
            output: {
              data: {
                decision_required: true,
                financial_relevance: false,
                risk_escalation: false,
                confidence: 60,
                urgency: "medium",
                reason: "via output.data",
                deadline_detected: false,
                amount_detected: false,
                suggested_zone: "amber",
              },
            },
          },
        ]),
        stderr: "",
      });
      const previous = setExecFileAsync(runner);
      writeFile.mockResolvedValue(undefined);
      rm.mockResolvedValue(undefined);
      try {
        const result = await runtime.classifyCandidate(sampleCandidate);
        expect(result.reason).toBe("via output.data");
      } finally {
        setExecFileAsync(previous);
      }
    });

    it("handles top-level .data fallback branch", async () => {
      const runtimeConfig = makeRuntimeConfig();
      readFile
        .mockResolvedValueOnce(JSON.stringify(runtimeConfig))
        .mockRejectedValueOnce(new Error("no runtime"));
      const runtime = new MailSentinelRuntime("ms-core", "/tmp/config.json5");
      await runtime.load();
      const runner = vi.fn().mockResolvedValue({
        stdout: JSON.stringify([
          {
            data: {
              decision_required: false,
              financial_relevance: false,
              risk_escalation: false,
              confidence: 30,
              urgency: "low",
              reason: "via top-level data",
              deadline_detected: false,
              amount_detected: false,
              suggested_zone: "gray",
            },
          },
        ]),
        stderr: "",
      });
      const previous = setExecFileAsync(runner);
      writeFile.mockResolvedValue(undefined);
      rm.mockResolvedValue(undefined);
      try {
        const result = await runtime.classifyCandidate(sampleCandidate);
        expect(result.reason).toBe("via top-level data");
      } finally {
        setExecFileAsync(previous);
      }
    });

    it("surfaces lobster execFile errors with context", async () => {
      const runtime = await loadRuntime();
      const runner = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("boom"), { stdout: "", stderr: "crashed" }));
      const previous = setExecFileAsync(runner);
      writeFile.mockResolvedValue(undefined);
      rm.mockResolvedValue(undefined);
      try {
        await expect(runtime.classifyCandidate(sampleCandidate)).rejects.toThrow(
          "lobster classification failed: crashed",
        );
      } finally {
        setExecFileAsync(previous);
      }
    });

    it("retries after a transient failure and returns the successful result", async () => {
      const runtime = await loadRuntime();
      const runner = vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error("boom"), { stdout: "", stderr: "transient 502" }),
        )
        .mockResolvedValueOnce({
          stdout: JSON.stringify([
            {
              details: {
                json: {
                  decision_required: false,
                  financial_relevance: false,
                  risk_escalation: false,
                  confidence: 50,
                  urgency: "low",
                  reason: "recovered",
                  deadline_detected: false,
                  amount_detected: false,
                  suggested_zone: "gray",
                },
              },
            },
          ]),
          stderr: "",
        });
      const previous = setExecFileAsync(runner);
      writeFile.mockResolvedValue(undefined);
      rm.mockResolvedValue(undefined);
      try {
        const result = await runtime.classifyCandidate(sampleCandidate);
        expect(result.reason).toBe("recovered");
        expect(runner).toHaveBeenCalledTimes(2);
        expect(rm).toHaveBeenCalledTimes(1);
      } finally {
        setExecFileAsync(previous);
      }
    });

    it("gives up after the retry budget is exhausted and surfaces the last error", async () => {
      const runtime = await loadRuntime();
      const runner = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("boom"), { stdout: "", stderr: "upstream down" }),
        );
      const previous = setExecFileAsync(runner);
      writeFile.mockResolvedValue(undefined);
      rm.mockResolvedValue(undefined);
      try {
        await expect(runtime.classifyCandidate(sampleCandidate)).rejects.toThrow(
          "lobster classification failed: upstream down",
        );
        expect(runner).toHaveBeenCalledTimes(3);
      } finally {
        setExecFileAsync(previous);
      }
    });
  });

  it("resolveToolRuntime returns a loaded runtime", async () => {
    const runtimeConfig = makeRuntimeConfig();
    readFile
      .mockResolvedValueOnce(JSON.stringify(runtimeConfig))
      .mockRejectedValueOnce(new Error("no runtime"));
    const runtime = await resolveToolRuntime("ms-core", "/tmp/config.json5");
    expect(runtime.instanceId).toBe("ms-core");
    expect(runtime.statePath).toContain("state.json");
  });

  describe("policy/state IO methods", () => {
    const loadRuntime = async () => {
      const runtimeConfig = makeRuntimeConfig();
      readFile
        .mockResolvedValueOnce(JSON.stringify(runtimeConfig))
        .mockRejectedValueOnce(new Error("no runtime"));
      const runtime = new MailSentinelRuntime("ms-core", "/tmp/config.json5");
      await runtime.load();
      return runtime;
    };

    it("readPolicy returns a normalized default policy when the file is missing", async () => {
      const runtime = await loadRuntime();
      readFile.mockRejectedValueOnce(Object.assign(new Error("nf"), { code: "ENOENT" }));
      const policy = await runtime.readPolicy();
      expect(policy.senderPolicies).toEqual([]);
    });

    it("writePolicy persists the normalized policy", async () => {
      const runtime = await loadRuntime();
      writeFile.mockResolvedValueOnce(undefined);
      await runtime.writePolicy({
        version: 1,
        senderPolicies: [{ id: "p1", match: "a@b" }],
        domainPolicies: [],
        receiverPolicies: [],
        categoryPolicies: [],
        contentPolicies: [],
        timePolicies: [],
        mutePolicies: [],
      });
      expect(writeFile).toHaveBeenCalled();
      const [_tempPath, payload] = writeFile.mock.calls[0]!;
      expect(String(payload)).toContain("senderPolicies");
    });

    it("readState migrates a missing-state to defaults", async () => {
      const runtime = await loadRuntime();
      readFile.mockRejectedValueOnce(Object.assign(new Error("nf"), { code: "ENOENT" }));
      const state = await runtime.readState();
      expect(state.version).toBe(2);
      expect(state.messages).toEqual({});
    });

    it("writeState calls writeJsonFile with pruned migrated state", async () => {
      const runtime = await loadRuntime();
      writeFile.mockResolvedValueOnce(undefined);
      await runtime.writeState({
        version: 2,
        consecutiveFailures: 0,
        mailbox: {},
        messages: {},
        alerts: [],
        feedback: [],
        learning: { senderWeights: {}, domainWeights: {}, ruleAdjustments: {} },
        digest: { pendingAmber: [] },
        zoneHistory: [],
      });
      expect(writeFile).toHaveBeenCalled();
    });
  });

  describe("classifyCandidate additional shapes", () => {
    const loadRuntime = async () => {
      const runtimeConfig = makeRuntimeConfig();
      readFile
        .mockResolvedValueOnce(JSON.stringify(runtimeConfig))
        .mockRejectedValueOnce(new Error("no runtime"));
      const runtime = new MailSentinelRuntime("ms-core", "/tmp/config.json5");
      await runtime.load();
      return runtime;
    };

    const sampleCandidate = {
      subject: "s",
      from: "f",
      snippet: "x",
      threadContext: [],
      heuristicSignals: {
        candidateScore: 0,
        category: "decision-required",
        categoryScores: {},
        matchedRules: [],
        reasons: [],
      },
      policyHints: [],
      extractedSignals: { deadlineDetected: false, amountDetected: false, amount: null },
    };

    it("sets CLAWD_TOKEN in the environment when openclawToken is defined", async () => {
      const runtime = await loadRuntime();
      runtime.openclawToken = "gw-token";
      let capturedEnv: Record<string, string | undefined> | undefined;
      const runner = vi.fn().mockImplementation((_file, _args, options) => {
        capturedEnv = options?.env as Record<string, string | undefined>;
        return Promise.resolve({
          stdout: JSON.stringify([
            {
              output: {
                data: {
                  decision_required: false,
                  financial_relevance: false,
                  risk_escalation: false,
                  confidence: 10,
                  urgency: "low",
                  reason: "x",
                  deadline_detected: false,
                  amount_detected: false,
                  suggested_zone: "gray",
                },
              },
            },
          ]),
          stderr: "",
        });
      });
      const previous = setExecFileAsync(runner);
      writeFile.mockResolvedValue(undefined);
      rm.mockResolvedValue(undefined);
      try {
        await runtime.classifyCandidate(sampleCandidate);
      } finally {
        setExecFileAsync(previous);
      }
      expect(capturedEnv?.CLAWD_TOKEN).toBe("gw-token");
    });

    it("handles the output.text JSON fallback branch", async () => {
      const runtime = await loadRuntime();
      const runner = vi.fn().mockResolvedValue({
        stdout: JSON.stringify([
          {
            output: {
              text: JSON.stringify({
                decision_required: true,
                financial_relevance: false,
                risk_escalation: false,
                confidence: 50,
                urgency: "medium",
                reason: "via text",
                deadline_detected: false,
                amount_detected: false,
                suggested_zone: "amber",
              }),
            },
          },
        ]),
        stderr: "",
      });
      const previous = setExecFileAsync(runner);
      writeFile.mockResolvedValue(undefined);
      rm.mockResolvedValue(undefined);
      try {
        const result = await runtime.classifyCandidate(sampleCandidate);
        expect(result.reason).toBe("via text");
      } finally {
        setExecFileAsync(previous);
      }
    });

    it("handles lobster errors that surface only via stdout", async () => {
      const runtime = await loadRuntime();
      const runner = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("boom"), { stdout: "stdout-info", stderr: "" }));
      const previous = setExecFileAsync(runner);
      writeFile.mockResolvedValue(undefined);
      rm.mockResolvedValue(undefined);
      try {
        await expect(runtime.classifyCandidate(sampleCandidate)).rejects.toThrow(
          "lobster classification failed: stdout-info",
        );
      } finally {
        setExecFileAsync(previous);
      }
    });
  });
});
