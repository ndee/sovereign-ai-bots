import { describe, expect, it } from "vitest";
import { sampleAlert } from "../__fixtures__/inputs.js";
import { loadGolden } from "../__fixtures__/load.js";
import type { StoredAlert } from "../types.js";
import {
  buildDigestMessage,
  buildRedAlertMessage,
  cleanSubjectForDisplay,
  formatAlertLine,
  formatSenderDisplay,
  mapAlertToSummary,
} from "./format.js";

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
    expect(message).toBe(loadGolden("buildDigestMessage.few"));
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

  it("opens the digest with the `AMBER DIGEST — N items` header", () => {
    const msg = buildDigestMessage(
      [
        { ...sampleAlert, alertId: "a1", zone: "amber" },
        { ...sampleAlert, alertId: "a2", zone: "amber" },
        { ...sampleAlert, alertId: "a3", zone: "amber" },
      ],
      "6h",
      "2026-04-08T12:00:00.000Z",
    );
    const [first, second] = msg.split("\n");
    expect(first).toBe("AMBER DIGEST — 3 items");
    expect(second).toBe("Window: last 6h");
  });

  it("singularizes the header count when there is exactly one item", () => {
    const msg = buildDigestMessage(
      [{ ...sampleAlert, alertId: "a1", zone: "amber" }],
      "12h",
      "2026-04-08T12:00:00.000Z",
    );
    expect(msg.split("\n")[0]).toBe("AMBER DIGEST — 1 item");
  });

  it("does not number digest items (subject is the entry headline)", () => {
    const msg = buildDigestMessage(
      [
        { ...sampleAlert, alertId: "a1", zone: "amber", subject: "First subject" },
        { ...sampleAlert, alertId: "a2", zone: "amber", subject: "Second subject" },
      ],
      "12h",
      "2026-04-08T12:00:00.000Z",
    );
    // No leading `1. ` / `2. ` item markers on any line.
    for (const line of msg.split("\n")) {
      expect(line).not.toMatch(/^\d+\.\s/u);
    }
    expect(msg).toContain("\nFirst subject\n");
    expect(msg).toContain("\nSecond subject\n");
  });

  it("never renders an alertId, Alert ID label, or Message ID in the digest", () => {
    const msg = buildDigestMessage(
      [
        { ...sampleAlert, alertId: "alert-abc-1", zone: "amber" },
        { ...sampleAlert, alertId: "alert-abc-2", zone: "amber", messageId: "<xyz@ex>" },
      ],
      "12h",
      "2026-04-08T12:00:00.000Z",
    );
    expect(msg).not.toContain("alert-abc-1");
    expect(msg).not.toContain("alert-abc-2");
    expect(msg).not.toContain("Alert ID");
    expect(msg).not.toContain("Message ID");
    expect(msg).not.toContain("<xyz@ex>");
    // The header must not retain any legacy title or count wording.
    expect(msg).not.toContain("Mail Sentinel Digest");
    expect(msg).not.toContain("Amber signals digest");
  });

  it("trims overly long digest subjects with an ellipsis", () => {
    const longSubject = `Re: ${"subject ".repeat(30)}end`;
    const msg = buildDigestMessage(
      [{ ...sampleAlert, subject: longSubject }],
      "12h",
      "2026-04-08T12:00:00.000Z",
    );
    // The trimmed subject is the item leader line, not prefixed by a number.
    const line = msg.split("\n").find((entry) => entry.startsWith("Re:"));
    expect(line).toBeDefined();
    expect((line as string).endsWith("…")).toBe(true);
    expect((line as string).length).toBeLessThanOrEqual(120);
  });

  it("keeps short digest subjects intact (no trim)", () => {
    const msg = buildDigestMessage(
      [{ ...sampleAlert, subject: "Invoice #short" }],
      "12h",
      "2026-04-08T12:00:00.000Z",
    );
    expect(msg).toContain("\nInvoice #short\n");
    expect(msg).not.toContain("…");
  });

  it("no longer renders an alertId bracket or zone bullet in the RED title", () => {
    const msg = buildRedAlertMessage(sampleAlert, "new-alert");
    const firstLine = msg.split("\n")[0] ?? "";
    expect(firstLine).toBe("Mail Sentinel Alert");
    expect(msg).not.toContain(sampleAlert.alertId);
    expect(msg).not.toContain("●");
  });

  it("cleanSubjectForDisplay strips e2e run-id suffixes", () => {
    expect(cleanSubjectForDisplay("Urgent invoice e2e-1776634127312 due today")).toBe(
      "Urgent invoice due today",
    );
    expect(
      cleanSubjectForDisplay("Your invoice is overdue — invoice-overdue-e2e-1776634127312"),
    ).toBe("Your invoice is overdue");
    expect(
      cleanSubjectForDisplay(
        "Failed payment warning for business account — failed-payment-e2e-1776634127312",
      ),
    ).toBe("Failed payment warning for business account");
    expect(
      cleanSubjectForDisplay("Urgent escalation: security incident e2e-1776634127312 today"),
    ).toBe("Urgent escalation: security incident today");
  });

  it("cleanSubjectForDisplay leaves real subjects untouched", () => {
    expect(cleanSubjectForDisplay("Invoice #12345 for $500")).toBe("Invoice #12345 for $500");
    expect(cleanSubjectForDisplay("Quick question about Q2 budget")).toBe(
      "Quick question about Q2 budget",
    );
    expect(cleanSubjectForDisplay("  Padded   subject  ")).toBe("Padded subject");
  });

  it("formatSenderDisplay prefers the display name when present", () => {
    expect(formatSenderDisplay('"Alice Smith" <alice@example.com>')).toBe("Alice Smith");
    expect(formatSenderDisplay("Alice <alice@example.com>")).toBe("Alice");
  });

  it("formatSenderDisplay falls back to the local part minus alias for bare addresses", () => {
    expect(formatSenderDisplay("billing+invoice@privex.com")).toBe("billing");
    expect(formatSenderDisplay("sovereign-ai-node-test+decision@proton.me")).toBe(
      "sovereign-ai-node-test",
    );
    expect(formatSenderDisplay("noreply@stonebridge.example")).toBe("noreply");
  });

  it("formatSenderDisplay returns the raw string when no display name and no bare-address parse", () => {
    expect(formatSenderDisplay("not-an-address")).toBe("not-an-address");
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
    expect(message).toBe(loadGolden("buildDigestMessage.many"));
  });
});
