import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleAlert } from "../__fixtures__/inputs.js";
import { loadGolden } from "../__fixtures__/load.js";
import type { ExplainCommandResult } from "../commands/explain.js";
import {
  formatDigestResult,
  formatExplainResult,
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

  it("renders content-policy scope and pattern in the listing", () => {
    const rendered = formatPolicyResult({
      policies: [
        { id: "c-sub", type: "content", pattern: "DOWN", scope: "subject" },
        { id: "c-body", type: "content", pattern: "approved", scope: "body" },
        { id: "c-snip", type: "content", pattern: "receipt", scope: "snippet" },
        { id: "c-any", type: "content", pattern: "invoice", scope: "any" },
        { id: "c-bare", type: "content", pattern: "overdue" },
      ],
    });
    expect(rendered).toContain("- [c-sub] content subject:/DOWN/");
    expect(rendered).toContain("- [c-body] content body:/approved/");
    expect(rendered).toContain("- [c-snip] content snippet:/receipt/");
    expect(rendered).toContain("- [c-any] content any:/invoice/");
    // A content entry without an explicit scope renders as "any".
    expect(rendered).toContain("- [c-bare] content any:/overdue/");
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

describe("alerts/output formatExplainResult", () => {
  const fullExplanation = (
    overrides: Partial<ExplainCommandResult> = {},
  ): ExplainCommandResult => ({
    instanceId: "ms-core",
    alertId: "11111111-1111-1111-1111-111111111111",
    shortRef: "111111",
    subject: "Invoice overdue",
    from: "Billing <billing@example.com>",
    policy: {
      signals: ["amount detected", "deadline detected"],
      matchedRuleIds: ["rule-amount", "rule-deadline"],
      policyModifiers: ["sender billing@example.com boosted"],
      score: 5,
      adjustedScore: 7,
      categoryScores: { "financial-relevance": 5 },
    },
    semantic: {
      available: true,
      result: {
        decisionRequired: true,
        financialRelevance: true,
        riskEscalation: false,
        confidence: 82,
        urgency: "high",
        reason: "Payment failure may lock the account within 48 hours.",
        deadlineDetected: true,
        amountDetected: true,
        suggestedZone: "red",
      },
    },
    decision: {
      zone: "red",
      category: "financial-relevance",
      confidence: 82,
      why: "Payment failure may lock the account within 48 hours.",
    },
    ...overrides,
  });

  it("renders the three sections separately, reusing the signal chip", () => {
    const text = formatExplainResult(fullExplanation());
    expect(text).toBe(
      [
        "Explanation for [111111] 'Invoice overdue' from Billing <billing@example.com>",
        "",
        "Policy & heuristics:",
        "  - Signals: amount detected · deadline detected",
        "  - Matched rules: rule-amount, rule-deadline",
        "  - Policy: sender billing@example.com boosted",
        "  - Score: base 5 → adjusted 7",
        "",
        "Semantic review:",
        "  - Verdict: Payment failure may lock the account within 48 hours.",
        "  - Classified: decision-required, financial-relevance",
        "  - Urgency: high",
        "  - Suggested zone: red",
        "  - Confidence: high (82%)",
        "  - Extracted signals: deadline=true, amount=true",
        "",
        "Zone decision:",
        "  - Zone: RED",
        "  - Category: financial-relevance",
        "  - Confidence: high (82%)",
        "  - Why it matters: Payment failure may lock the account within 48 hours.",
      ].join("\n"),
    );
  });

  it("renders an empty policy section as '(none)' and an unavailable semantic review", () => {
    const text = formatExplainResult(
      fullExplanation({
        policy: { signals: [], matchedRuleIds: [], policyModifiers: [] },
        semantic: { available: false },
        decision: {
          zone: "amber",
          category: "decision-required",
          why: "Flagged by Mail Sentinel.",
        },
      }),
    );
    expect(text).toContain("Policy & heuristics: (none)");
    expect(text).toContain("Semantic review:\n  - unavailable — no reviewer verdict recorded");
    expect(text).toContain("Zone decision:");
    expect(text).toContain("  - Zone: AMBER");
    // No confidence on the alert → label degrades to "unknown".
    expect(text).toContain("  - Confidence: unknown");
  });

  it("treats an available-but-empty semantic result as unavailable", () => {
    const text = formatExplainResult(
      fullExplanation({ semantic: { available: true, result: undefined } }),
    );
    expect(text).toContain("Semantic review:\n  - unavailable — no reviewer verdict recorded");
  });

  it("renders 'none' when the reviewer classified no category and shows only present score parts", () => {
    const text = formatExplainResult(
      fullExplanation({
        policy: {
          signals: [],
          matchedRuleIds: [],
          policyModifiers: [],
          adjustedScore: 4,
        },
        semantic: {
          available: true,
          result: {
            decisionRequired: false,
            financialRelevance: false,
            riskEscalation: false,
            confidence: 30,
            urgency: "low",
            reason: "Low-signal message.",
            deadlineDetected: false,
            amountDetected: false,
            suggestedZone: "gray",
          },
        },
      }),
    );
    expect(text).toContain("  - Classified: none");
    // Only adjustedScore is present, so the score line carries just that part.
    expect(text).toContain("  - Score: adjusted 4");
    expect(text).not.toContain("base");
  });

  it("renders only the base score when adjustedScore is absent", () => {
    const text = formatExplainResult(
      fullExplanation({
        policy: { signals: [], matchedRuleIds: [], policyModifiers: [], score: 6 },
      }),
    );
    expect(text).toContain("  - Score: base 6");
    expect(text).not.toContain("adjusted");
  });

  it("omits the score line entirely when neither score is present", () => {
    const text = formatExplainResult(
      fullExplanation({
        policy: { signals: ["x"], matchedRuleIds: [], policyModifiers: [] },
      }),
    );
    expect(text).not.toContain("Score:");
    expect(text).toContain("  - Signals: x");
  });

  it("lists all three classification flags when the reviewer set them", () => {
    const text = formatExplainResult(
      fullExplanation({
        semantic: {
          available: true,
          result: {
            decisionRequired: true,
            financialRelevance: true,
            riskEscalation: true,
            confidence: 90,
            urgency: "high",
            reason: "Escalating risk.",
            deadlineDetected: true,
            amountDetected: true,
            suggestedZone: "red",
          },
        },
      }),
    );
    expect(text).toContain(
      "  - Classified: decision-required, financial-relevance, risk-escalation",
    );
  });

  it("renders an ambiguous result with the candidate list, like feedback", () => {
    const text = formatExplainResult({
      instanceId: "ms-core",
      status: "ambiguous",
      ref: "aa",
      candidates: [
        {
          alertId: "aa000000-0000-0000-0000-000000000000",
          shortRef: "aa0000",
          subject: "One",
          from: "a@x.com",
        },
        {
          alertId: "aa111111-0000-0000-0000-000000000000",
          shortRef: "aa1111",
          subject: "Two",
          from: "b@y.com",
        },
      ],
    });
    expect(text).toBe(
      [
        "Ambiguous: 'aa' matches 2 items. Reply with one of:",
        "- [aa0000] 'One' from a@x.com",
        "- [aa1111] 'Two' from b@y.com",
      ].join("\n"),
    );
  });
});
