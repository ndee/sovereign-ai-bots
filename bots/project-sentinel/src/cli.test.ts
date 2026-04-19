import { afterEach, describe, expect, it, vi } from "vitest";

const commandMocks = vi.hoisted(() => ({
  scan: vi.fn(),
  digest: vi.fn(),
  status: vi.fn(),
  sources: vi.fn(),
  applyFeedback: vi.fn(),
}));

vi.mock("./commands.js", () => commandMocks);

const { isMainModule, reportError, runCli } = await import("./cli.js");

describe("project-sentinel/cli", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it("dispatches supported commands", async () => {
    commandMocks.scan.mockResolvedValueOnce({
      configured: false,
      note: "No active Project Sentinel project profiles are enabled.",
      processedSources: 0,
      processedSignals: 0,
      newSignals: 0,
      redAlertsSent: 0,
      amberQueued: 0,
      digestsSent: 0,
      alerts: [],
    });
    commandMocks.status.mockResolvedValueOnce({
      configured: true,
      activeProfiles: 1,
      enabledSources: 2,
      trackedSignals: 1,
      pendingAmber: 0,
    });
    commandMocks.digest.mockResolvedValueOnce({ alerts: [] });
    commandMocks.sources.mockResolvedValueOnce({
      note: "Project Sentinel source openclaw-issues disabled.",
      sources: [],
    });
    commandMocks.applyFeedback.mockResolvedValueOnce({
      note: "Policy updated locally.",
      signalId: "sig-1",
    });
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runCli(["scan", "--instance", "project-sentinel-core"]);
    await runCli(["digest", "--instance", "project-sentinel-core"]);
    await runCli(["status", "--instance", "project-sentinel-core"]);
    await runCli([
      "sources",
      "disable",
      "--instance",
      "project-sentinel-core",
      "--id",
      "openclaw-issues",
    ]);
    await runCli([
      "feedback",
      "--instance",
      "project-sentinel-core",
      "--signal-id",
      "sig-1",
      "--action",
      "always-alert",
    ]);

    expect(commandMocks.scan).toHaveBeenCalledWith({
      json: false,
      instance: "project-sentinel-core",
    });
    expect(commandMocks.digest).toHaveBeenCalledWith({
      json: false,
      instance: "project-sentinel-core",
    });
    expect(commandMocks.status).toHaveBeenCalledWith({
      json: false,
      instance: "project-sentinel-core",
    });
    expect(commandMocks.sources).toHaveBeenCalledWith({
      json: false,
      subcommand: "disable",
      instance: "project-sentinel-core",
      id: "openclaw-issues",
    });
    expect(commandMocks.applyFeedback).toHaveBeenCalledWith({
      json: false,
      instance: "project-sentinel-core",
      signalId: "sig-1",
      action: "always-alert",
    });
    expect(writeSpy).toHaveBeenCalled();
  });

  it("validates feedback and command usage", async () => {
    await expect(runCli([])).rejects.toThrow("Expected a command");
    await expect(runCli(["scan"])).rejects.toThrow("Expected --instance <id>");
    await expect(runCli(["unknown", "--instance", "project-sentinel-core"])).rejects.toThrow(
      "Unknown command: unknown",
    );
    await expect(
      runCli(["feedback", "--instance", "project-sentinel-core", "--latest"]),
    ).rejects.toThrow("Expected --action");
    await expect(
      runCli([
        "feedback",
        "--instance",
        "project-sentinel-core",
        "--latest",
        "--signal-id",
        "sig-1",
        "--action",
        "always-alert",
      ]),
    ).rejects.toThrow("Use either --latest or --signal-id");
  });

  it("reports errors in plain text and json modes and detects main module state", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    reportError(new Error("boom"), ["--json"]);
    reportError(new Error("boom"), []);
    reportError("string-error", []);

    expect(stdoutSpy).toHaveBeenCalledWith(
      '{\n  "ok": false,\n  "error": {\n    "message": "boom"\n  }\n}\n',
    );
    expect(stderrSpy).toHaveBeenCalledWith("boom\n");
    expect(stderrSpy).toHaveBeenCalledWith("string-error\n");
    const originalArgv1 = process.argv[1];
    process.argv[1] = undefined as unknown as string;
    expect(isMainModule()).toBe(false);
    process.argv[1] = "/tmp/not-main.js";
    expect(isMainModule()).toBe(false);
    process.argv[1] = originalArgv1 ?? "/tmp/original-main.js";
  });
});
