import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleAlert } from "../__fixtures__/inputs.js";
import { loadGolden } from "../__fixtures__/load.js";
import {
  formatDigestResult,
  formatFeedbackResult,
  formatListAlertsResult,
  formatPolicyActionResult,
  formatPolicyResult,
  formatScanResult,
  printOutput,
} from "./output.js";

describe("alerts/output", () => {
  it("matches the formatScanResult golden fixtures", () => {
    expect(formatScanResult({ configured: false, note: "IMAP not configured" })).toBe(
      loadGolden("formatScanResult.unconfigured"),
    );
    expect(
      formatScanResult({
        configured: true,
        newMessages: 3,
        redAlertsSent: 1,
        amberQueued: 2,
        digestsSent: 0,
        remindersSent: 1,
        alerts: [{ ...sampleAlert, kind: "new-alert" as const }],
      }),
    ).toBe(loadGolden("formatScanResult.withAlerts"));
  });

  it("uses the default 'not configured' note when none is provided", () => {
    expect(formatScanResult({ configured: false })).toBe("IMAP is not configured yet.");
  });

  it("uses 0 defaults for all missing counters when configured", () => {
    const line = formatScanResult({ configured: true });
    expect(line).toBe(
      "Mail Sentinel scan: 0 new message(s), 0 red alert(s), 0 amber candidate(s), 0 digest(s), 0 reminder(s).",
    );
  });

  it("matches the formatFeedbackResult golden fixtures", () => {
    expect(
      formatFeedbackResult({
        note: "Feedback applied. Alert marked as important.",
        alertId: "alert-1",
      }),
    ).toBe(loadGolden("formatFeedbackResult.plain"));
    expect(
      formatFeedbackResult({
        note: "Reminder scheduled.",
        alertId: "alert-1",
        nextReminderAt: "2026-04-08T16:00:00Z",
      }),
    ).toBe(loadGolden("formatFeedbackResult.reminder"));
    expect(
      formatFeedbackResult({
        note: "Policy updated locally.",
        alertId: "alert-1",
        policyId: "pol-1",
      }),
    ).toBe(loadGolden("formatFeedbackResult.policy"));
  });

  it("matches the formatListAlertsResult golden fixtures", () => {
    expect(formatListAlertsResult({ view: "today", alerts: [] })).toBe(
      loadGolden("formatListAlertsResult.empty.today"),
    );
    expect(formatListAlertsResult({ view: "recent", alerts: [] })).toBe(
      loadGolden("formatListAlertsResult.empty.recent"),
    );
    expect(
      formatListAlertsResult({
        view: "today",
        alerts: [{ ...sampleAlert, kind: "new-alert" as const }],
      }),
    ).toBe(loadGolden("formatListAlertsResult.withAlerts"));
  });

  it("uses the 'recent' header for recent alerts", () => {
    expect(
      formatListAlertsResult({
        view: "recent",
        alerts: [{ ...sampleAlert, kind: "new-alert" as const }],
      }),
    ).toContain("Recent alerts:");
  });

  it("matches the formatDigestResult golden fixtures", () => {
    expect(formatDigestResult({ alerts: [] })).toBe(loadGolden("formatDigestResult.empty"));
    expect(formatDigestResult({ alerts: [{ ...sampleAlert, kind: "new-alert" as const }] })).toBe(
      loadGolden("formatDigestResult.withAlerts"),
    );
  });

  it("matches the formatPolicyResult golden fixtures", () => {
    expect(formatPolicyResult({ policies: [] })).toBe(loadGolden("formatPolicyResult.empty"));
    expect(
      formatPolicyResult({
        policies: [
          { id: "p1", type: "sender", match: "alice@example.com" },
          { id: "p2", type: "category", category: "risk-escalation" },
          { id: "p3", type: "time", schedule: "09:00-17:00" },
          { id: "p4", type: "content", pattern: "invoice" },
        ],
      }),
    ).toBe(loadGolden("formatPolicyResult.mixed"));
  });

  it("matches the formatPolicyActionResult golden fixtures", () => {
    expect(
      formatPolicyActionResult({
        note: "Policy applied.",
        matches: [
          {
            from: "Alice <alice@example.com>",
            fromAddress: "alice@example.com",
            messageCount: 4,
            lastSeenAt: "2026-04-08T08:00:00Z",
          },
        ],
      }),
    ).toBe(loadGolden("formatPolicyActionResult.withMatches"));
    expect(formatPolicyActionResult({ note: "Nothing to do." })).toBe(
      loadGolden("formatPolicyActionResult.plain"),
    );
  });

  describe("printOutput", () => {
    // biome-ignore lint/suspicious/noExplicitAny: vitest spy types are unwieldy here
    let writeSpy: any;

    beforeEach(() => {
      writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    });
    afterEach(() => {
      writeSpy.mockRestore();
    });

    it("prints JSON when options.json is true", () => {
      printOutput({ a: 1 }, { json: true }, () => "unused");
      expect(writeSpy).toHaveBeenCalledWith('{\n  "a": 1\n}\n');
    });

    it("prints formatter output when options.json is false", () => {
      printOutput({ a: 1 }, { json: false }, () => "text output");
      expect(writeSpy).toHaveBeenCalledWith("text output\n");
    });
  });
});
