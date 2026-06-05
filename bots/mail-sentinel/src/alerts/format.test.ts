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
    expect(buildRedAlertMessage(sampleAlert, "new-alert")).toEqual(
      loadGolden("buildRedAlertMessage.alert"),
    );
    expect(buildRedAlertMessage({ ...sampleAlert, messageId: undefined }, "reminder")).toEqual(
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
    );
    expect(message).toEqual(loadGolden("buildDigestMessage.few"));
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
    expect(msg.body).toContain("RED · ");
    expect(msg.formattedBody).toContain("RED · ");
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
    expect(msg.body).toContain("· mystery");
    expect(msg.formattedBody).toContain("· mystery");
  });

  it("uses raw category label in buildDigestMessage when unknown", () => {
    const msg = buildDigestMessage(
      [{ ...sampleAlert, category: "mystery" as unknown as "financial-relevance" }],
      "12h",
    );
    expect(msg.body).toContain("mystery");
    expect(msg.formattedBody).toContain("mystery");
  });

  it("opens the digest with the `AMBER DIGEST · N items` header and a window line", () => {
    const msg = buildDigestMessage(
      [
        { ...sampleAlert, alertId: "a1", zone: "amber" },
        { ...sampleAlert, alertId: "a2", zone: "amber" },
        { ...sampleAlert, alertId: "a3", zone: "amber" },
      ],
      "6h",
    );
    const [first, second] = msg.body.split("\n");
    expect(first).toBe("🟠 AMBER DIGEST · 3 items");
    expect(second).toBe("Window: last 6h");
    expect(msg.formattedBody).toContain("AMBER DIGEST · 3 items");
    expect(msg.formattedBody).toContain("Window: last 6h");
  });

  it("singularizes the header count when there is exactly one item", () => {
    const msg = buildDigestMessage([{ ...sampleAlert, alertId: "a1", zone: "amber" }], "12h");
    expect(msg.body.split("\n")[0]).toBe("🟠 AMBER DIGEST · 1 item");
    expect(msg.formattedBody).toContain("AMBER DIGEST · 1 item");
  });

  it("numbers digest items in both plain-text and HTML", () => {
    const msg = buildDigestMessage(
      [
        { ...sampleAlert, alertId: "a1", zone: "amber", subject: "First subject" },
        { ...sampleAlert, alertId: "a2", zone: "amber", subject: "Second subject" },
      ],
      "12h",
    );
    expect(msg.body).toContain("\n1. [alert1] First subject\n");
    expect(msg.body).toContain("\n2. [alert1] Second subject\n");
    expect(msg.formattedBody).toContain(
      "<strong>1.</strong> <code>[alert1]</code> <strong>First subject</strong>",
    );
    expect(msg.formattedBody).toContain(
      "<strong>2.</strong> <code>[alert1]</code> <strong>Second subject</strong>",
    );
  });

  it("never renders an alertId, Alert ID label, or Message ID in the digest", () => {
    const msg = buildDigestMessage(
      [
        { ...sampleAlert, alertId: "alert-abc-1", zone: "amber" },
        { ...sampleAlert, alertId: "alert-abc-2", zone: "amber", messageId: "<xyz@ex>" },
      ],
      "12h",
    );
    for (const text of [msg.body, msg.formattedBody]) {
      expect(text).not.toContain("alert-abc-1");
      expect(text).not.toContain("alert-abc-2");
      expect(text).not.toContain("Alert ID");
      expect(text).not.toContain("Message ID");
      expect(text).not.toContain("Mail Sentinel Digest");
      expect(text).not.toContain("Amber signals digest");
    }
    expect(msg.body).not.toContain("<xyz@ex>");
    // The raw id appears HTML-escaped in formatted_body only if present;
    // neither the raw nor the escaped form should leak.
    expect(msg.formattedBody).not.toContain("&lt;xyz@ex&gt;");
  });

  it("trims overly long digest subjects with an ellipsis", () => {
    const longSubject = `Re: ${"subject ".repeat(30)}end`;
    const msg = buildDigestMessage([{ ...sampleAlert, subject: longSubject }], "12h");
    const line = msg.body.split("\n").find((entry) => entry.startsWith("1. [alert1] Re:"));
    expect(line).toBeDefined();
    expect((line as string).endsWith("…")).toBe(true);
    // "1. [alert1] " prefix adds 12 chars beyond the 120-char subject cap.
    expect((line as string).length).toBeLessThanOrEqual(132);
  });

  it("keeps short digest subjects intact (no trim)", () => {
    const msg = buildDigestMessage([{ ...sampleAlert, subject: "Invoice #short" }], "12h");
    expect(msg.body).toContain("\n1. [alert1] Invoice #short\n");
    expect(msg.body).not.toContain("…");
  });

  it("opens the RED message with the zone header and omits legacy titles", () => {
    const msg = buildRedAlertMessage(sampleAlert, "new-alert");
    const firstLine = msg.body.split("\n")[0] ?? "";
    expect(firstLine).toBe("🔴 RED · Financial Relevance");
    expect(msg.body).not.toContain("Mail Sentinel Alert");
    expect(msg.body).not.toContain(sampleAlert.alertId);
    expect(msg.body).not.toContain("●");
    expect(msg.formattedBody).toContain("<strong>RED · Financial Relevance</strong>");
    expect(msg.formattedBody).not.toContain("Mail Sentinel Alert");
  });

  it("marks reminder RED alerts with a ' · reminder' suffix on the zone header", () => {
    const msg = buildRedAlertMessage(sampleAlert, "reminder");
    const firstLine = msg.body.split("\n")[0] ?? "";
    expect(firstLine).toBe("🔴 RED · Financial Relevance · reminder");
    expect(msg.formattedBody).toContain("RED · Financial Relevance · reminder");
  });

  it("falls back to the RED emoji for unknown zone values", () => {
    const msg = buildRedAlertMessage(
      { ...sampleAlert, zone: "purple" as unknown as "red" },
      "new-alert",
    );
    expect(msg.body.startsWith("🔴 PURPLE · ")).toBe(true);
    expect(msg.formattedBody).toContain("🔴 <strong>PURPLE · ");
  });

  it("HTML-escapes untrusted alert fields in formatted_body", () => {
    const malicious = {
      ...sampleAlert,
      subject: "<script>alert(1)</script> & trouble",
      from: 'Mallory "hacker" <m@evil.example>',
      why: "two & two < five",
    };
    const msg = buildRedAlertMessage(malicious, "new-alert");
    // Plain body preserves the raw characters (it's plain text, no escaping).
    expect(msg.body).toContain("<script>alert(1)</script> & trouble");
    // HTML body escapes < > & and drops the script tag as literal text.
    expect(msg.formattedBody).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; trouble");
    expect(msg.formattedBody).not.toContain("<script>");
    expect(msg.formattedBody).toContain("two &amp; two &lt; five");
  });

  it("includes the feedback footer with code-wrapped options in both bodies", () => {
    const alertMsg = buildRedAlertMessage(sampleAlert, "new-alert");
    expect(alertMsg.body).toContain(
      "very important · not important · remind later · always treat like this · less of this",
    );
    expect(alertMsg.formattedBody).toContain(
      "<code>very important</code> · <code>not important</code>",
    );

    const digestMsg = buildDigestMessage([{ ...sampleAlert, alertId: "a1", zone: "amber" }], "12h");
    expect(digestMsg.body).toContain(
      "very important · not important · always treat like this · less of this · digest only",
    );
    expect(digestMsg.formattedBody).toContain(
      "<code>very important</code> · <code>not important</code>",
    );
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

  const evidenceAlert: StoredAlert = {
    ...sampleAlert,
    excerpt: "Please pay the attached invoice by Friday.\nTotal due: $500.",
    reasons: ["subject mentions an invoice", "mentions a dollar amount", "deadline detected"],
  };

  it("matches the buildRedAlertMessage with-evidence golden fixture", () => {
    expect(buildRedAlertMessage(evidenceAlert, "new-alert")).toEqual(
      loadGolden("buildRedAlertMessage.withEvidence"),
    );
  });

  it("matches the buildDigestMessage with-evidence golden fixture", () => {
    expect(buildDigestMessage([{ ...evidenceAlert, zone: "amber" }], "12h")).toEqual(
      loadGolden("buildDigestMessage.withEvidence"),
    );
  });

  it("renders the excerpt as a quote and the signals chip in the red alert", () => {
    const msg = buildRedAlertMessage(evidenceAlert, "new-alert");
    expect(msg.body).toContain("> Please pay the attached invoice by Friday.");
    expect(msg.body).toContain("> Total due: $500.");
    expect(msg.body).toContain(
      "Signals: subject mentions an invoice · mentions a dollar amount · deadline detected",
    );
    expect(msg.formattedBody).toContain(
      "<blockquote>Please pay the attached invoice by Friday.<br>Total due: $500.</blockquote>",
    );
    expect(msg.formattedBody).toContain("<strong>Signals:</strong>");
  });

  it("renders the excerpt and signals per digest item", () => {
    const msg = buildDigestMessage([{ ...evidenceAlert, zone: "amber" }], "12h");
    expect(msg.body).toContain("> Please pay the attached invoice by Friday.");
    expect(msg.body).toContain("Signals: subject mentions an invoice");
    expect(msg.formattedBody).toContain("<blockquote>");
    expect(msg.formattedBody).toContain("<strong>Signals:</strong>");
  });

  it("omits the excerpt block and signals chip cleanly when both are absent", () => {
    const msg = buildRedAlertMessage(sampleAlert, "new-alert");
    expect(msg.body).not.toContain(">");
    expect(msg.body).not.toContain("Signals:");
    expect(msg.formattedBody).not.toContain("<blockquote>");
    expect(msg.formattedBody).not.toContain("Signals:");
  });

  it("renders signals without an excerpt in both alert and digest", () => {
    const signalsOnly: StoredAlert = { ...sampleAlert, reasons: ["deadline detected"] };
    const alertMsg = buildRedAlertMessage(signalsOnly, "new-alert");
    expect(alertMsg.body).toContain("Signals: deadline detected");
    expect(alertMsg.body).not.toContain(">");
    expect(alertMsg.formattedBody).toContain("<strong>Signals:</strong> deadline detected<br>");
    expect(alertMsg.formattedBody).not.toContain("<blockquote>");

    const digestMsg = buildDigestMessage([{ ...signalsOnly, zone: "amber" }], "12h");
    expect(digestMsg.body).toContain("Signals: deadline detected");
    expect(digestMsg.body).not.toContain(">");
    expect(digestMsg.formattedBody).toContain("<strong>Signals:</strong> deadline detected");
    expect(digestMsg.formattedBody).not.toContain("<blockquote>");
  });

  it("renders an excerpt without signals in both alert and digest", () => {
    const excerptOnly: StoredAlert = { ...sampleAlert, excerpt: "One line of evidence." };
    const alertMsg = buildRedAlertMessage(excerptOnly, "new-alert");
    expect(alertMsg.body).toContain("> One line of evidence.");
    expect(alertMsg.body).not.toContain("Signals:");
    expect(alertMsg.formattedBody).toContain("<blockquote>One line of evidence.</blockquote>");
    expect(alertMsg.formattedBody).not.toContain("Signals:");

    const digestMsg = buildDigestMessage([{ ...excerptOnly, zone: "amber" }], "12h");
    expect(digestMsg.body).toContain("> One line of evidence.");
    expect(digestMsg.body).not.toContain("Signals:");
    expect(digestMsg.formattedBody).toContain("<blockquote>One line of evidence.</blockquote>");
    expect(digestMsg.formattedBody).not.toContain("Signals:");
  });

  it("HTML-escapes untrusted excerpt and signal content so markup cannot be injected", () => {
    const malicious: StoredAlert = {
      ...sampleAlert,
      excerpt: "<script>alert(1)</script> & co\nsecond <b>line</b>",
      reasons: ["<img src=x onerror=1>"],
    };
    const msg = buildRedAlertMessage(malicious, "new-alert");
    expect(msg.formattedBody).toContain(
      "<blockquote>&lt;script&gt;alert(1)&lt;/script&gt; &amp; co<br>second &lt;b&gt;line&lt;/b&gt;</blockquote>",
    );
    expect(msg.formattedBody).not.toContain("<script>");
    expect(msg.formattedBody).toContain("&lt;img src=x onerror=1&gt;");
    // Plain body keeps raw characters (it is plain text).
    expect(msg.body).toContain("> <script>alert(1)</script> & co");
  });

  it("matches the buildDigestMessage many-alerts golden fixture", () => {
    const message = buildDigestMessage(
      Array.from({ length: 12 }, (_, i) => ({
        ...sampleAlert,
        alertId: `a${i}`,
        subject: `Invoice #${i}`,
      })),
      "12h",
    );
    expect(message).toEqual(loadGolden("buildDigestMessage.many"));
  });
});
