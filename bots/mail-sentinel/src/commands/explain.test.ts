import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getFakeRuntime, resetFakeRuntime } from "../__fixtures__/fake-runtime.js";
import type { LlmResult, StoredAlert } from "../types.js";

vi.mock("../config/runtime.js", () => ({
  resolveToolRuntime: async () => getFakeRuntime(),
}));

const { explainAlert, isAmbiguousExplain } = await import("./explain.js");

const llm = (overrides: Partial<LlmResult> = {}): LlmResult => ({
  decisionRequired: true,
  financialRelevance: false,
  riskEscalation: false,
  confidence: 82,
  urgency: "high",
  reason: "Payment failure may lock the account within 48 hours.",
  deadlineDetected: true,
  amountDetected: true,
  suggestedZone: "red",
  ...overrides,
});

const alert = (overrides: Partial<StoredAlert> = {}): StoredAlert => ({
  alertId: "11111111-1111-1111-1111-111111111111",
  shortRef: "111111",
  zone: "red",
  category: "financial-relevance",
  subject: "Invoice overdue",
  from: "Billing <billing@example.com>",
  fromAddress: "billing@example.com",
  domain: "example.com",
  why: "Payment failure may lock the account within 48 hours.",
  sentAt: "2026-04-08T08:00:00.000Z",
  score: 5,
  adjustedScore: 7,
  categoryScores: { "financial-relevance": 5 },
  reasons: ["amount detected", "deadline detected"],
  matchedRuleIds: ["rule-amount", "rule-deadline"],
  policyModifiers: ["sender billing@example.com boosted"],
  llmResult: llm(),
  confidence: 82,
  feedbackState: "pending",
  ...overrides,
});

describe("commands/explain explainAlert", () => {
  beforeEach(() => {
    resetFakeRuntime();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when --instance is missing", async () => {
    await expect(explainAlert({})).rejects.toThrow("Expected --instance <id>");
  });

  it("throws when no selector resolves to an alert", async () => {
    await expect(explainAlert({ instance: "ms-core", alertId: "nope" })).rejects.toThrow(
      "No matching Mail Sentinel alert was found",
    );
  });

  it("explains an alert selected by --alert-id with full policy + semantic detail", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts.push(alert());
    const result = await explainAlert({
      instance: "ms-core",
      alertId: "11111111-1111-1111-1111-111111111111",
    });
    expect(isAmbiguousExplain(result)).toBe(false);
    if (isAmbiguousExplain(result)) {
      throw new Error("expected a resolved explanation");
    }
    expect(result.instanceId).toBe("ms-core");
    expect(result.alertId).toBe("11111111-1111-1111-1111-111111111111");
    expect(result.shortRef).toBe("111111");
    expect(result.subject).toBe("Invoice overdue");
    expect(result.policy).toEqual({
      signals: ["amount detected", "deadline detected"],
      matchedRuleIds: ["rule-amount", "rule-deadline"],
      policyModifiers: ["sender billing@example.com boosted"],
      score: 5,
      adjustedScore: 7,
      categoryScores: { "financial-relevance": 5 },
    });
    expect(result.semantic).toEqual({ available: true, result: llm() });
    expect(result.decision).toEqual({
      zone: "red",
      category: "financial-relevance",
      confidence: 82,
      why: "Payment failure may lock the account within 48 hours.",
    });
  });

  it("selects the newest alert with --latest", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts.push(
      alert({ alertId: "old", shortRef: "oldref", sentAt: "2026-04-08T07:00:00.000Z" }),
      alert({ alertId: "new", shortRef: "newref", sentAt: "2026-04-08T09:00:00.000Z" }),
    );
    const result = await explainAlert({ instance: "ms-core", latest: true });
    if (isAmbiguousExplain(result)) {
      throw new Error("expected a resolved explanation");
    }
    expect(result.alertId).toBe("new");
  });

  it("resolves a free-form --ref through the multi-modal resolver", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts.push(
      alert({ alertId: "abcdef00-0000-0000-0000-000000000000", shortRef: "abcdef" }),
    );
    const result = await explainAlert({ instance: "ms-core", ref: "[abc]" });
    if (isAmbiguousExplain(result)) {
      throw new Error("expected a resolved explanation");
    }
    expect(result.shortRef).toBe("abcdef");
  });

  it("returns an ambiguous result (no explanation) when --ref matches many", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts.push(
      alert({
        alertId: "aa000000-0000-0000-0000-000000000000",
        shortRef: "aa0000",
        subject: "One",
      }),
      alert({
        alertId: "aa111111-0000-0000-0000-000000000000",
        shortRef: "aa1111",
        subject: "Two",
      }),
    );
    const result = await explainAlert({ instance: "ms-core", ref: "aa" });
    expect(isAmbiguousExplain(result)).toBe(true);
    if (!isAmbiguousExplain(result)) {
      throw new Error("expected an ambiguous result");
    }
    expect(result.ref).toBe("aa");
    expect(result.candidates.map((c) => c.subject)).toEqual(["One", "Two"]);
  });

  it("throws when a --ref matches nothing in any modality", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts.push(alert());
    await expect(explainAlert({ instance: "ms-core", ref: "zzzzzz" })).rejects.toThrow(
      "No matching Mail Sentinel alert was found",
    );
  });

  it("marks the semantic review unavailable when no llmResult was recorded", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts.push(alert({ llmResult: null }));
    const result = await explainAlert({
      instance: "ms-core",
      alertId: "11111111-1111-1111-1111-111111111111",
    });
    if (isAmbiguousExplain(result)) {
      throw new Error("expected a resolved explanation");
    }
    expect(result.semantic).toEqual({ available: false });
  });

  it("omits optional policy/decision fields that the alert never carried", async () => {
    const runtime = getFakeRuntime();
    // A minimal legacy alert: no score/adjustedScore/categoryScores/confidence,
    // no reasons/matchedRuleIds/policyModifiers, no llmResult field at all.
    runtime.state.alerts.push({
      alertId: "22222222-2222-2222-2222-222222222222",
      shortRef: "222222",
      zone: "amber",
      category: "decision-required",
      subject: "Legacy",
      from: "legacy@example.com",
      why: "Flagged by Mail Sentinel.",
      sentAt: "2026-04-08T08:00:00.000Z",
      feedbackState: "pending",
    });
    const result = await explainAlert({
      instance: "ms-core",
      alertId: "22222222-2222-2222-2222-222222222222",
    });
    if (isAmbiguousExplain(result)) {
      throw new Error("expected a resolved explanation");
    }
    expect(result.policy).toEqual({ signals: [], matchedRuleIds: [], policyModifiers: [] });
    expect(result.semantic).toEqual({ available: false });
    expect(result.decision).toEqual({
      zone: "amber",
      category: "decision-required",
      why: "Flagged by Mail Sentinel.",
    });
  });
});
