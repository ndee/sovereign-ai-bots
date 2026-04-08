import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadGolden } from "../__fixtures__/load.js";
import {
  clampLimit,
  formatConfidenceLabel,
  isSameLocalDay,
  nowIso,
  parseDurationMs,
  sortAlertsNewestFirst,
  startOfLocalDay,
} from "./time.js";

const FIXED_NOW = new Date("2026-04-08T12:00:00.000Z");

describe("util/time", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches the parseDurationMs golden fixture", () => {
    const golden = loadGolden<Record<string, unknown>>("parseDurationMs");
    expect({
      minutes: parseDurationMs("30m"),
      hours: parseDurationMs("2h"),
      days: parseDurationMs("1d"),
      longForm: parseDurationMs("15 minutes"),
      zeroHours: parseDurationMs("0h"),
    }).toEqual(golden);
  });

  it("throws on unsupported duration strings matching the error fixture", () => {
    const golden = loadGolden<{ message: string }>("parseDurationMs.error");
    expect(() => parseDurationMs("invalid")).toThrow(golden.message);
  });

  it("treats an out-of-range numeric amount correctly (synthetic guard)", () => {
    // parseDurationMs uses parseInt; leading zeros / large strings still work
    expect(parseDurationMs("00030 minutes")).toBe(30 * 60 * 1000);
  });

  it("matches the clampLimit golden fixture", () => {
    const golden = loadGolden<Record<string, unknown>>("clampLimit");
    expect({
      undef: clampLimit(undefined, 20),
      under: clampLimit(5, 20),
      over: clampLimit(100, 20),
      equal: clampLimit(20, 20),
      stringInput: clampLimit("7", 20),
    }).toEqual(golden);
  });

  it("matches the clampLimit zero error fixture", () => {
    const golden = loadGolden<{ message: string }>("clampLimit.zero");
    expect(() => clampLimit("0", 20)).toThrow(golden.message);
  });

  it("matches the clampLimit non-numeric error fixture", () => {
    const golden = loadGolden<{ message: string }>("clampLimit.nonNumeric");
    expect(() => clampLimit("abc", 20)).toThrow(golden.message);
  });

  it("matches the startOfLocalDay golden fixture", () => {
    const golden = loadGolden<Record<string, number>>("startOfLocalDay");
    expect({
      iso: startOfLocalDay("2026-04-08T12:34:56.000Z"),
      midnight: startOfLocalDay(FIXED_NOW),
    }).toEqual(golden);
  });

  it("matches the isSameLocalDay golden fixture", () => {
    const golden = loadGolden<Record<string, boolean>>("isSameLocalDay");
    expect({
      sameDay: isSameLocalDay("2026-04-08T08:00:00.000Z", FIXED_NOW),
      differentDay: isSameLocalDay("2026-04-07T08:00:00.000Z", FIXED_NOW),
      invalid: isSameLocalDay("not-a-date", FIXED_NOW),
    }).toEqual(golden);
  });

  it("matches the formatConfidenceLabel golden fixture", () => {
    const golden = loadGolden<Record<string, string>>("formatConfidenceLabel");
    expect({
      high: formatConfidenceLabel(85),
      medium: formatConfidenceLabel(50),
      low: formatConfidenceLabel(10),
      undef: formatConfidenceLabel(undefined),
    }).toEqual(golden);
  });

  it("matches the sortAlertsNewestFirst golden fixture", () => {
    const golden = loadGolden<Record<string, unknown>>("sortAlertsNewestFirst");
    expect({
      empty: sortAlertsNewestFirst([]),
      sorted: sortAlertsNewestFirst([
        { sentAt: "2026-04-08T10:00:00Z" },
        { sentAt: "2026-04-08T12:00:00Z" },
        { sentAt: "2026-04-08T11:00:00Z" },
      ]),
    }).toEqual({
      empty: golden.empty,
      sorted: (golden.sorted as Array<Record<string, unknown>>).map((entry) => ({
        sentAt: entry.sentAt,
      })),
    });
  });

  it("nowIso returns the frozen time", () => {
    expect(nowIso()).toBe("2026-04-08T12:00:00.000Z");
  });
});
