import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getFakeRuntime, resetFakeRuntime } from "../__fixtures__/fake-runtime.js";
import { formatFeedbackResult } from "../alerts/output.js";
import { scoreMessage } from "../scoring/heuristics.js";
import type { ParsedMessage, RulesDocument, StoredAlert } from "../types.js";

vi.mock("../config/runtime.js", () => ({
  resolveToolRuntime: async () => getFakeRuntime(),
}));

vi.mock("../state/io.js", async () => {
  const actual = await vi.importActual<typeof import("../state/io.js")>("../state/io.js");
  return {
    ...actual,
    withLockedState: async <T>(_p: string, action: () => Promise<T>) => action(),
  };
});

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    randomUUID: () => "00000000-0000-0000-0000-000000000000",
  };
});

const { applyFeedback, isAmbiguousFeedback, summarizeLearned } = await import("./feedback.js");
const { policyList, policyRemove } = await import("./policy.js");

const applied = (result: Awaited<ReturnType<typeof applyFeedback>>) => {
  if (isAmbiguousFeedback(result)) {
    throw new Error("expected an applied feedback result, got ambiguous");
  }
  return result;
};

const alertFrom = (
  alertId: string,
  address: string,
  overrides: Partial<StoredAlert> = {},
): StoredAlert => ({
  alertId,
  zone: "red",
  category: "risk-escalation",
  subject: "Deadline tomorrow",
  from: address,
  fromAddress: address,
  domain: address.split("@")[1],
  why: "w",
  sentAt: "2026-04-08T09:00:00.000Z",
  feedbackState: "pending",
  matchedRuleIds: ["rule-deadline"],
  ...overrides,
});

const message = (address: string, subject = "Status update"): ParsedMessage => ({
  key: `msg:${address}:${subject}`,
  uid: 1,
  subject,
  normalizedThreadSubject: subject.toLowerCase(),
  from: address,
  fromAddress: address,
  domain: address.split("@")[1],
  text: "Hello",
  snippet: "Hello",
  headers: {},
  toAddresses: [],
  amountSignal: null,
  deadlineDetected: false,
});

const rules = (): RulesDocument => ({
  version: 2,
  thresholds: { candidate: 3, alert: 4, category: 4 },
  zoneThresholds: {
    redMinConfidence: 75,
    amberMinConfidence: 40,
    redMinHeuristicScore: 4,
    amberMinHeuristicScore: 3,
  },
  senderWeights: {},
  domainWeights: {},
  bulk: { enabled: true, minSignals: 2, minLinks: 8, grayConfidence: 0.7 },
  rules: [
    {
      id: "rule-deadline",
      field: "subject",
      pattern: "deadline",
      weight: 2,
      reason: "mentions a deadline",
      categories: ["risk-escalation"],
    },
  ],
});

const feedback = async (alertId: string, action: string, extra: Record<string, unknown> = {}) =>
  applied(
    await applyFeedback({
      instance: "ms-core",
      alertId,
      action: action as never,
      ...extra,
    }),
  );

describe("feedback learning", () => {
  beforeEach(() => {
    resetFakeRuntime();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("learns per sender address only", () => {
    it("raises later mail from the same address and leaves other addresses at the same domain unchanged", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [alertFrom("alert-a", "a@x.example")];
      const doc = rules();
      const before = {
        a: scoreMessage(message("a@x.example"), runtime.state, doc).score,
        b: scoreMessage(message("b@x.example"), runtime.state, doc).score,
        other: scoreMessage(message("c@y.example"), runtime.state, doc).score,
      };

      await feedback("alert-a", "important");

      expect(scoreMessage(message("a@x.example"), runtime.state, doc).score).toBe(before.a + 2);
      expect(scoreMessage(message("b@x.example"), runtime.state, doc).score).toBe(before.b);
      expect(scoreMessage(message("c@y.example"), runtime.state, doc).score).toBe(before.other);
    });

    it.each([
      ["important", {}],
      ["not-important", {}],
      ["less-often", {}],
      ["reduce", {}],
      ["reduce", { scope: "sender" }],
      ["reduce", { scope: "domain" }],
    ])("%s %o never writes a learned domain weight", async (action, extra) => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [alertFrom("alert-a", "a@x.example", { zone: "amber" })];
      runtime.state.learning.domainWeights = { "x.example": 3 };
      await feedback("alert-a", action, extra);
      expect(runtime.state.learning.domainWeights).toEqual({ "x.example": 3 });
    });

    it("ignores a learned domain weight stored by an earlier version but keeps it on disk", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [alertFrom("alert-a", "a@x.example")];
      runtime.state.learning.domainWeights = { "x.example": 5 };
      const doc = rules();

      const scored = scoreMessage(message("b@x.example"), runtime.state, doc);
      expect(scored.matchedRuleIds).not.toContain("domain:x.example");
      expect(scored.score).toBe(0);

      await feedback("alert-a", "important");
      expect(runtime.state.learning.domainWeights).toEqual({ "x.example": 5 });
      expect(scoreMessage(message("b@x.example"), runtime.state, doc).score).toBe(0);
    });

    it("still applies an operator-configured domain weight", () => {
      const runtime = getFakeRuntime();
      runtime.state.learning.domainWeights = { "x.example": 5 };
      const doc = { ...rules(), domainWeights: { "x.example": 1 } };
      const scored = scoreMessage(message("b@x.example"), runtime.state, doc);
      expect(scored.matchedRuleIds).toContain("domain:x.example");
      expect(scored.score).toBe(1);
    });
  });

  describe("is idempotent and reversible per alert", () => {
    it("changes nothing when the same action is given twice on one alert", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [alertFrom("alert-a", "a@x.example")];
      const first = await feedback("alert-a", "important");
      expect(first.changed).toBe(true);
      const snapshot = structuredClone(runtime.state);

      const second = await feedback("alert-a", "important");
      expect(second.changed).toBe(false);
      expect(second.note).toBe('Already recorded as "important" for this alert. Nothing changed.');
      expect(second.learned).toEqual({ changed: false, rules: [] });
      expect(second.learnedSummary).toBe("No learned weight changed.");
      expect(runtime.state).toEqual(snapshot);
      expect(runtime.state.learning.senderWeights["a@x.example"]).toBe(2);
      expect(runtime.state.learning.ruleAdjustments["rule-deadline"]).toBe(1);
    });

    it("still clears a pending reminder when the same rating is repeated", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [alertFrom("alert-a", "a@x.example")];
      await feedback("alert-a", "important");
      await feedback("alert-a", "remind-later");
      const result = await feedback("alert-a", "important");
      expect(result.changed).toBe(true);
      expect(result.learned.changed).toBe(false);
      expect(runtime.state.alerts[0]?.reminderDueAt).toBeUndefined();
      expect(runtime.state.learning.senderWeights["a@x.example"]).toBe(2);
      expect(runtime.state.learning.ruleAdjustments["rule-deadline"]).toBe(1);
    });

    it("treats a repeated item-scope policy action as a no-op too", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [alertFrom("alert-a", "a@x.example", { zone: "amber" })];
      await feedback("alert-a", "reduce");
      const second = await feedback("alert-a", "reduce");
      expect(second.changed).toBe(false);
      expect(runtime.state.learning.senderWeights["a@x.example"]).toBe(-2);
      expect(runtime.state.feedback).toHaveLength(1);
    });

    it("keeps the learned weight unchanged when a scoped policy action is repeated", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [alertFrom("alert-a", "a@x.example", { zone: "amber" })];
      await feedback("alert-a", "reduce", { scope: "sender" });
      const second = await feedback("alert-a", "reduce", { scope: "domain" });
      expect(second.changed).toBe(true);
      expect(second.policyId).toBeDefined();
      expect(runtime.state.learning.senderWeights["a@x.example"]).toBe(-2);
      expect(second.learned.changed).toBe(false);
    });

    it("leaves exactly one not-important contribution after important -> not-important", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [alertFrom("alert-a", "a@x.example")];
      runtime.state.learning.senderWeights = { "a@x.example": 1 };
      runtime.state.learning.ruleAdjustments = { "rule-deadline": 1 };

      await feedback("alert-a", "important");
      expect(runtime.state.learning.senderWeights["a@x.example"]).toBe(3);
      expect(runtime.state.learning.ruleAdjustments["rule-deadline"]).toBe(2);

      const result = await feedback("alert-a", "not-important");
      expect(runtime.state.learning.senderWeights["a@x.example"]).toBe(-1);
      expect(runtime.state.learning.ruleAdjustments["rule-deadline"]).toBeUndefined();
      expect(result.learned).toEqual({
        changed: true,
        sender: { address: "a@x.example", before: 3, after: -1, min: -4, max: 4 },
        rules: [{ ruleId: "rule-deadline", before: 2, after: 0 }],
      });
      expect(runtime.state.alerts[0]?.learnedContribution).toEqual({
        sender: -2,
        rules: { "rule-deadline": -1 },
      });
    });

    it("reverses the earlier contribution when the alert moves to a feedback that learns nothing", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [alertFrom("alert-a", "a@x.example")];
      await feedback("alert-a", "important");
      const result = await feedback("alert-a", "always-like-this");
      expect(runtime.state.learning.senderWeights["a@x.example"]).toBeUndefined();
      expect(runtime.state.learning.ruleAdjustments["rule-deadline"]).toBeUndefined();
      expect(result.learned.changed).toBe(true);
      expect(runtime.state.alerts[0]?.learnedContribution).toEqual({ sender: 0, rules: {} });
    });

    it("reverses the nominal contribution of an alert rated by an earlier version", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [alertFrom("alert-a", "a@x.example", { feedbackState: "important" })];
      runtime.state.learning.senderWeights = { "a@x.example": 2 };
      runtime.state.learning.ruleAdjustments = { "rule-deadline": 1 };
      await feedback("alert-a", "less-often");
      expect(runtime.state.learning.senderWeights["a@x.example"]).toBe(-4);
      expect(runtime.state.learning.ruleAdjustments["rule-deadline"]).toBe(-1);
    });

    it("treats an alert without any recorded feedback as contributing nothing", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [alertFrom("alert-a", "a@x.example", { feedbackState: undefined })];
      await feedback("alert-a", "important");
      expect(runtime.state.learning.senderWeights["a@x.example"]).toBe(2);
    });

    it("ignores a malformed stored contribution and falls back to the nominal one", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [
        alertFrom("alert-a", "a@x.example", {
          feedbackState: "important",
          learnedContribution: { sender: "2", rules: null } as never,
        }),
      ];
      runtime.state.learning.senderWeights = { "a@x.example": 2 };
      await feedback("alert-a", "not-important");
      expect(runtime.state.learning.senderWeights["a@x.example"]).toBe(-2);
    });

    it("ignores non-numeric rule entries in a stored contribution", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [
        alertFrom("alert-a", "a@x.example", {
          feedbackState: "important",
          learnedContribution: { sender: 2, rules: { "rule-deadline": "x", other: 1 } } as never,
        }),
      ];
      runtime.state.learning.senderWeights = { "a@x.example": 2 };
      runtime.state.learning.ruleAdjustments = { "rule-deadline": 1, other: 1 };
      await feedback("alert-a", "not-important");
      expect(runtime.state.learning.ruleAdjustments).toEqual({});
    });
  });

  describe("bounds every learned weight", () => {
    it("caps the learned sender weight at +4 and rule adjustments at +2", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = ["a1", "a2", "a3"].map((id) => alertFrom(id, "a@x.example"));
      await feedback("a1", "important");
      await feedback("a2", "important");
      const third = await feedback("a3", "important");
      expect(runtime.state.learning.senderWeights["a@x.example"]).toBe(4);
      expect(runtime.state.learning.ruleAdjustments["rule-deadline"]).toBe(2);
      expect(third.learned).toEqual({
        changed: false,
        sender: { address: "a@x.example", before: 4, after: 4, min: -4, max: 4 },
        rules: [{ ruleId: "rule-deadline", before: 2, after: 2 }],
      });
      expect(runtime.state.alerts[2]?.learnedContribution).toEqual({ sender: 0, rules: {} });
    });

    it("floors the learned sender weight at -4 and rule adjustments at -1", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = ["a1", "a2"].map((id) => alertFrom(id, "a@x.example"));
      await feedback("a1", "less-often");
      await feedback("a2", "not-important");
      expect(runtime.state.learning.senderWeights["a@x.example"]).toBe(-4);
      expect(runtime.state.learning.ruleAdjustments["rule-deadline"]).toBe(-1);
    });

    it("reverses only what an alert actually contributed when a cap was hit", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = ["a1", "a2", "a3"].map((id) => alertFrom(id, "a@x.example"));
      await feedback("a1", "important");
      await feedback("a2", "important");
      await feedback("a3", "important");
      await feedback("a3", "not-important");
      expect(runtime.state.learning.senderWeights["a@x.example"]).toBe(2);
      expect(runtime.state.learning.ruleAdjustments["rule-deadline"]).toBe(1);
    });

    it("brings a weight stored above the cap by an earlier version back into range", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [alertFrom("alert-a", "a@x.example")];
      runtime.state.learning.senderWeights = { "a@x.example": 7 };
      runtime.state.learning.ruleAdjustments = { "rule-deadline": 5 };
      const doc = rules();
      const scored = scoreMessage(message("a@x.example", "Deadline"), runtime.state, doc);
      expect(scored.score).toBe(4 + 2 + 2);

      const result = await feedback("alert-a", "important");
      expect(runtime.state.learning.senderWeights["a@x.example"]).toBe(4);
      expect(result.learned.sender).toMatchObject({ before: 7, after: 4 });
      expect(result.learned.changed).toBe(true);
      expect(runtime.state.alerts[0]?.learnedContribution).toEqual({ sender: 0, rules: {} });
    });

    it("never writes adjustments for synthesized sender, domain or thread ids", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [
        alertFrom("alert-a", "a@x.example", {
          matchedRuleIds: [
            "sender:a@x.example",
            "domain:x.example",
            "thread:prior-subject-match",
            "rule-deadline",
          ],
        }),
      ];
      const result = await feedback("alert-a", "important");
      expect(runtime.state.learning.ruleAdjustments).toEqual({ "rule-deadline": 1 });
      expect(result.learned.rules.map((entry) => entry.ruleId)).toEqual(["rule-deadline"]);
    });
  });

  describe("reports what was learned", () => {
    it("names the address, before -> after and every rule touched", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [alertFrom("alert-a", "a@x.example")];
      const result = await feedback("alert-a", "important");
      expect(result.learned).toEqual({
        changed: true,
        sender: { address: "a@x.example", before: 0, after: 2, min: -4, max: 4 },
        rules: [{ ruleId: "rule-deadline", before: 0, after: 1 }],
      });
      expect(result.learnedSummary).toBe(
        "Learned: future mail from a@x.example weighs 0 -> +2 (limit -4..+4); rule rule-deadline 0 -> +1.",
      );
      expect(result.derivedRule.reason).toBe(
        "Applies to this item; learned weights changed (see learned).",
      );
      const reply = formatFeedbackResult(result);
      expect(reply).not.toMatch(/no rule created/i);
      expect(reply).toContain("Scope: this item; no policy rule.");
      expect(reply).toContain("a@x.example weighs 0 -> +2");
      expect(reply).toContain("rule rule-deadline 0 -> +1");
    });

    it("previews the learned change in a dry run without writing it", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [alertFrom("alert-a", "a@x.example")];
      const result = await feedback("alert-a", "not-important", { dryRun: true });
      expect(result.changed).toBe(false);
      expect(result.learned).toEqual({
        changed: true,
        sender: { address: "a@x.example", before: 0, after: -2, min: -4, max: 4 },
        rules: [{ ruleId: "rule-deadline", before: 0, after: -1 }],
      });
      expect(runtime.state.learning.senderWeights).toEqual({});
      expect(runtime.state.alerts[0]?.learnedContribution).toBeUndefined();
      expect(formatFeedbackResult(result)).toContain(
        "Learned: future mail from a@x.example weighs 0 -> -2",
      );
    });

    it("keeps the item-only wording when nothing was learned", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [alertFrom("alert-a", "a@x.example")];
      const result = await feedback("alert-a", "remind-later");
      expect(result.learned).toEqual({ changed: false, rules: [] });
      expect(result.derivedRule.reason).toBe("Applies to this item only; no rule created.");
      expect(formatFeedbackResult(result)).toContain(
        "Scope: this item only. No learned weight changed.",
      );
    });

    it("summarizes a sender-only change and a rule-only change", () => {
      expect(
        summarizeLearned({
          changed: true,
          sender: { address: "a@x.example", before: -2, after: -4, min: -4, max: 4 },
          rules: [],
        }),
      ).toBe("Learned: future mail from a@x.example weighs -2 -> -4 (limit -4..+4).");
      expect(
        summarizeLearned({ changed: true, rules: [{ ruleId: "r", before: 1, after: 0 }] }),
      ).toBe("Learned: rule r +1 -> 0.");
    });

    it("reports no sender change for an alert without a sender address", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [
        alertFrom("alert-a", "a@x.example", { fromAddress: undefined, matchedRuleIds: undefined }),
      ];
      const result = await feedback("alert-a", "important");
      expect(result.learned).toEqual({ changed: false, rules: [] });
    });
  });

  describe("explicit domain rules are unchanged", () => {
    it("previews, writes, lists and removes a --scope domain rule", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [alertFrom("alert-a", "a@x.example", { zone: "amber" })];

      const preview = await feedback("alert-a", "digest-only", { scope: "domain", dryRun: true });
      expect(preview.dryRun).toBe(true);
      expect(preview.derivedRule).toMatchObject({ type: "domain", match: "x.example" });
      expect(preview.ruleSummary).toBe("domain x.example -> max-zone amber");
      expect(runtime.policy.domainPolicies).toHaveLength(0);

      const result = await feedback("alert-a", "digest-only", { scope: "domain" });
      expect(result.policyId).toBeDefined();
      const listed = await policyList({ instance: "ms-core" });
      expect(listed.policies.map((entry) => entry.id)).toContain(result.policyId);

      const removed = await policyRemove({ instance: "ms-core", id: result.policyId as string });
      expect(removed.changed).toBe(true);
      expect(runtime.policy.domainPolicies).toHaveLength(0);
      expect(runtime.state.learning.domainWeights).toEqual({});
    });
  });
});
