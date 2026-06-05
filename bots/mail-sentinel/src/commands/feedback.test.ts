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

const { applyFeedback, isAmbiguousFeedback } = await import("./feedback.js");

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

  it("creates a sender policy for always-like-this", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = [baseAlert()];
    const result = applied(
      await applyFeedback({
        instance: "ms-core",
        alertId: "alert-1",
        action: "always-like-this",
      }),
    );
    expect(result.policyId).toBeDefined();
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

  it("populates a plain-words actionLabel for every applied action", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = [baseAlert()];
    const result = applied(
      await applyFeedback({ instance: "ms-core", alertId: "alert-1", action: "important" }),
    );
    expect(result.actionLabel).toBe("important");
  });

  it("throws when the alert does not contain enough info to derive a policy", async () => {
    const runtime = getFakeRuntime();
    runtime.state.alerts = [baseAlert({ fromAddress: undefined })];
    await expect(
      applyFeedback({ instance: "ms-core", alertId: "alert-1", action: "always-like-this" }),
    ).rejects.toThrow("does not contain enough sender information");
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
    const cases: Array<{ action: Parameters<typeof applyFeedback>[0]["action"]; note: string }> = [
      { action: "important", note: "Feedback applied. Alert marked as important." },
      { action: "not-important", note: "Feedback applied. Alert marked as not important." },
      { action: "less-often", note: "Feedback applied. Sender weight reduced." },
      {
        action: "always-like-this",
        note: "Policy updated locally. Sender routing pattern locked.",
      },
      { action: "reduce", note: "Policy updated locally. Similar signals reduced." },
      {
        action: "digest-only",
        note: "Policy updated locally. Similar signals routed to digest only.",
      },
    ];
    for (const { action, note } of cases) {
      it(`${String(action)} returns exactly '${note}'`, async () => {
        const runtime = getFakeRuntime();
        runtime.state.alerts = [baseAlert()];
        const result = applied(
          await applyFeedback({
            instance: "ms-core",
            alertId: "alert-1",
            action,
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
});
