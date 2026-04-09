import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getFakeRuntime, resetFakeRuntime } from "../__fixtures__/fake-runtime.js";

vi.mock("../config/runtime.js", () => ({
  resolveToolRuntime: async () => getFakeRuntime(),
}));

const { listAlerts } = await import("./list-alerts.js");

const FIXED_NOW = new Date("2026-04-08T12:00:00.000Z");

describe("commands/list-alerts", () => {
  beforeEach(() => {
    resetFakeRuntime();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("requires an instance id", async () => {
    await expect(listAlerts({})).rejects.toThrow("Expected --instance <id>");
  });

  it("returns alerts from today in the 'today' view", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = [
      {
        alertId: "today-1",
        zone: "amber",
        category: "financial-relevance",
        subject: "today alert",
        from: "a@b",
        why: "why",
        sentAt: "2026-04-08T09:00:00.000Z",
      },
      {
        alertId: "yesterday-1",
        zone: "red",
        category: "financial-relevance",
        subject: "old alert",
        from: "a@b",
        why: "why",
        sentAt: "2026-04-07T09:00:00.000Z",
      },
      {
        alertId: "gray-1",
        zone: "gray",
        category: "financial-relevance",
        subject: "gray",
        from: "a@b",
        why: "why",
        sentAt: "2026-04-08T10:00:00.000Z",
      },
    ];
    const result = await listAlerts({ instance: "ms-core", view: "today" });
    expect(result.count).toBe(1);
    expect(result.alerts[0]?.alertId).toBe("today-1");
  });

  it("returns all non-gray alerts in the 'recent' view", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = [
      {
        alertId: "today-1",
        zone: "amber",
        category: "financial-relevance",
        subject: "today",
        from: "a@b",
        why: "why",
        sentAt: "2026-04-08T09:00:00.000Z",
      },
      {
        alertId: "yesterday-1",
        zone: "red",
        category: "financial-relevance",
        subject: "old",
        from: "a@b",
        why: "why",
        sentAt: "2026-04-07T09:00:00.000Z",
      },
    ];
    const result = await listAlerts({ instance: "ms-core", view: "recent" });
    expect(result.count).toBe(2);
  });

  it("clamps the result count via --limit", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = Array.from({ length: 25 }, (_, i) => ({
      alertId: `a${i}`,
      zone: "amber" as const,
      category: "financial-relevance" as const,
      subject: `subj ${i}`,
      from: "a@b",
      why: "why",
      sentAt: "2026-04-08T09:00:00.000Z",
    }));
    const result = await listAlerts({ instance: "ms-core", view: "recent", limit: "5" });
    expect(result.count).toBe(5);
  });

  it("defaults the view to 'today' when unset", async () => {
    const result = await listAlerts({ instance: "ms-core" });
    expect(result.view).toBe("today");
  });
});
