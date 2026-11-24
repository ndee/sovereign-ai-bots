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

const score = (subject: string, text: string, overrides: Partial<ParsedMessage> = {}) =>
  scoreMessage(buildMessage({ subject, text, ...overrides }), baseState, defaultRules);

describe("default-rules.json: thresholds stay put", () => {
  it("keeps the candidate, alert, category and zone thresholds", () => {
    expect(defaultRules.thresholds).toEqual({ candidate: 3, alert: 4, category: 4 });
    expect(defaultRules.zoneThresholds).toEqual({
      redMinConfidence: 75,
      amberMinConfidence: 40,
      redMinHeuristicScore: 4,
      amberMinHeuristicScore: 3,
    });
  });
});

describe("default-rules.json: German spelling with umlauts and sharp s", () => {
  it("reads a reply request spelled with an umlaut in the subject as a decision", () => {
    const scored = score("Rückmeldung zum Umbau", "Hallo, anbei die Unterlagen.");
    expect(scored.candidate).toBe(true);
    expect(scored.category).toBe("decision-required");
  });

  it("reads a confirmation request spelled with an umlaut as a decision", () => {
    const scored = score(
      "Unterlagen",
      "Hallo, könnten Sie bitte bestätigen, dass die Maße passen?",
    );
    expect(scored.matchedRuleIds).toContain("decision-question-text");
    expect(scored.relevant).toBe(true);
  });

  it("reads 'überweisen' and 'Überweisung' as payment wording", () => {
    expect(score("Hallo", "Bitte überweisen Sie den Rest.").matchedRuleIds).toContain(
      "financial-payment-text",
    );
    expect(score("Hallo", "Die Überweisung ist nicht angekommen.").matchedRuleIds).toContain(
      "financial-payment-text",
    );
  });
});

describe("default-rules.json: German compounds", () => {
  it.each([
    ["Jahresrechnung 2026", "financial-invoice-subject"],
    ["Ihre Stromrechnung", "financial-invoice-subject"],
    ["Nebenkostenabrechnung für die Wohnung", "financial-invoice-subject"],
    ["Zahlungserinnerung", "financial-invoice-subject"],
    ["Mietvertrag und Vertragsverlängerung", "financial-invoice-subject"],
    ["Budgetfreigabe für das Projekt", "decision-approval-subject"],
    ["Urlaubsgenehmigung", "decision-approval-subject"],
  ])("matches the compound subject %s", (subject, ruleId) => {
    expect(score(subject, "Hallo.").matchedRuleIds).toContain(ruleId);
  });

  it.each([
    ["Die Kündigungsfrist endet am 30.", "risk-deadline-text"],
    ["Die Abgabefrist läuft bald ab.", "risk-deadline-text"],
    ["Bitte beachten Sie die Fristen.", "risk-deadline-text"],
    ["Der Rechnungsbetrag ist noch offen.", "financial-payment-text"],
    ["Der Gesamtbetrag ist überfällig.", "financial-payment-text"],
    ["Dies ist die zweite Mahnung.", "financial-payment-text"],
    ["Das ist eine dringende Angelegenheit.", "risk-deadline-text"],
    ["Wir haben eine Kundenbeschwerde erhalten.", "risk-deadline-text"],
  ])("matches the compound body %s", (text, ruleId) => {
    expect(score("Hallo", text).matchedRuleIds).toContain(ruleId);
  });

  it.each([
    ["Die Berechnung der Fläche liegt bei.", "financial-invoice-subject"],
    ["Wir haben kurzfristig umgeplant.", "risk-deadline-text"],
    ["Das ist zufällig passiert.", "financial-payment-text"],
    ["Ein auffälliges Muster im Garten.", "financial-payment-text"],
  ])("does not read the look-alike %s as a keyword", (text, ruleId) => {
    expect(score(text, text).matchedRuleIds).not.toContain(ruleId);
  });

  it("does not read an announcement as a termination", () => {
    const scored = score(
      "Ankündigung: Sommerfest",
      "Wir kündigen hiermit das Sommerfest an. Wie angekündigt gibt es Kuchen.",
    );
    expect(scored.candidate).toBe(false);
  });
});

describe("default-rules.json: bare day words stay below the candidate threshold", () => {
  it.each([
    [
      "Dein Tag im Überblick",
      "Guten Morgen! Heute: Teamrunde um 10 Uhr. Morgen: Sport. Am Freitag ist Markt.",
    ],
    ["Wetter", "Heute sonnig, morgen Regen, am Sonntag wieder trocken."],
    ["Your day", "Today: two meetings. Tomorrow: dentist. Friday: team lunch."],
  ])("keeps the daily overview %s out of review", (subject, text) => {
    const scored = score(subject, text);
    expect(scored.matchedRuleIds).toContain("risk-day-word-text");
    expect(scored.matchedRuleIds).not.toContain("risk-deadline-text");
    expect(scored.score).toBeLessThan(defaultRules.thresholds.candidate);
    expect(scored.candidate).toBe(false);
  });

  it.each([
    "Bitte schicken Sie die Unterlagen bis morgen.",
    "Das muss noch heute raus.",
    "Ich brauche das heute noch.",
    "Bitte bis spätestens Freitag erledigen.",
    "The report is due tomorrow.",
    "Please send it by end of day.",
  ])("still treats the deadline phrase %s as a deadline", (text) => {
    const scored = score("Unterlagen", text);
    expect(scored.matchedRuleIds).toContain("risk-deadline-text");
    expect(scored.relevant).toBe(true);
  });

  it("reads a reply request with a day as a relevant deadline", () => {
    const scored = score("Hallo", "Rückmeldung bis Donnerstag wäre gut.");
    expect(scored.matchedRuleIds).toEqual(
      expect.arrayContaining(["decision-reply-text", "risk-deadline-text", "risk-day-word-text"]),
    );
    expect(scored.relevant).toBe(true);
  });

  it("lets a day word add to another signal", () => {
    const scored = score("Hallo", "Bitte um Rückmeldung, ich bin morgen im Büro.");
    expect(scored.matchedRuleIds).toEqual(
      expect.arrayContaining(["decision-reply-text", "risk-day-word-text"]),
    );
    expect(scored.score).toBeGreaterThanOrEqual(defaultRules.thresholds.alert);
  });
});

describe("default-rules.json: defects, termination and reply requests", () => {
  it.each([
    "Die Heizung im zweiten Stock ist defekt.",
    "Im Keller gibt es einen Wasserschaden.",
    "Die Waschmaschine funktioniert nicht mehr.",
    "Bei der Abnahme wurden Mängel festgestellt.",
    "Seit gestern gibt es eine Störung im Netz.",
    "Das Paket kam beschädigt an.",
    "The water heater is defective.",
    "The portal has been down since noon, a full outage.",
  ])("reads the defect report %s as a risk candidate", (text) => {
    const scored = score("Hallo", text);
    expect(scored.matchedRuleIds).toContain("risk-defect-text");
    expect(scored.category).toBe("risk-escalation");
    expect(scored.relevant).toBe(true);
  });

  it.each([
    "Hiermit kündigen wir den Vertrag zum Monatsende.",
    "Ihr Mietverhältnis wurde gekündigt.",
    "Anbei die fristlose Kündigung.",
    "Sie erhalten eine Abmahnung wegen wiederholter Verspätung.",
    "This is a notice of termination for the service agreement.",
  ])("reads the termination %s as a risk candidate", (text) => {
    const scored = score("Hallo", text);
    expect(scored.matchedRuleIds).toContain("risk-termination-text");
    expect(scored.category).toBe("risk-escalation");
    expect(scored.relevant).toBe(true);
  });

  it.each([
    ["Kündigung Ihres Vertrags", "risk-notice-subject"],
    ["Heizung defekt", "risk-notice-subject"],
    ["Störung im Netz", "risk-notice-subject"],
    ["Service outage", "risk-notice-subject"],
  ])("reads the subject %s as a risk notice", (subject, ruleId) => {
    const scored = score(subject, "Hallo.");
    expect(scored.matchedRuleIds).toContain(ruleId);
    expect(scored.relevant).toBe(true);
  });

  it.each([
    "Ich bitte um Ihre Rückmeldung.",
    "Wir bitten um eine kurze Antwort.",
    "Rückmeldung bis Monatsende wäre gut.",
    "Bitte rufen Sie mich zurück.",
    "Um Antwort wird gebeten.",
    "Awaiting your reply.",
    "Please get back to me.",
  ])("reads the reply request %s as a decision candidate", (text) => {
    const scored = score("Hallo", text);
    expect(scored.matchedRuleIds).toContain("decision-reply-text");
    expect(scored.candidate).toBe(true);
    expect(scored.category).toBe("decision-required");
  });

  it.each([
    "Bitte antworten Sie nicht auf diese E-Mail.",
    "Please do not reply to this message.",
    "Wir freuen uns über Ihre Rückmeldung zum Newsletter.",
  ])("does not read the automated footer %s as a reply request", (text) => {
    const scored = score("Ihre Bestellung", text);
    expect(scored.matchedRuleIds).not.toContain("decision-reply-text");
  });
});
