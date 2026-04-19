import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadGolden, normalizeUuids } from "../__fixtures__/load.js";
import { createDefaultPolicy } from "../state/schema.js";
import {
  addPolicyEntry,
  applyLearningAdjustment,
  derivePolicyFromFeedback,
  flattenPolicies,
} from "./actions.js";

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    randomUUID: () => "00000000-0000-0000-0000-000000000000",
  };
});

describe("policy/actions", () => {
  beforeEach(() => {
    // no-op; mocks are hoisted above
  });

  it("matches the flattenPolicies golden fixture", () => {
    expect(
      flattenPolicies({
        version: 1,
        senderPolicies: [{ id: "s1", match: "a@b" }],
        domainPolicies: [{ id: "d1", match: "*.b" }],
        receiverPolicies: [],
        categoryPolicies: [{ id: "c1", category: "decision-required" }],
        contentPolicies: [{ id: "co1", pattern: "invoice" }],
        timePolicies: [{ id: "t1", schedule: "09:00-17:00" }],
        mutePolicies: [{ id: "m1", match: "noreply@*" }],
      }),
    ).toEqual(loadGolden("flattenPolicies"));
  });

  it("matches the addPolicyEntry golden fixture for sender+domain", () => {
    const base = createDefaultPolicy();
    const withSender = addPolicyEntry(base, "sender", { id: "s1", match: "a@b" });
    const withDomain = addPolicyEntry(withSender, "domain", { id: "d1", match: "*.b" });
    expect(withDomain).toEqual(loadGolden("addPolicyEntry"));
  });

  it("throws for unknown policy types (matches the error fixture)", () => {
    const golden = loadGolden<{ message: string }>("addPolicyEntry.invalid");
    expect(() => addPolicyEntry(createDefaultPolicy(), "bogus", { id: "x" })).toThrow(
      golden.message,
    );
  });

  it("supports adding category/content/time/mute entries", () => {
    const base = createDefaultPolicy();
    const withCat = addPolicyEntry(base, "category", { id: "c", category: "decision-required" });
    const withContent = addPolicyEntry(withCat, "content", { id: "co", pattern: "invoice" });
    const withTime = addPolicyEntry(withContent, "time", { id: "t", schedule: "09:00-17:00" });
    const withMute = addPolicyEntry(withTime, "mute", { id: "m", match: "noreply@*" });
    expect(withMute.categoryPolicies).toHaveLength(1);
    expect(withMute.contentPolicies).toHaveLength(1);
    expect(withMute.timePolicies).toHaveLength(1);
    expect(withMute.mutePolicies).toHaveLength(1);
  });

  it("adds a receiver policy entry", () => {
    const base = createDefaultPolicy();
    const withReceiver = addPolicyEntry(base, "receiver", { id: "r1", match: "me@biz.com" });
    expect(withReceiver.receiverPolicies).toHaveLength(1);
    expect(withReceiver.receiverPolicies[0]?.match).toBe("me@biz.com");
  });

  it("includes receiver policies in flattenPolicies", () => {
    const flat = flattenPolicies({
      version: 1,
      senderPolicies: [],
      domainPolicies: [],
      receiverPolicies: [{ id: "r1", match: "me@biz.com" }],
      categoryPolicies: [],
      contentPolicies: [],
      timePolicies: [],
      mutePolicies: [],
    });
    expect(flat).toEqual([{ type: "receiver", id: "r1", match: "me@biz.com" }]);
  });

  it("matches the derivePolicyFromFeedback golden fixture", () => {
    const result = {
      always: derivePolicyFromFeedback(
        { fromAddress: "alice@example.com", zone: "amber" },
        "always-like-this",
      ),
      reduce: derivePolicyFromFeedback({ fromAddress: "alice@example.com", zone: "red" }, "reduce"),
      digestOnlyFromAmber: derivePolicyFromFeedback(
        { fromAddress: "alice@example.com", zone: "amber" },
        "digest-only",
      ),
      digestOnlyFromRed: derivePolicyFromFeedback(
        { fromAddress: "alice@example.com", zone: "red" },
        "digest-only",
      ),
      notDerivable: derivePolicyFromFeedback(
        { fromAddress: "alice@example.com", zone: "red" },
        "important",
      ),
      noSender: derivePolicyFromFeedback({ zone: "amber" }, "always-like-this"),
    };
    expect(normalizeUuids(result)).toEqual(loadGolden("derivePolicyFromFeedback"));
  });

  it("uses red minZone for an always-like-this on a red alert", () => {
    const derived = derivePolicyFromFeedback(
      { fromAddress: "alice@example.com", zone: "red" },
      "always-like-this",
    );
    expect(derived?.entry.minZone).toBe("red");
  });

  it("uses gray maxZone for a reduce action on a non-red alert", () => {
    const derived = derivePolicyFromFeedback(
      { fromAddress: "alice@example.com", zone: "amber" },
      "reduce",
    );
    expect(derived?.entry.maxZone).toBe("gray");
  });

  it("caps a digest-only policy at amber regardless of source zone", () => {
    for (const zone of ["red", "amber"] as const) {
      const derived = derivePolicyFromFeedback(
        { fromAddress: "alice@example.com", zone },
        "digest-only",
      );
      expect(derived?.entry.maxZone).toBe("amber");
      expect(derived?.entry.minZone).toBeUndefined();
      expect(derived?.entry.reason).toBe("Derived from digest-only feedback for alice@example.com");
    }
  });

  it("returns null for digest-only when the sender is unknown", () => {
    expect(derivePolicyFromFeedback({ zone: "amber" }, "digest-only")).toBeNull();
  });

  it("matches the applyLearningAdjustment golden fixture", () => {
    expect({
      increment: (() => {
        const target: Record<string, number> = { "a@b": 2 };
        applyLearningAdjustment(target, "a@b", 1);
        return target;
      })(),
      decrementToFloor: (() => {
        const target: Record<string, number> = { "a@b": 0 };
        applyLearningAdjustment(target, "a@b", -5, -1);
        return target;
      })(),
      removeOnZero: (() => {
        const target: Record<string, number> = { "a@b": 1 };
        applyLearningAdjustment(target, "a@b", -1);
        return target;
      })(),
      emptyKey: (() => {
        const target: Record<string, number> = { "a@b": 1 };
        applyLearningAdjustment(target, "", 1);
        return target;
      })(),
    }).toEqual(loadGolden("applyLearningAdjustment"));
  });

  it("ignores non-string keys silently", () => {
    const target: Record<string, number> = { "a@b": 1 };
    applyLearningAdjustment(target, undefined, 1);
    expect(target).toEqual({ "a@b": 1 });
  });
});
