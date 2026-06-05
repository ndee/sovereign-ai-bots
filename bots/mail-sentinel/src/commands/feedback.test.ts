import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getFakeRuntime, resetFakeRuntime } from "../__fixtures__/fake-runtime.js";
import type { StoredAlert } from "../types.js";

vi.mock("../config/runtime.js", () => ({
  resolveToolRuntime: async () => getFakeRuntime(),
}));

// Run withLockedState actions inline without fs.
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

const {
  applyFeedback,
  isAmbiguousFeedback,
  summarizeDerivedRule,
  resolveFeedbackScope,
  toDerivedRule,
} = await import("./feedback.js");

// The --alert-id / --latest paths can never return the ambiguous shape; narrow
// the union so these tests keep reading applied fields directly.
const applied = (result: Awaited<ReturnType<typeof applyFeedback>>) => {
  if (isAmbiguousFeedback(result)) {
    throw new Error("expected an applied feedback result, got ambiguous");
  }
  return result;
};

const FIXED_NOW = new Date("2026-04-08T12:00:00.000Z");

const baseAlert = (overrides: Partial<StoredAlert> = {}): StoredAlert => ({
  alertId: "alert-1",
  zone: "red",
  category: "financial-relevance",
  subject: "s",
  from: "Alice <alice@example.com>",
  fromAddress: "alice@example.com",
  domain: "example.com",
  why: "w",
  sentAt: "2026-04-08T09:00:00.000Z",
  feedbackState: "pending",
  matchedRuleIds: ["rule-invoice"],
  ...overrides,
});

describe("commands/feedback", () => {
  beforeEach(() => {
    resetFakeRuntime();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("requires an instance id", async () => {
    await expect(applyFeedback({})).rejects.toThrow("Expected --instance <id>");
  });

  it("throws when no alert matches the selector", async () => {
    await expect(
      applyFeedback({ instance: "ms-core", latest: true, action: "important" }),
    ).rejects.toThrow("No matching Mail Sentinel alert was found");
  });

  it("throws when neither --latest nor --alert-id is provided", async () => {
    await expect(applyFeedback({ instance: "ms-core", action: "important" })).rejects.toThrow(
      "No matching Mail Sentinel alert was found",
    );
  });

  it("marks an alert as important and updates learning weights", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = [baseAlert()];
    const result = applied(
      await applyFeedback({
        instance: "ms-core",
        alertId: "alert-1",
        action: "important",
      }),
    );
    expect(result.note).toBe("Feedback applied. Alert marked as important.");
    expect(runtime.state.alerts[0]?.feedbackState).toBe("important");
    expect(runtime.state.learning.senderWeights["alice@example.com"]).toBe(2);
    expect(runtime.state.learning.domainWeights["example.com"]).toBe(1);
    expect(runtime.state.learning.ruleAdjustments["rule-invoice"]).toBe(1);
  });

  it("marks not-important and applies negative adjustments with a floor", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = [baseAlert()];
    await applyFeedback({ instance: "ms-core", alertId: "alert-1", action: "not-important" });
    expect(runtime.state.alerts[0]?.feedbackState).toBe("not-important");
    expect(runtime.state.learning.senderWeights["alice@example.com"]).toBe(-2);
  });

  it("marks less-often and applies larger negative adjustments", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = [baseAlert()];
    await applyFeedback({ instance: "ms-core", alertId: "alert-1", action: "less-often" });
    expect(runtime.state.alerts[0]?.feedbackState).toBe("less-often");
    expect(runtime.state.learning.senderWeights["alice@example.com"]).toBe(-4);
  });

  it("schedules a reminder with the default delay", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = [baseAlert()];
    const result = applied(
      await applyFeedback({
        instance: "ms-core",
        alertId: "alert-1",
        action: "remind-later",
      }),
    );
    expect(result.nextReminderAt).toBe("2026-04-08T16:00:00.000Z");
    expect(runtime.state.alerts[0]?.reminderDueAt).toBe("2026-04-08T16:00:00.000Z");
  });

  it("schedules a reminder with an explicit --delay", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = [baseAlert()];
    const result = applied(
      await applyFeedback({
        instance: "ms-core",
        alertId: "alert-1",
        action: "remind-later",
        delay: "30m",
      }),
    );
    expect(result.nextReminderAt).toBe("2026-04-08T12:30:00.000Z");
  });

  it("creates a sender policy for always-like-this with --scope sender", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = [baseAlert()];
    const result = applied(
      await applyFeedback({
        instance: "ms-core",
        alertId: "alert-1",
        action: "always-like-this",
        scope: "sender",
      }),
    );
    expect(result.policyId).toBeDefined();
    expect(result.scope).toBe("sender");
    expect(runtime.policy.senderPolicies).toHaveLength(1);
    expect(runtime.policy.senderPolicies[0]?.minZone).toBe("red");
  });

  it("creates a reduce policy and applies negative learning adjustments", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = [baseAlert({ zone: "amber" })];
    const result = applied(
      await applyFeedback({
        instance: "ms-core",
        alertId: "alert-1",
        action: "reduce",
        scope: "sender",
      }),
    );
    expect(result.policyId).toBeDefined();
    expect(runtime.policy.senderPolicies[0]?.maxZone).toBe("gray");
    expect(runtime.state.learning.senderWeights["alice@example.com"]).toBe(-2);
  });

  it("creates a digest-only policy that caps an amber alert's sender at amber", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = [baseAlert({ zone: "amber" })];
    const result = applied(
      await applyFeedback({
        instance: "ms-core",
        alertId: "alert-1",
        action: "digest-only",
        scope: "sender",
      }),
    );
    expect(result.policyId).toBeDefined();
    expect(result.note).toBe("Policy updated locally. Similar signals routed to digest only.");
    expect(runtime.policy.senderPolicies[0]?.maxZone).toBe("amber");
    expect(runtime.state.alerts[0]?.feedbackState).toBe("digest-only");
    // digest-only must not nudge the learning weights like reduce does.
    expect(runtime.state.learning.senderWeights["alice@example.com"]).toBeUndefined();
    expect(runtime.state.learning.domainWeights["example.com"]).toBeUndefined();
  });

  it("creates a digest-only policy that also caps a red alert's sender at amber", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = [baseAlert({ zone: "red" })];
    await applyFeedback({
      instance: "ms-core",
      alertId: "alert-1",
      action: "digest-only",
      scope: "sender",
    });
    expect(runtime.policy.senderPolicies[0]?.maxZone).toBe("amber");
    expect(runtime.state.alerts[0]?.feedbackState).toBe("digest-only");
  });

  it("creates a sender-scoped mute policy and echoes the canonical label", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = [baseAlert({ zone: "amber" })];
    const result = applied(
      await applyFeedback({
        instance: "ms-core",
        alertId: "alert-1",
        action: "mute",
        scope: "sender",
      }),
    );
    expect(result.policyId).toBeDefined();
    expect(result.action).toBe("mute");
    expect(result.actionLabel).toBe("hide these");
    expect(result.note).toBe("Policy updated locally. Similar mail will be hidden.");
    expect(runtime.policy.mutePolicies).toHaveLength(1);
    expect(runtime.policy.mutePolicies[0]?.match).toBe("alice@example.com");
    expect(runtime.policy.mutePolicies[0]?.action).toBe("mute");
    expect(runtime.policy.senderPolicies).toHaveLength(0);
    expect(runtime.state.alerts[0]?.feedbackState).toBe("mute");
    // mute is a routing change, not a learning nudge.
    expect(runtime.state.learning.senderWeights["alice@example.com"]).toBeUndefined();
  });

  it("creates a domain-scoped mute policy", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = [baseAlert({ zone: "amber" })];
    await applyFeedback({
      instance: "ms-core",
      alertId: "alert-1",
      action: "mute",
      scope: "domain",
    });
    expect(runtime.policy.mutePolicies).toHaveLength(1);
    expect(runtime.policy.mutePolicies[0]?.match).toBe("example.com");
    expect(runtime.policy.mutePolicies[0]?.action).toBe("mute");
  });

  it("rejects a subject/content scope for mute (the matcher cannot match text)", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = [baseAlert({ zone: "amber" })];
    await expect(
      applyFeedback({
        instance: "ms-core",
        alertId: "alert-1",
        action: "mute",
        scope: "subject",
      }),
    ).rejects.toThrow("does not contain enough information to derive a subject rule");
  });

  it("populates a plain-words actionLabel for every applied action", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = [baseAlert()];
    const result = applied(
      await applyFeedback({ instance: "ms-core", alertId: "alert-1", action: "important" }),
    );
    expect(result.actionLabel).toBe("important");
  });

  it("throws when the alert does not contain enough info to derive a sender rule", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = [baseAlert({ fromAddress: undefined })];
    await expect(
      applyFeedback({
        instance: "ms-core",
        alertId: "alert-1",
        action: "always-like-this",
        scope: "sender",
      }),
    ).rejects.toThrow("does not contain enough information to derive a sender rule");
  });

  it("rejects unknown actions", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = [baseAlert()];
    await expect(
      applyFeedback({
        instance: "ms-core",
        alertId: "alert-1",
        action: "nope" as unknown as "important",
      }),
    ).rejects.toThrow("Unsupported action 'nope'");
  });

  it("handles alerts with undefined matchedRuleIds", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = [baseAlert({ matchedRuleIds: undefined })];
    await applyFeedback({ instance: "ms-core", alertId: "alert-1", action: "important" });
    await applyFeedback({
      instance: "ms-core",
      alertId: "alert-1",
      action: "not-important",
    });
    await applyFeedback({ instance: "ms-core", alertId: "alert-1", action: "less-often" });
    expect(runtime.state.alerts[0]?.feedbackState).toBe("less-often");
  });

  it("selects the latest alert when --latest is set", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = [
      baseAlert({ alertId: "old", sentAt: "2026-04-07T09:00:00Z" }),
      baseAlert({ alertId: "newest", sentAt: "2026-04-08T09:00:00Z" }),
    ];
    const result = applied(
      await applyFeedback({
        instance: "ms-core",
        latest: true,
        action: "important",
      }),
    );
    expect(result.alertId).toBe("newest");
  });

  // Pin the note string for every FeedbackAction so any wrapper (Matrix bridge,
  // agent loop, digest formatter) that paraphrases or interpolates a sender
  // name into the confirmation fails CI.
  describe("note wording is a stable, self-contained string", () => {
    const cases: Array<{
      action: Parameters<typeof applyFeedback>[0]["action"];
      scope?: Parameters<typeof applyFeedback>[0]["scope"];
      note: string;
    }> = [
      { action: "important", note: "Feedback applied. Alert marked as important." },
      { action: "not-important", note: "Feedback applied. Alert marked as not important." },
      { action: "less-often", note: "Feedback applied. Sender weight reduced." },
      {
        action: "always-like-this",
        scope: "sender",
        note: "Policy updated locally. Sender routing pattern locked.",
      },
      {
        action: "reduce",
        scope: "sender",
        note: "Policy updated locally. Similar signals reduced.",
      },
      {
        action: "digest-only",
        scope: "sender",
        note: "Policy updated locally. Similar signals routed to digest only.",
      },
      {
        action: "mute",
        scope: "sender",
        note: "Policy updated locally. Similar mail will be hidden.",
      },
    ];
    for (const { action, scope, note } of cases) {
      it(`${String(action)} returns exactly '${note}'`, async () => {
        const runtime = getFakeRuntime();
        runtime.state.alerts = [baseAlert()];
        const result = applied(
          await applyFeedback({
            instance: "ms-core",
            alertId: "alert-1",
            action,
            ...(scope === undefined ? {} : { scope }),
          }),
        );
        expect(result.note).toBe(note);
        expect(result.note).not.toContain("alice@example.com");
        expect(result.note).not.toContain("example.com");
      });
    }

    it("remind-later returns exactly 'Reminder scheduled.'", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [baseAlert()];
      const result = applied(
        await applyFeedback({
          instance: "ms-core",
          alertId: "alert-1",
          action: "remind-later",
        }),
      );
      expect(result.note).toBe("Reminder scheduled.");
    });
  });

  describe("--ref targeting via resolveAlertTarget", () => {
    it("resolves a unique ref, applies feedback, and echoes the matched item", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [
        baseAlert({
          alertId: "aaaaaaaa-0000-0000-0000-000000000000",
          shortRef: "aaaaaa",
          subject: "Invoice overdue",
        }),
        baseAlert({
          alertId: "bbbbbbbb-0000-0000-0000-000000000000",
          shortRef: "bbbbbb",
          subject: "Lunch plans",
          fromAddress: "bob@example.com",
        }),
      ];
      const result = applied(
        await applyFeedback({ instance: "ms-core", ref: "aaaaaa", action: "important" }),
      );
      expect(result.alertId).toBe("aaaaaaaa-0000-0000-0000-000000000000");
      expect(result.shortRef).toBe("aaaaaa");
      expect(result.subject).toBe("Invoice overdue");
      expect(result.from).toBe("Alice <alice@example.com>");
      expect(runtime.state.alerts[0]?.feedbackState).toBe("important");
    });

    it("returns ambiguous without mutating state when a ref matches many", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [
        baseAlert({
          alertId: "aa000000-0000-0000-0000-000000000000",
          shortRef: "aa0000",
          subject: "One",
        }),
        baseAlert({
          alertId: "aa111111-0000-0000-0000-000000000000",
          shortRef: "aa1111",
          subject: "Two",
        }),
      ];
      const result = await applyFeedback({ instance: "ms-core", ref: "aa", action: "important" });
      expect(isAmbiguousFeedback(result)).toBe(true);
      if (isAmbiguousFeedback(result)) {
        expect(result.changed).toBe(false);
        expect(result.ref).toBe("aa");
        expect(result.candidates.map((c) => c.subject)).toEqual(["One", "Two"]);
      }
      // No feedback applied to either alert.
      expect(runtime.state.alerts.every((a) => a.feedbackState === "pending")).toBe(true);
      expect(runtime.state.feedback).toHaveLength(0);
    });

    it("throws no-match when a ref resolves to nothing", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [baseAlert({ shortRef: "aaaaaa" })];
      await expect(
        applyFeedback({ instance: "ms-core", ref: "zzzzzz", action: "important" }),
      ).rejects.toThrow("No matching Mail Sentinel alert was found");
    });
  });

  describe("explicit scope resolution", () => {
    it("defaults a policy action to the item scope, writing no policy", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [baseAlert({ zone: "amber" })];
      const result = applied(
        await applyFeedback({ instance: "ms-core", alertId: "alert-1", action: "reduce" }),
      );
      expect(result.scope).toBe("item");
      expect(result.policyId).toBeUndefined();
      expect(result.derivedRule.type).toBe("none");
      expect(result.ruleSummary).toBe("this item only");
      expect(result.note).toBe("Feedback applied to this item only.");
      // No policy written, but the alert state + reduce learning nudge still apply.
      expect(runtime.policy.senderPolicies).toHaveLength(0);
      expect(runtime.state.alerts[0]?.feedbackState).toBe("reduce");
      expect(runtime.state.learning.senderWeights["alice@example.com"]).toBe(-2);
    });

    it("ignores a scope on a non-policy action and reports item", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [baseAlert()];
      const result = applied(
        await applyFeedback({
          instance: "ms-core",
          alertId: "alert-1",
          action: "important",
          scope: "sender",
        }),
      );
      expect(result.scope).toBe("item");
      expect(result.derivedRule.type).toBe("none");
    });

    it("creates a domain policy for --scope domain", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [baseAlert({ zone: "amber" })];
      const result = applied(
        await applyFeedback({
          instance: "ms-core",
          alertId: "alert-1",
          action: "reduce",
          scope: "domain",
        }),
      );
      expect(result.scope).toBe("domain");
      expect(runtime.policy.domainPolicies).toHaveLength(1);
      expect(runtime.policy.domainPolicies[0]?.match).toBe("example.com");
      expect(result.derivedRule).toMatchObject({ type: "domain", match: "example.com" });
      expect(result.ruleSummary).toBe("domain example.com -> max-zone gray");
    });

    it("creates a subject-scoped content policy from the alert subject", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [baseAlert({ zone: "amber", subject: "Invoice freigegeben" })];
      const result = applied(
        await applyFeedback({
          instance: "ms-core",
          alertId: "alert-1",
          action: "digest-only",
          scope: "subject",
        }),
      );
      expect(result.scope).toBe("subject");
      expect(runtime.policy.contentPolicies).toHaveLength(1);
      expect(runtime.policy.contentPolicies[0]).toMatchObject({
        pattern: "freigegeben",
        scope: "subject",
        maxZone: "amber",
      });
      expect(result.ruleSummary).toBe("subject contains /freigegeben/ -> max-zone amber");
    });

    it("honours an explicit --contains token for a content scope", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [baseAlert({ zone: "amber" })];
      const result = applied(
        await applyFeedback({
          instance: "ms-core",
          alertId: "alert-1",
          action: "reduce",
          scope: "content",
          contains: "wire transfer",
        }),
      );
      expect(runtime.policy.contentPolicies[0]).toMatchObject({
        pattern: "wire transfer",
        scope: "body",
      });
      expect(result.ruleSummary).toBe("body contains /wire transfer/ -> max-zone gray");
    });

    it("rejects an unknown scope", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [baseAlert()];
      await expect(
        applyFeedback({
          instance: "ms-core",
          alertId: "alert-1",
          action: "reduce",
          scope: "bogus",
        }),
      ).rejects.toThrow("Unknown --scope 'bogus'");
    });

    it("throws when a content scope has no derivable token", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [baseAlert({ zone: "amber" })];
      await expect(
        applyFeedback({
          instance: "ms-core",
          alertId: "alert-1",
          action: "reduce",
          scope: "content",
        }),
      ).rejects.toThrow("does not contain enough information to derive a content rule");
    });
  });

  describe("summarizeDerivedRule", () => {
    it("summarizes a min-zone sender rule", () => {
      expect(
        summarizeDerivedRule({
          type: "sender",
          scope: "sender",
          match: "a@b",
          minZone: "red",
          reason: "",
        }),
      ).toBe("sender a@b -> min-zone red");
    });

    it("summarizes a subject content rule", () => {
      expect(
        summarizeDerivedRule({
          type: "content",
          scope: "subject",
          pattern: "freigegeben",
          policyScope: "subject",
          maxZone: "amber",
          reason: "",
        }),
      ).toBe("subject contains /freigegeben/ -> max-zone amber");
    });

    it("falls back to 'no zone change' when a rule carries neither zone", () => {
      expect(
        summarizeDerivedRule({ type: "sender", scope: "sender", match: "a@b", reason: "" }),
      ).toBe("sender a@b -> no zone change");
    });

    it("renders an empty content pattern defensively", () => {
      expect(
        summarizeDerivedRule({
          type: "content",
          scope: "content",
          policyScope: "body",
          reason: "",
        }),
      ).toBe("body contains // -> no zone change");
    });

    it("reports 'this item only' for a none rule", () => {
      expect(summarizeDerivedRule({ type: "none", scope: "item", reason: "" })).toBe(
        "this item only",
      );
    });

    it("renders an empty match defensively for a sender rule", () => {
      expect(
        summarizeDerivedRule({ type: "sender", scope: "sender", maxZone: "amber", reason: "" }),
      ).toBe("sender  -> max-zone amber");
    });
  });

  describe("toDerivedRule", () => {
    it("maps a null derivation to the item-only contract", () => {
      expect(toDerivedRule("item", null)).toEqual({
        type: "none",
        scope: "item",
        reason: "Applies to this item only; no rule created.",
      });
    });

    it("projects an entry's fields and defaults a missing reason to empty", () => {
      expect(
        toDerivedRule("sender", {
          id: "p1",
          type: "sender",
          entry: { id: "e1", match: "a@b", minZone: "red" },
        }),
      ).toEqual({ type: "sender", scope: "sender", match: "a@b", minZone: "red", reason: "" });
    });
  });

  describe("resolveFeedbackScope", () => {
    it("defaults to item when no scope is given", () => {
      expect(resolveFeedbackScope("reduce", undefined)).toBe("item");
    });

    it("returns the requested scope for a policy action", () => {
      expect(resolveFeedbackScope("reduce", "domain")).toBe("domain");
    });

    it("forces item for a non-policy action even when a scope is requested", () => {
      expect(resolveFeedbackScope("important", "sender")).toBe("item");
    });

    it("forces item when the action is undefined", () => {
      expect(resolveFeedbackScope(undefined, "sender")).toBe("item");
    });

    it("throws on an unknown scope", () => {
      expect(() => resolveFeedbackScope("reduce", "bogus")).toThrow("Unknown --scope 'bogus'");
    });
  });

  describe("--dry-run previews without writing", () => {
    it("returns the derived rule and writes nothing", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [baseAlert({ zone: "amber" })];
      const stateBefore = runtime.state;
      const policyBefore = runtime.policy;
      const result = applied(
        await applyFeedback({
          instance: "ms-core",
          alertId: "alert-1",
          action: "reduce",
          scope: "domain",
          dryRun: true,
        }),
      );
      expect(result.dryRun).toBe(true);
      expect(result.changed).toBe(false);
      expect(result.scope).toBe("domain");
      expect(result.derivedRule).toMatchObject({ type: "domain", match: "example.com" });
      expect(result.ruleSummary).toBe("domain example.com -> max-zone gray");
      // Nothing persisted: same object identities, no policy/feedback/state change.
      expect(runtime.state).toBe(stateBefore);
      expect(runtime.policy).toBe(policyBefore);
      expect(runtime.policy.domainPolicies).toHaveLength(0);
      expect(runtime.state.feedback).toHaveLength(0);
      expect(runtime.state.alerts[0]?.feedbackState).toBe("pending");
    });

    it("previews an item-scope dry run with a no-rule summary", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [baseAlert()];
      const result = applied(
        await applyFeedback({
          instance: "ms-core",
          alertId: "alert-1",
          action: "important",
          dryRun: true,
        }),
      );
      expect(result.dryRun).toBe(true);
      expect(result.derivedRule.type).toBe("none");
      expect(result.ruleSummary).toBe("this item only");
      expect(runtime.state.alerts[0]?.feedbackState).toBe("pending");
    });

    it("surfaces a non-derivable scope as an error even in dry-run", async () => {
      const runtime = getFakeRuntime();
      runtime.state.alerts = [baseAlert({ fromAddress: undefined })];
      await expect(
        applyFeedback({
          instance: "ms-core",
          alertId: "alert-1",
          action: "reduce",
          scope: "sender",
          dryRun: true,
        }),
      ).rejects.toThrow("does not contain enough information to derive a sender rule");
    });
  });
});
