import { afterEach, describe, expect, it, vi } from "vitest";

const commandMocks = vi.hoisted(() => ({
  wishAdd: vi.fn(),
  wishList: vi.fn(),
  wishShow: vi.fn(),
  wishArchive: vi.fn(),
  wishComplete: vi.fn(),
  wishPause: vi.fn(),
  checkinAdd: vi.fn(),
  checkinList: vi.fn(),
  checkinLatest: vi.fn(),
  resistanceAdd: vi.fn(),
  resistanceList: vi.fn(),
  resistanceResolve: vi.fn(),
  stepNext: vi.fn(),
  stepList: vi.fn(),
  stepComplete: vi.fn(),
  reviewWeekly: vi.fn(),
}));

vi.mock("./commands.js", () => commandMocks);

const { isMainModule, reportError, runCli } = await import("./cli.js");

describe("reality-alignment/cli", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const mock of Object.values(commandMocks)) {
      mock.mockReset();
    }
    process.exitCode = 0;
  });

  it("dispatches every wish, checkin, resistance, step, and review subcommand", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const wish = {
      id: "w1",
      title: "Ship",
      status: "active" as const,
      createdAt: "2026-04-26T10:00:00.000Z",
      updatedAt: "2026-04-26T10:00:00.000Z",
    };
    const checkin = {
      id: "c1",
      date: "2026-04-26",
      energyScore: 3,
      clarityScore: 3,
      congruenceScore: 3,
      resistanceScore: 3,
      linkedWishIds: [],
      createdAt: "2026-04-26T10:00:00.000Z",
    };
    const pattern = {
      id: "r1",
      label: "delay",
      linkedWishIds: [],
      recurrenceCount: 1,
      lastSeenAt: "2026-04-26T10:00:00.000Z",
      status: "active" as const,
    };
    const step = {
      id: "s1",
      title: "Do it",
      linkedWishId: "w1",
      status: "open" as const,
      createdAt: "2026-04-26T10:00:00.000Z",
    };
    commandMocks.wishAdd.mockResolvedValue({ instanceId: "core", wish });
    commandMocks.wishList.mockResolvedValue({ instanceId: "core", wishes: [wish] });
    commandMocks.wishShow.mockResolvedValue({ instanceId: "core", wish });
    commandMocks.wishArchive.mockResolvedValue({ instanceId: "core", wish });
    commandMocks.wishComplete.mockResolvedValue({ instanceId: "core", wish });
    commandMocks.wishPause.mockResolvedValue({ instanceId: "core", wish });
    commandMocks.checkinAdd.mockResolvedValue({ instanceId: "core", checkin });
    commandMocks.checkinList.mockResolvedValue({ instanceId: "core", checkins: [checkin] });
    commandMocks.checkinLatest.mockResolvedValue({ instanceId: "core", checkin });
    commandMocks.resistanceAdd.mockResolvedValue({ instanceId: "core", pattern, created: true });
    commandMocks.resistanceList.mockResolvedValue({ instanceId: "core", resistance: [pattern] });
    commandMocks.resistanceResolve.mockResolvedValue({ instanceId: "core", pattern });
    commandMocks.stepNext.mockResolvedValue({ instanceId: "core", step, wish });
    commandMocks.stepList.mockResolvedValue({ instanceId: "core", steps: [step] });
    commandMocks.stepComplete.mockResolvedValue({ instanceId: "core", step });
    commandMocks.reviewWeekly.mockResolvedValue({
      instanceId: "core",
      review: {},
      formatted: "REVIEW",
    });
    const baseArgs = ["--instance", "core"];
    await runCli(["wish", "add", ...baseArgs, "--title", "x"]);
    await runCli(["wish", "list", ...baseArgs]);
    await runCli(["wish", "show", ...baseArgs, "--query", "x"]);
    await runCli(["wish", "archive", ...baseArgs, "--query", "x"]);
    await runCli(["wish", "complete", ...baseArgs, "--query", "x"]);
    await runCli(["wish", "pause", ...baseArgs, "--query", "x"]);
    await runCli([
      "checkin",
      "add",
      ...baseArgs,
      "--energy",
      "3",
      "--clarity",
      "3",
      "--congruence",
      "3",
      "--resistance",
      "3",
    ]);
    await runCli(["checkin", "list", ...baseArgs]);
    await runCli(["checkin", "latest", ...baseArgs]);
    await runCli(["resistance", "add", ...baseArgs, "--label", "x"]);
    await runCli(["resistance", "list", ...baseArgs]);
    await runCli(["resistance", "resolve", ...baseArgs, "--query", "x"]);
    await runCli(["step", "next", ...baseArgs]);
    await runCli(["step", "list", ...baseArgs]);
    await runCli(["step", "complete", ...baseArgs, "--query", "x"]);
    await runCli(["review", "weekly", ...baseArgs]);

    for (const [, mock] of Object.entries(commandMocks)) {
      expect(mock).toHaveBeenCalled();
    }
    expect(writeSpy).toHaveBeenCalled();
  });

  it("validates command and subcommand usage", async () => {
    await expect(runCli([])).rejects.toThrow("Expected a command");
    await expect(runCli(["unknown"])).rejects.toThrow("Unknown command: unknown");
    await expect(runCli(["wish"])).rejects.toThrow("Expected a wish subcommand");
    await expect(runCli(["wish", "bogus", "--instance", "core"])).rejects.toThrow(
      "Unknown wish subcommand: bogus",
    );
    await expect(runCli(["checkin", "bogus", "--instance", "core"])).rejects.toThrow(
      "Unknown checkin subcommand: bogus",
    );
    await expect(runCli(["resistance", "bogus", "--instance", "core"])).rejects.toThrow(
      "Unknown resistance subcommand: bogus",
    );
    await expect(runCli(["step", "bogus", "--instance", "core"])).rejects.toThrow(
      "Unknown step subcommand: bogus",
    );
    await expect(runCli(["review", "bogus", "--instance", "core"])).rejects.toThrow(
      "Unknown review subcommand: bogus",
    );
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
    const original = process.argv[1];
    process.argv[1] = undefined as unknown as string;
    expect(isMainModule()).toBe(false);
    process.argv[1] = "/tmp/not-main.js";
    expect(isMainModule()).toBe(false);
    process.argv[1] = original ?? "/tmp/restore.js";
  });
});
