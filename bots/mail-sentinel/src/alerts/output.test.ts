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

  it("names the matched item (ref, subject, sender) when the enriched fields are present", () => {
    expect(
      formatFeedbackResult({
        note: "Feedback applied. Alert marked as important.",
        alertId: "alert-1",
        shortRef: "a1b2c3",
        subject: "Invoice overdue",
        from: "Billing <billing@example.com>",
      }),
    ).toBe(
      "Feedback applied. Alert marked as important. Applied to: [a1b2c3] 'Invoice overdue' from Billing <billing@example.com>.",
    );
  });

  it("omits the sender clause when from is absent but ref+subject are present", () => {
    expect(
      formatFeedbackResult({
        note: "Reminder scheduled.",
        alertId: "alert-1",
        shortRef: "a1b2c3",
        subject: "Invoice overdue",
        nextReminderAt: "2026-04-08T16:00:00Z",
      }),
    ).toBe(
      "Reminder scheduled. Applied to: [a1b2c3] 'Invoice overdue'. Will be revisited at 2026-04-08T16:00:00Z.",
    );
  });

  it("names the matched item alongside a created policy", () => {
    expect(
      formatFeedbackResult({
        note: "Policy updated locally.",
        alertId: "alert-1",
        shortRef: "a1b2c3",
        subject: "Invoice overdue",
        from: "billing@example.com",
        policyId: "pol-1",
      }),
    ).toBe(
      "Policy updated locally. Applied to: [a1b2c3] 'Invoice overdue' from billing@example.com. Policy pol-1 created.",
    );
  });

  it("lists candidates with their short refs for ambiguous feedback", () => {
    expect(
      formatFeedbackResult({
        status: "ambiguous",
        ref: "invoice",
        candidates: [
          { shortRef: "a1b2c3", subject: "Invoice March", from: "billing@example.com" },
          { shortRef: "d4e5f6", subject: "Invoice April", from: "ar@vendor.com" },
        ],
      }),
    ).toBe(
      [
        "Ambiguous: 'invoice' matches 2 items. Reply with one of:",
        "- [a1b2c3] 'Invoice March' from billing@example.com",
        "- [d4e5f6] 'Invoice April' from ar@vendor.com",
      ].join("\n"),
    );
  });

  it("renders an ambiguous result with no ref/candidates without throwing", () => {
    expect(formatFeedbackResult({ status: "ambiguous" })).toBe(
      "Ambiguous: '' matches 0 items. Reply with one of:",
    );
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
          { id: "p5", type: "content", pattern: "freigegeben", scope: "subject" },
        ],
      }),
    ).toBe(loadGolden("formatPolicyResult.mixed"));
  });

  it("renders content-policy scope and pattern under the Content section", () => {
    const rendered = formatPolicyResult({
      policies: [
        { id: "c-sub", type: "content", pattern: "DOWN", scope: "subject" },
        { id: "c-body", type: "content", pattern: "approved", scope: "body" },
        { id: "c-snip", type: "content", pattern: "receipt", scope: "snippet" },
        { id: "c-any", type: "content", pattern: "invoice", scope: "any" },
        { id: "c-bare", type: "content", pattern: "overdue" },
      ],
    });
    // The rule type is now the section header, so the line no longer repeats it.
    expect(rendered).toContain("Content (5):");
    expect(rendered).toContain("- [c-sub] subject:/DOWN/");
    expect(rendered).toContain("- [c-body] body:/approved/");
    expect(rendered).toContain("- [c-snip] snippet:/receipt/");
    expect(rendered).toContain("- [c-any] any:/invoice/");
    // A content entry without an explicit scope renders as "any".
    expect(rendered).toContain("- [c-bare] any:/overdue/");
  });

  it("uses singular wording for a single rule and a single effective route", () => {
    const rendered = formatPolicyResult({
      policies: [{ id: "s1", type: "sender", match: "a@b", minZone: "amber" }],
    });
    expect(rendered.startsWith("Mail Sentinel policies (1 rule, 1 effective route):")).toBe(true);
  });

  it("collapses exact-duplicate rules and tags each line with its effect", () => {
    const rendered = formatPolicyResult({
      policies: [
        { id: "s1", type: "sender", match: "boss@corp.com", minZone: "amber" },
        { id: "s2", type: "sender", match: "boss@corp.com", minZone: "amber" },
        { id: "c1", type: "content", pattern: "invoice", scope: "subject", boost: 2 },
      ],
    });
    expect(rendered).toContain("- [s1,s2] boss@corp.com (x2, collapsed)  floor=amber");
    expect(rendered).toContain("- [c1] subject:/invoice/  boost +2");
  });

  it("resolves effective routing and surfaces contradictions", () => {
    const rendered = formatPolicyResult({
      policies: [
        { id: "m1", type: "mute", match: "*.spam.example" },
        { id: "d1", type: "domain", match: "news.example", maxZone: "gray" },
        { id: "x1", type: "sender", match: "vip@corp.com", minZone: "red" },
        { id: "x2", type: "sender", match: "vip@corp.com", maxZone: "amber" },
      ],
    });
    expect(rendered).toContain("3 effective routes");
    expect(rendered).toContain("Effective routing (mute > ceiling > floor > boost):");
    expect(rendered).toContain("  *.spam.example -> MUTED");
    expect(rendered).toContain("  news.example -> ceiling gray");
    // The same target with both a floor and a ceiling stays two list lines AND
    // resolves to a combined effective route, so the contradiction is explained.
    expect(rendered).toContain("  vip@corp.com -> floor red ceiling amber");
    expect(rendered).toContain("- [x1] vip@corp.com  floor=red");
    expect(rendered).toContain("- [x2] vip@corp.com  ceiling=amber");
    // A mute-type rule shows MUTED on its own line under the Mute section.
    expect(rendered).toContain("- [m1] *.spam.example  MUTED");
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
