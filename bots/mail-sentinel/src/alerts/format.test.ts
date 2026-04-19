import { describe, expect, it, vi } from "vitest";
import { sampleAlert } from "../__fixtures__/inputs.js";
import { loadGolden, normalizeUuids } from "../__fixtures__/load.js";
import type { StoredAlert } from "../types.js";
import {
  buildDigestMessage,
  buildRedAlertMessage,
  formatAlertLine,
  mapAlertToSummary,
} from "./format.js";

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    randomUUID: () => "00000000-0000-0000-0000-000000000000",
  };
});

describe("alerts/format", () => {
  it("matches the formatAlertLine golden fixture", () => {
    expect(formatAlertLine(sampleAlert)).toBe(loadGolden("formatAlertLine"));
  });

  it("falls back to the raw category label when unknown", () => {
    expect(
      formatAlertLine({ ...sampleAlert, category: "mystery-category" as StoredAlert["category"] }),
    ).toContain("mystery-category");
  });

  it("matches the mapAlertToSummary new/reminder/feedback fixtures", () => {
    expect(mapAlertToSummary(sampleAlert, "new-alert")).toEqual(
      loadGolden("mapAlertToSummary.new"),
    );
    expect(
      mapAlertToSummary({ ...sampleAlert, lastReminderAt: "2026-04-08T12:00:00Z" }, "reminder"),
    ).toEqual(loadGolden("mapAlertToSummary.reminder"));
    expect(mapAlertToSummary({ ...sampleAlert, feedbackState: "important" })).toEqual(
      loadGolden("mapAlertToSummary.feedbackResolved"),
    );
  });

  it("omits confidence when it is not a number", () => {
    const summary = mapAlertToSummary({
      ...sampleAlert,
      confidence: undefined,
    });
    expect(summary.confidence).toBeUndefined();
  });

  it("matches the buildRedAlertMessage golden fixtures", () => {
    expect(buildRedAlertMessage(sampleAlert, "new-alert")).toBe(
      loadGolden("buildRedAlertMessage.alert"),
    );
    expect(buildRedAlertMessage({ ...sampleAlert, messageId: undefined }, "reminder")).toBe(
      loadGolden("buildRedAlertMessage.reminder"),
    );
  });

  it("matches the buildDigestMessage few-alerts golden fixture", () => {
    const message = buildDigestMessage(
      [
        { ...sampleAlert, alertId: "a1", zone: "amber" },
        { ...sampleAlert, alertId: "a2", zone: "amber", subject: "Invoice $600" },
      ],
      "12h",
      "2026-04-08T12:00:00.000Z",
    );
    expect(normalizeUuids(message)).toBe(loadGolden("buildDigestMessage.few"));
  });

  it("falls back to 'RED' when zone is undefined in formatAlertLine", () => {
    const line = formatAlertLine({
      alertId: "a",
      zone: undefined as unknown as "red",
      category: "financial-relevance",
      from: "a@b",
      subject: "s",
    });
    expect(line).toContain("RED");
  });

  it("falls back to 'RED' when zone is undefined in buildRedAlertMessage", () => {
    const msg = buildRedAlertMessage(
      { ...sampleAlert, zone: undefined as unknown as "red" },
      "new-alert",
    );
    expect(msg).toContain("RED · ");
  });

  it("falls back to sentAt for reminders without a lastReminderAt", () => {
    const summary = mapAlertToSummary({ ...sampleAlert, lastReminderAt: undefined }, "reminder");
    expect(summary.sentAt).toBe(sampleAlert.sentAt);
  });

  it("uses raw category label in buildRedAlertMessage when unknown", () => {
    const msg = buildRedAlertMessage(
      { ...sampleAlert, category: "mystery" as unknown as "financial-relevance" },
      "new-alert",
    );
    expect(msg).toContain("· mystery");
  });

  it("uses raw category label in buildDigestMessage when unknown", () => {
    const msg = buildDigestMessage(
      [{ ...sampleAlert, category: "mystery" as unknown as "financial-relevance" }],
      "12h",
      "2026-04-08T12:00:00.000Z",
    );
    expect(msg).toContain("mystery");
  });

  it("matches the buildDigestMessage many-alerts golden fixture", () => {
    const message = buildDigestMessage(
      Array.from({ length: 12 }, (_, i) => ({
        ...sampleAlert,
        alertId: `a${i}`,
        subject: `Invoice #${i}`,
      })),
      "12h",
      "2026-04-08T12:00:00.000Z",
    );
    expect(normalizeUuids(message)).toBe(loadGolden("buildDigestMessage.many"));
  });
});
