import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getFakeRuntime, resetFakeRuntime } from "../__fixtures__/fake-runtime.js";

vi.mock("../config/runtime.js", () => ({
  resolveToolRuntime: async () => getFakeRuntime(),
}));

const { digest } = await import("./digest.js");

const FIXED_NOW = new Date("2026-04-08T12:00:00.000Z");

describe("commands/digest", () => {
  beforeEach(() => {
    resetFakeRuntime();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("requires an instance id", async () => {
    await expect(digest({})).rejects.toThrow("Expected --instance <id>");
  });

  it("returns the queued amber alerts from state.digest.pendingAmber", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = [
      {
        alertId: "a1",
        zone: "amber",
        category: "financial-relevance",
        subject: "s",
        from: "a@b",
        why: "w",
        sentAt: "2026-04-08T09:00:00Z",
      },
    ];
    runtime.state.digest.pendingAmber = ["a1"];
    const result = await digest({ instance: "ms-core" });
    expect(result.count).toBe(1);
    expect(result.alerts[0]?.alertId).toBe("a1");
  });

  it("falls back to today's amber alerts when the queue is empty", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = [
      {
        alertId: "today-amber",
        zone: "amber",
        category: "financial-relevance",
        subject: "s",
        from: "a@b",
        why: "w",
        sentAt: "2026-04-08T09:00:00Z",
      },
      {
        alertId: "old-amber",
        zone: "amber",
        category: "financial-relevance",
        subject: "s",
        from: "a@b",
        why: "w",
        sentAt: "2026-04-01T09:00:00Z",
      },
    ];
    const result = await digest({ instance: "ms-core" });
    expect(result.count).toBe(1);
    expect(result.alerts[0]?.alertId).toBe("today-amber");
  });

  it("respects the --limit flag", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = Array.from({ length: 6 }, (_, i) => ({
      alertId: `a${i}`,
      zone: "amber" as const,
      category: "financial-relevance" as const,
      subject: `s${i}`,
      from: "a@b",
      why: "w",
      sentAt: "2026-04-08T09:00:00Z",
    }));
    runtime.state.digest.pendingAmber = runtime.state.alerts.map((a) => a.alertId);
    const result = await digest({ instance: "ms-core", limit: "3" });
    expect(result.count).toBe(3);
  });
});
