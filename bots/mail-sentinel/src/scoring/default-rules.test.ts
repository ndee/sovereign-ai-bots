import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sampleState } from "../__fixtures__/inputs.js";
import { migrateState } from "../state/schema.js";
import type { ParsedMessage, RulesDocument } from "../types.js";
import { scoreMessage } from "./heuristics.js";

const rulesPath = fileURLToPath(
  new URL("../../workspace/config/default-rules.json", import.meta.url),
);
const defaultRules = JSON.parse(readFileSync(rulesPath, "utf-8")) as RulesDocument;

const baseState = migrateState(sampleState);

const buildMessage = (overrides: Partial<ParsedMessage>): ParsedMessage => ({
  key: "msg:<t@ex>",
  uid: 1,
  messageId: "<t@ex>",
  subject: "",
  normalizedThreadSubject: "",
  from: "Sender <sender@example.test>",
  fromAddress: "sender@example.test",
  domain: "example.test",
  text: "",
  snippet: "",
  headers: {},
  toAddresses: [],
  amountSignal: null,
  deadlineDetected: false,
  ...overrides,
});

// These assertions lock in the classifier's behavior on realistic finance
// phrasings that previously tipped into risk-escalation because the pattern
// required the literal contiguous string "amount due". The regression
// originally surfaced in the live e2e as scenarios 1 and 2 of
// alert-pipeline.feature classifying the "Urgent invoice ... due today"
// fixture as risk-escalation.
describe("default-rules.json: finance vs risk tie-break on realistic bodies", () => {
  it("classifies an urgent invoice body with 'amount is due today' as financial-relevance", () => {
    const message = buildMessage({
      subject: "Urgent invoice e2e-1 due today",
      text: "Attached is the invoice for $12,345.67. The amount is due today; otherwise the contract will be suspended, late fees will apply, and the payment must be wired immediately.",
    });
    const scored = scoreMessage(message, baseState, defaultRules);
    expect(scored.category).toBe("financial-relevance");
    expect(scored.categoryScores["financial-relevance"]).toBeGreaterThan(
      scored.categoryScores["risk-escalation"] ?? 0,
    );
  });

  it("classifies an overdue-invoice body with 'Amount due' and 'late fees' as financial-relevance", () => {
    const message = buildMessage({
      subject: "Your invoice is overdue — invoice-overdue-e2e-1",
      text: "Hello,\n\nInvoice INV-2048 is now overdue.\n\nAmount due: $489.00\nFinal payment deadline: April 18, 2026\n\nLate fees will apply if payment is not received.",
    });
    const scored = scoreMessage(message, baseState, defaultRules);
    expect(scored.category).toBe("financial-relevance");
  });

  it("still classifies a genuine security-incident body as risk-escalation", () => {
    const message = buildMessage({
      subject: "Urgent escalation: security incident e2e-1 today",
      text: "Urgent: there is a security incident. Deadline is today. Immediate escalation to management and incident response is required.",
    });
    const scored = scoreMessage(message, baseState, defaultRules);
    expect(scored.category).toBe("risk-escalation");
  });

  it("still classifies an approval-required decision body as decision-required", () => {
    const message = buildMessage({
      subject: "Urgent approval needed today for Q2 project e2e-1",
      text: "Hello, please decide by 5pm today whether the Q2 budget can be approved. Without your approval the contract will be blocked tomorrow and we need an immediate reply.",
    });
    const scored = scoreMessage(message, baseState, defaultRules);
    expect(scored.category).toBe("decision-required");
  });
});

// A subscription-renewal notice ("renewal date", "billing cycle") has no
// invoice/payment keywords but is still a financial event. Previously it
// scored 0 on every rule, never became a candidate, and was silently
// dropped as gray. The live e2e `Canonical AMBER business signals` scenario
// timed out waiting 5min for the recorded alert that never arrived.
describe("default-rules.json: subscription-renewal candidacy", () => {
  it("classifies a Canva-style renewal notice as a financial-relevance candidate", () => {
    const message = buildMessage({
      subject: "Canva Pro renewal notice for April — subscription-renewal-e2e-1",
      text: "Hello,\n\nYour Canva Pro subscription is scheduled to renew this month.\n\nRenewal date: April 21, 2026\nPlan: Canva Pro\nBilling cycle: Monthly\n\nNo immediate action is required unless you want to change or cancel the subscription before the renewal date.",
    });
    const scored = scoreMessage(message, baseState, defaultRules);
    expect(scored.candidate).toBe(true);
    expect(scored.category).toBe("financial-relevance");
  });

  it("classifies an auto-renewal confirmation body as financial-relevance", () => {
    const message = buildMessage({
      subject: "Your plan will auto-renew next week",
      text: "Your annual plan will auto-renew on May 1. No action is required if you want to continue.",
    });
    const scored = scoreMessage(message, baseState, defaultRules);
    expect(scored.candidate).toBe(true);
    expect(scored.category).toBe("financial-relevance");
  });

  it("keeps a product-roundup newsletter below the candidate threshold", () => {
    const message = buildMessage({
      subject: "April product updates and feature roundup",
      text: "Hello,\n\nHere is your monthly product roundup. This month we launched a new dashboard theme, improved export options, and updated collaboration tools.\n\nRead more on our blog.",
      headers: { "list-unsubscribe": "<mailto:unsub@example.test>" },
    });
    const scored = scoreMessage(message, baseState, defaultRules);
    expect(scored.candidate).toBe(false);
  });
});
