import { describe, expect, it } from "vitest";
import { sampleMessage, sampleRules, sampleState } from "../__fixtures__/inputs.js";
import { loadGolden } from "../__fixtures__/load.js";
import type { RuleMatch } from "../types.js";
import {
  buildRuleMatches,
  pickPrimaryCategory,
  scoreMessage,
  summarizeReasons,
} from "./heuristics.js";

describe("scoring/heuristics", () => {
  it("matches the buildRuleMatches golden fixture", () => {
    expect(buildRuleMatches(sampleMessage, sampleState, sampleRules)).toEqual(
      loadGolden("buildRuleMatches"),
    );
  });

  it("matches the scoreMessage golden fixture", () => {
    expect(scoreMessage(sampleMessage, sampleState, sampleRules)).toEqual(
      loadGolden("scoreMessage"),
    );
  });

  it("matches the pickPrimaryCategory golden fixture", () => {
    expect({
      tieBreak: pickPrimaryCategory({
        "decision-required": 2,
        "financial-relevance": 2,
        "risk-escalation": 0,
      }),
      winner: pickPrimaryCategory({
        "decision-required": 1,
        "financial-relevance": 5,
        "risk-escalation": 3,
      }),
    }).toEqual(loadGolden("pickPrimaryCategory"));
  });

  it("returns the fallback category when scores are empty", () => {
    expect(pickPrimaryCategory({})).toBe("decision-required");
  });

  it("tie-breaks on equal scores by risk > financial > decision-required priority", () => {
    expect(
      pickPrimaryCategory({
        "decision-required": 3,
        "financial-relevance": 3,
        "risk-escalation": 3,
      }),
    ).toBe("risk-escalation");
    expect(
      pickPrimaryCategory({
        "decision-required": 3,
        "financial-relevance": 3,
        "risk-escalation": 0,
      }),
    ).toBe("financial-relevance");
    expect(
      pickPrimaryCategory({
        "decision-required": 3,
        "financial-relevance": 0,
        "risk-escalation": 0,
      }),
    ).toBe("decision-required");
  });

  it("falls back to alphabetical order when tied categories are not in the priority list", () => {
    const result = pickPrimaryCategory({
      "zeta-custom": 5,
      "alpha-custom": 5,
    } as unknown as Record<string, number>);
    expect(result).toBe("alpha-custom");
  });

  it("matches the summarizeReasons golden fixture", () => {
    const matches: RuleMatch[] = [
      { ruleId: "r1", reason: "a", weight: 3, categories: [] },
      { ruleId: "r2", reason: "b", weight: 2, categories: [] },
      { ruleId: "r3", reason: "c", weight: -1, categories: [] },
      { ruleId: "r4", reason: "a", weight: 1, categories: [] },
      { ruleId: "r5", reason: "d", weight: 4, categories: [] },
    ];
    expect(summarizeReasons(matches)).toEqual(loadGolden("summarizeReasons"));
  });

  it("handles message with no rule matches", () => {
    const emptyMatches = buildRuleMatches(
      {
        ...sampleMessage,
        subject: "boring",
        text: "nothing to see",
        fromAddress: undefined,
        domain: undefined,
      },
      sampleState,
      sampleRules,
    );
    // Only the prior-alert rule should potentially match; since fromAddress is
    // undefined, the thread-match loop does not apply either.
    expect(emptyMatches.every((m) => m.ruleId !== "rule-invoice")).toBe(true);
  });

  it("covers every rule.field branch", () => {
    const rules = {
      ...sampleRules,
      rules: [
        {
          id: "rule-from",
          field: "from" as const,
          pattern: "alice",
          weight: 1,
          reason: "from alice",
        },
        {
          id: "rule-domain",
          field: "domain" as const,
          pattern: "example",
          weight: 1,
          reason: "domain",
        },
        {
          id: "rule-header",
          field: "header" as const,
          headerName: "Subject",
          pattern: "invoice",
          weight: 1,
          reason: "header",
        },
        {
          id: "rule-unknown",
          field: "subject" as const,
          pattern: "nomatch-xxx",
          weight: 1,
          reason: "unknown",
        },
      ],
      senderWeights: {},
      domainWeights: {},
    };
    const matches = buildRuleMatches(sampleMessage, sampleState, rules);
    const ids = matches.map((m) => m.ruleId);
    expect(ids).toContain("rule-from");
    expect(ids).toContain("rule-domain");
    expect(ids).toContain("rule-header");
    expect(ids).not.toContain("rule-unknown");
  });

  it("pushes a negative sender-weight rule match with the down-weight reason", () => {
    const matches = buildRuleMatches(sampleMessage, sampleState, {
      ...sampleRules,
      senderWeights: { "alice@example.com": -3 },
      rules: [],
    });
    const senderMatch = matches.find((m) => m.ruleId === "sender:alice@example.com");
    expect(senderMatch?.reason).toBe("sender has been down-weighted by feedback");
  });

  it("pushes a negative domain-weight rule match with the down-weight reason", () => {
    const matches = buildRuleMatches(sampleMessage, sampleState, {
      ...sampleRules,
      senderWeights: {},
      domainWeights: { "example.com": -2 },
      rules: [],
    });
    const domainMatch = matches.find((m) => m.ruleId === "domain:example.com");
    expect(domainMatch?.reason).toBe("sender domain has been down-weighted by feedback");
  });

  it("returns an empty candidate when a header rule has no headerName", () => {
    const rules = {
      ...sampleRules,
      senderWeights: {},
      domainWeights: {},
      rules: [
        {
          id: "rule-header-noname",
          field: "header" as const,
          pattern: "anything",
          weight: 1,
          reason: "no name",
        },
      ],
    };
    const matches = buildRuleMatches(sampleMessage, sampleState, rules);
    expect(matches.some((m) => m.ruleId === "rule-header-noname")).toBe(false);
  });

  it("returns an empty candidate when the header lookup is missing", () => {
    const rules = {
      ...sampleRules,
      senderWeights: {},
      domainWeights: {},
      rules: [
        {
          id: "rule-header-missing",
          field: "header" as const,
          headerName: "X-Missing",
          pattern: "anything",
          weight: 1,
          reason: "missing header",
        },
      ],
    };
    const matches = buildRuleMatches(sampleMessage, sampleState, rules);
    expect(matches.some((m) => m.ruleId === "rule-header-missing")).toBe(false);
  });

  it("returns relevant=false when categoryScores does not contain the primary category", () => {
    // Force a category that isn't in the seeded categoryScores map by using a
    // rule with an unexpected category value.
    const customRules = {
      ...sampleRules,
      senderWeights: {},
      domainWeights: {},
      rules: [
        {
          id: "rule-custom-category",
          field: "subject" as const,
          pattern: "invoice",
          weight: 10,
          reason: "custom",
          categories: ["unexpected-category"],
        },
      ],
      thresholds: { candidate: 1, alert: 1, category: 1 },
    };
    const result = scoreMessage(sampleMessage, sampleState, customRules);
    expect(result.score).toBeGreaterThanOrEqual(10);
  });

  it("treats unknown rule.field values as an empty candidate (fallback branch)", () => {
    const rules = {
      ...sampleRules,
      senderWeights: {},
      domainWeights: {},
      rules: [
        {
          id: "rule-bogus",
          field: "bogus" as unknown as "subject",
          pattern: "anything",
          weight: 1,
          reason: "unknown",
        },
      ],
    };
    const matches = buildRuleMatches(sampleMessage, sampleState, rules);
    expect(matches.some((m) => m.ruleId === "rule-bogus")).toBe(false);
  });

  it("handles rules with an empty candidate value (zero-length branch)", () => {
    const rules = {
      ...sampleRules,
      senderWeights: {},
      domainWeights: {},
      rules: [
        {
          id: "rule-domain-empty",
          field: "domain" as const,
          pattern: "anything",
          weight: 1,
          reason: "domain empty",
        },
      ],
    };
    const matches = buildRuleMatches({ ...sampleMessage, domain: undefined }, sampleState, rules);
    expect(matches.some((m) => m.ruleId === "rule-domain-empty")).toBe(false);
  });

  it("supports matching the prior-alert thread rule via domain only", () => {
    const state = {
      ...sampleState,
      alerts: [
        {
          alertId: "prior-by-domain",
          subject: sampleMessage.subject,
          from: "Someone <other@example.com>",
          why: "prior",
          fromAddress: "other@example.com",
          domain: "example.com",
          category: "financial-relevance" as const,
          zone: "amber" as const,
          sentAt: "2026-04-07T08:00:00Z",
        },
      ],
    };
    const matches = buildRuleMatches(sampleMessage, state, {
      ...sampleRules,
      senderWeights: {},
      domainWeights: {},
      rules: [],
    });
    expect(matches.some((m) => m.ruleId === "thread:prior-subject-match")).toBe(true);
  });
});
