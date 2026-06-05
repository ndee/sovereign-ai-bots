import { describe, expect, it } from "vitest";
import { sampleMessage, sampleRules, sampleState } from "../__fixtures__/inputs.js";
import { loadGolden } from "../__fixtures__/load.js";
import type { LlmResult, PolicyEvaluationResult } from "../types.js";
import {
  buildLlmCandidate,
  buildLlmPrompt,
  buildLlmSchema,
  buildUserFacingWhy,
  determineZone,
  normalizeLlmResult,
  quoteLobsterArg,
} from "./llm.js";

const llmResult = (reason: string, overrides: Partial<LlmResult> = {}): LlmResult => ({
  decisionRequired: false,
  financialRelevance: false,
  riskEscalation: false,
  confidence: 80,
  urgency: "medium",
  reason,
  deadlineDetected: false,
  amountDetected: false,
  suggestedZone: "red",
  ...overrides,
});

const neutralPolicy: PolicyEvaluationResult = {
  scoreModifier: 0,
  zoneFloor: null,
  zoneCeiling: null,
  muted: false,
  minConfidence: null,
  reasons: [],
  matchedPolicyIds: [],
};

describe("scoring/llm", () => {
  it("matches the quoteLobsterArg golden fixture", () => {
    expect({
      simple: quoteLobsterArg("hello"),
      withQuotes: quoteLobsterArg('he said "hi"'),
    }).toEqual(loadGolden("quoteLobsterArg"));
  });

  it("matches the buildLlmPrompt golden fixture", () => {
    expect(buildLlmPrompt()).toEqual(loadGolden("buildLlmPrompt"));
  });

  it("matches the buildLlmSchema golden fixture", () => {
    expect(buildLlmSchema()).toEqual(loadGolden("buildLlmSchema"));
  });

  it("matches the normalizeLlmResult golden fixture", () => {
    expect({
      full: normalizeLlmResult({
        decision_required: true,
        financial_relevance: true,
        risk_escalation: false,
        confidence: 82.7,
        urgency: "high",
        reason: "   clear   invoice   ",
        deadline_detected: true,
        amount_detected: true,
        suggested_zone: "red",
      }),
      defaults: normalizeLlmResult({}),
    }).toEqual(loadGolden("normalizeLlmResult"));
  });

  it("clamps confidence to 0-100 when the input is out of range", () => {
    expect(normalizeLlmResult({ confidence: 150 }).confidence).toBe(100);
    expect(normalizeLlmResult({ confidence: -5 }).confidence).toBe(0);
    expect(normalizeLlmResult({ confidence: "nope" }).confidence).toBe(0);
  });

  it("falls back to gray when suggested_zone is invalid", () => {
    expect(normalizeLlmResult({ suggested_zone: "purple" }).suggestedZone).toBe("gray");
  });

  it("falls back to low when urgency is invalid", () => {
    expect(normalizeLlmResult({ urgency: "extreme" }).urgency).toBe("low");
  });

  it("accepts medium urgency explicitly", () => {
    expect(normalizeLlmResult({ urgency: "medium" }).urgency).toBe("medium");
  });

  it("matches the buildLlmCandidate golden fixture", () => {
    expect(
      buildLlmCandidate(
        sampleMessage,
        {
          score: 5,
          category: "financial-relevance",
          categoryScores: {
            "decision-required": 0,
            "financial-relevance": 5,
            "risk-escalation": 0,
          },
          matchedRuleIds: ["rule-invoice"],
          reasons: ["subject mentions an invoice"],
        },
        { reasons: ["known-good"] },
        sampleState,
      ),
    ).toEqual(loadGolden("buildLlmCandidate"));
  });

  it("matches the determineZone golden fixture", () => {
    expect({
      noCandidate: determineZone({
        scored: {
          score: 1,
          categoryScores: {
            "decision-required": 0,
            "financial-relevance": 1,
            "risk-escalation": 0,
          },
          category: "financial-relevance",
        },
        policyResult: neutralPolicy,
        llmResult: null,
        rules: sampleRules,
      }),
      candidateNoLlm: determineZone({
        scored: {
          score: 5,
          categoryScores: {
            "decision-required": 0,
            "financial-relevance": 5,
            "risk-escalation": 0,
          },
          category: "financial-relevance",
        },
        policyResult: neutralPolicy,
        llmResult: null,
        rules: sampleRules,
      }),
      llmRed: determineZone({
        scored: {
          score: 6,
          categoryScores: {
            "decision-required": 0,
            "financial-relevance": 6,
            "risk-escalation": 0,
          },
          category: "financial-relevance",
        },
        policyResult: neutralPolicy,
        llmResult: {
          decisionRequired: true,
          financialRelevance: true,
          riskEscalation: false,
          confidence: 90,
          urgency: "high",
          reason: "clear invoice",
          deadlineDetected: true,
          amountDetected: true,
          suggestedZone: "red",
        },
        rules: sampleRules,
      }),
      muted: determineZone({
        scored: {
          score: 6,
          categoryScores: {
            "decision-required": 0,
            "financial-relevance": 6,
            "risk-escalation": 0,
          },
          category: "financial-relevance",
        },
        policyResult: { ...neutralPolicy, muted: true, reasons: ["muted"] },
        llmResult: null,
        rules: sampleRules,
      }),
    }).toEqual(loadGolden("determineZone"));
  });

  it("falls to gray when a policy min-confidence is not met", () => {
    const result = determineZone({
      scored: {
        score: 6,
        categoryScores: {
          "decision-required": 0,
          "financial-relevance": 6,
          "risk-escalation": 0,
        },
        category: "financial-relevance",
      },
      policyResult: { ...neutralPolicy, minConfidence: 80 },
      llmResult: {
        decisionRequired: true,
        financialRelevance: false,
        riskEscalation: false,
        confidence: 50,
        urgency: "high",
        reason: "not enough evidence",
        deadlineDetected: false,
        amountDetected: false,
        suggestedZone: "red",
      },
      rules: sampleRules,
    });
    expect(result.zone).toBe("gray");
    expect(result.reasons.some((r) => r.includes("80%"))).toBe(true);
  });

  it("escalates to red via non-suggested-red path (urgency high + relevant)", () => {
    const result = determineZone({
      scored: {
        score: 10,
        categoryScores: {
          "decision-required": 0,
          "financial-relevance": 10,
          "risk-escalation": 0,
        },
        category: "financial-relevance",
      },
      policyResult: neutralPolicy,
      llmResult: {
        decisionRequired: true,
        financialRelevance: false,
        riskEscalation: false,
        confidence: 80,
        urgency: "high",
        reason: "urgent",
        deadlineDetected: false,
        amountDetected: false,
        suggestedZone: "amber",
      },
      rules: sampleRules,
    });
    expect(result.zone).toBe("red");
  });

  it("picks amber via the mid-tier LLM branch", () => {
    const result = determineZone({
      scored: {
        score: 4,
        categoryScores: {
          "decision-required": 0,
          "financial-relevance": 4,
          "risk-escalation": 0,
        },
        category: "financial-relevance",
      },
      policyResult: neutralPolicy,
      llmResult: {
        decisionRequired: false,
        financialRelevance: false,
        riskEscalation: false,
        confidence: 50,
        urgency: "medium",
        reason: "maybe",
        deadlineDetected: false,
        amountDetected: false,
        suggestedZone: "amber",
      },
      rules: sampleRules,
    });
    expect(result.zone).toBe("amber");
  });

  it("downgrades suggested-red to amber via the mid-tier LLM branch", () => {
    const result = determineZone({
      scored: {
        score: 3,
        categoryScores: {
          "decision-required": 0,
          "financial-relevance": 3,
          "risk-escalation": 0,
        },
        category: "financial-relevance",
      },
      policyResult: neutralPolicy,
      llmResult: {
        decisionRequired: false,
        financialRelevance: false,
        riskEscalation: false,
        confidence: 55,
        urgency: "medium",
        reason: "maybe not red",
        deadlineDetected: false,
        amountDetected: false,
        suggestedZone: "red",
      },
      rules: sampleRules,
    });
    expect(result.zone).toBe("amber");
  });

  it("returns gray via the final LLM fallback when nothing is relevant", () => {
    const result = determineZone({
      scored: {
        score: 3,
        categoryScores: {
          "decision-required": 0,
          "financial-relevance": 3,
          "risk-escalation": 0,
        },
        category: "financial-relevance",
      },
      policyResult: neutralPolicy,
      llmResult: {
        decisionRequired: false,
        financialRelevance: false,
        riskEscalation: false,
        confidence: 10,
        urgency: "low",
        reason: "weak",
        deadlineDetected: false,
        amountDetected: false,
        suggestedZone: "gray",
      },
      rules: sampleRules,
    });
    expect(result.zone).toBe("gray");
  });

  it("returns amber via the relevant-only LLM branch", () => {
    const llmResult: LlmResult = {
      decisionRequired: false,
      financialRelevance: false,
      riskEscalation: false,
      confidence: 30,
      urgency: "low",
      reason: "just relevant",
      deadlineDetected: false,
      amountDetected: false,
      suggestedZone: "gray",
    };
    const result = determineZone({
      scored: {
        score: 10,
        categoryScores: {
          "decision-required": 0,
          "financial-relevance": 10,
          "risk-escalation": 0,
        },
        category: "financial-relevance",
      },
      policyResult: neutralPolicy,
      llmResult,
      rules: sampleRules,
    });
    expect(result.zone).toBe("amber");
  });

  it("returns amber from the no-LLM candidate branch when no rule relevance", () => {
    const result = determineZone({
      scored: {
        score: 3,
        categoryScores: {
          "decision-required": 0,
          "financial-relevance": 3,
          "risk-escalation": 0,
        },
        category: "financial-relevance",
      },
      policyResult: neutralPolicy,
      llmResult: null,
      rules: sampleRules,
    });
    expect(result.zone).toBe("amber");
  });

  it("reaches red via the second-tier path with relevant only (no dec/risk)", () => {
    // This test hits the second `else if (red ...)` branch with only the
    // `relevant` operand truthy.
    const result = determineZone({
      scored: {
        score: 10,
        categoryScores: {
          "decision-required": 0,
          "financial-relevance": 10,
          "risk-escalation": 0,
        },
        category: "financial-relevance",
      },
      policyResult: neutralPolicy,
      llmResult: {
        decisionRequired: false,
        financialRelevance: false,
        riskEscalation: false,
        confidence: 90,
        urgency: "medium",
        reason: "relevant only",
        deadlineDetected: false,
        amountDetected: false,
        suggestedZone: "amber",
      },
      rules: sampleRules,
    });
    expect(result.zone).toBe("red");
  });

  it("reaches red via the second-tier path with riskEscalation", () => {
    // This test hits the second `else if (... red ...)` branch: suggestedZone
    // is not red, but urgency is high and riskEscalation is true.
    const result = determineZone({
      scored: {
        score: 5,
        categoryScores: {
          "decision-required": 0,
          "financial-relevance": 0,
          "risk-escalation": 5,
        },
        category: "risk-escalation",
      },
      policyResult: neutralPolicy,
      llmResult: {
        decisionRequired: false,
        financialRelevance: false,
        riskEscalation: true,
        confidence: 90,
        urgency: "high",
        reason: "risk",
        deadlineDetected: false,
        amountDetected: false,
        suggestedZone: "amber",
      },
      rules: sampleRules,
    });
    expect(result.zone).toBe("red");
  });

  it("reaches red via financialRelevance alone", () => {
    const result = determineZone({
      scored: {
        score: 6,
        categoryScores: {
          "decision-required": 0,
          "financial-relevance": 6,
          "risk-escalation": 0,
        },
        category: "financial-relevance",
      },
      policyResult: neutralPolicy,
      llmResult: {
        decisionRequired: false,
        financialRelevance: true,
        riskEscalation: false,
        confidence: 90,
        urgency: "high",
        reason: "financial",
        deadlineDetected: false,
        amountDetected: true,
        suggestedZone: "red",
      },
      rules: sampleRules,
    });
    expect(result.zone).toBe("red");
  });

  it("reaches red via riskEscalation alone", () => {
    const result = determineZone({
      scored: {
        score: 6,
        categoryScores: {
          "decision-required": 0,
          "financial-relevance": 0,
          "risk-escalation": 6,
        },
        category: "risk-escalation",
      },
      policyResult: neutralPolicy,
      llmResult: {
        decisionRequired: false,
        financialRelevance: false,
        riskEscalation: true,
        confidence: 90,
        urgency: "high",
        reason: "risk",
        deadlineDetected: false,
        amountDetected: false,
        suggestedZone: "red",
      },
      rules: sampleRules,
    });
    expect(result.zone).toBe("red");
  });

  it("reaches red via relevant alone (none of the specific booleans set)", () => {
    const result = determineZone({
      scored: {
        score: 10,
        categoryScores: {
          "decision-required": 0,
          "financial-relevance": 10,
          "risk-escalation": 0,
        },
        category: "financial-relevance",
      },
      policyResult: neutralPolicy,
      llmResult: {
        decisionRequired: false,
        financialRelevance: false,
        riskEscalation: false,
        confidence: 90,
        urgency: "low",
        reason: "relevant",
        deadlineDetected: false,
        amountDetected: false,
        suggestedZone: "red",
      },
      rules: sampleRules,
    });
    expect(result.zone).toBe("red");
  });

  it("uses the raw amount in buildLlmCandidate when amountSignal is null", () => {
    const result = buildLlmCandidate(
      { ...sampleMessage, amountSignal: null },
      {
        score: 0,
        category: "financial-relevance",
        categoryScores: {
          "decision-required": 0,
          "financial-relevance": 0,
          "risk-escalation": 0,
        },
        matchedRuleIds: [],
        reasons: [],
      },
      { reasons: [] },
      sampleState,
    );
    expect(result.extractedSignals.amount).toBeNull();
  });

  it("handles a category with no score entry (categoryScores ?? 0)", () => {
    const result = determineZone({
      scored: {
        score: 5,
        categoryScores: {}, // no category scores at all
        category: "financial-relevance",
      },
      policyResult: neutralPolicy,
      llmResult: null,
      rules: sampleRules,
    });
    // adjustedCategoryScore = 0 + 0; relevant = false; candidate depends on score
    expect(result.zone).toBe("amber");
  });

  it("respects policy zoneFloor when heuristic is below candidate", () => {
    const result = determineZone({
      scored: {
        score: 0,
        categoryScores: {
          "decision-required": 0,
          "financial-relevance": 0,
          "risk-escalation": 0,
        },
        category: "financial-relevance",
      },
      policyResult: { ...neutralPolicy, zoneFloor: "amber" },
      llmResult: null,
      rules: sampleRules,
    });
    expect(result.zone).toBe("amber");
  });

  const redLlm = (): LlmResult => ({
    decisionRequired: true,
    financialRelevance: true,
    riskEscalation: false,
    confidence: 90,
    urgency: "high",
    reason: "clear invoice",
    deadlineDetected: true,
    amountDetected: true,
    suggestedZone: "red",
  });

  const bulkRedScored = {
    score: 6,
    categoryScores: {
      "decision-required": 0,
      "financial-relevance": 6,
      "risk-escalation": 0,
    },
    category: "financial-relevance" as const,
  };

  it("caps an urgent bulk mail at amber and names the signals", () => {
    const result = determineZone({
      scored: bulkRedScored,
      policyResult: neutralPolicy,
      llmResult: redLlm(),
      rules: sampleRules,
      bulk: {
        isBulk: true,
        confidence: 0.5,
        signals: ["list-unsubscribe header", "high link density (10 links)"],
        ceiling: "amber",
      },
    });
    expect(result.zone).toBe("amber");
    expect(result.reasons).toContain(
      "Held at amber: looks like a newsletter — list-unsubscribe header, high link density (10 links)",
    );
  });

  it("lets an explicit user floor override the bulk ceiling (floor wins)", () => {
    const result = determineZone({
      scored: bulkRedScored,
      policyResult: { ...neutralPolicy, zoneFloor: "red" },
      llmResult: redLlm(),
      rules: sampleRules,
      bulk: {
        isBulk: true,
        confidence: 1,
        signals: ["list-unsubscribe header", "newsletter / campaign language"],
        ceiling: "gray",
      },
    });
    expect(result.zone).toBe("red");
    expect(result.reasons).toContain("user policy floor overrides bulk suppression");
  });

  it("pulls an amber candidate down to gray under a gray bulk ceiling", () => {
    const result = determineZone({
      scored: {
        score: 5,
        categoryScores: {
          "decision-required": 0,
          "financial-relevance": 5,
          "risk-escalation": 0,
        },
        category: "financial-relevance",
      },
      policyResult: neutralPolicy,
      llmResult: null,
      rules: sampleRules,
      bulk: {
        isBulk: true,
        confidence: 1,
        signals: ["bulk-mail infrastructure headers", "newsletter / campaign language"],
        ceiling: "gray",
      },
    });
    expect(result.zone).toBe("gray");
    expect(result.reasons).toContain(
      "Held at gray: looks like a newsletter — bulk-mail infrastructure headers, newsletter / campaign language",
    );
  });

  it("leaves the zone untouched when detection found no bulk", () => {
    const result = determineZone({
      scored: bulkRedScored,
      policyResult: neutralPolicy,
      llmResult: redLlm(),
      rules: sampleRules,
      bulk: {
        isBulk: false,
        confidence: 0.25,
        signals: ["list-unsubscribe header"],
        ceiling: null,
      },
    });
    expect(result.zone).toBe("red");
    expect(result.reasons).not.toContain("user policy floor overrides bulk suppression");
    expect(result.reasons.some((reason) => reason.startsWith("Held at"))).toBe(false);
  });
});

describe("buildUserFacingWhy", () => {
  it("prefers the LLM reason when it's operator-facing", () => {
    expect(
      buildUserFacingWhy(
        { reasons: ["policy p-sender (known-good)", "policy matched sender alice@example.com"] },
        llmResult("Payment failure may lead to account restrictions within 48 hours."),
      ),
    ).toBe("Payment failure may lead to account restrictions within 48 hours.");
  });

  it("trims the LLM reason to a single sentence", () => {
    expect(
      buildUserFacingWhy(
        { reasons: [] },
        llmResult("Invoice due today. Late fees after 24 hours. Vendor will escalate."),
      ),
    ).toBe("Invoice due today.");
  });

  it("caps very long LLM reasons with an ellipsis", () => {
    const long = `${"x".repeat(200)} tail`;
    const out = buildUserFacingWhy({ reasons: [] }, llmResult(long));
    expect(out.length).toBeLessThanOrEqual(180);
    expect(out.endsWith("…")).toBe(true);
  });

  it("falls back to the first non-internal zone reason when LLM reason is empty", () => {
    expect(
      buildUserFacingWhy(
        {
          reasons: [
            "policy p-sender (known-good)",
            "Vendor warned about pending account suspension.",
          ],
        },
        llmResult(""),
      ),
    ).toBe("Vendor warned about pending account suspension.");
  });

  it("falls back to the first non-internal zone reason when no LLM result", () => {
    expect(
      buildUserFacingWhy(
        { reasons: ["heuristics matched", "Invoice overdue; vendor may suspend service."] },
        null,
      ),
    ).toBe("Invoice overdue; vendor may suspend service.");
  });

  it("falls back to the first raw reason when everything looks internal", () => {
    expect(
      buildUserFacingWhy(
        { reasons: ["heuristics did not keep the mail above candidate threshold"] },
        null,
      ),
    ).toBe("heuristics did not keep the mail above candidate threshold");
  });

  it("uses a generic fallback when reasons are empty and no LLM", () => {
    expect(buildUserFacingWhy({ reasons: [] }, null)).toBe("Flagged by Mail Sentinel.");
  });

  it("treats an LLM reason containing internal vocabulary as non-operator-facing", () => {
    expect(
      buildUserFacingWhy(
        { reasons: ["Deadline detected in body; vendor will escalate."] },
        llmResult("Matched policy for risk-escalation rule."),
      ),
    ).toBe("Deadline detected in body; vendor will escalate.");
  });
});
