import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadGolden, normalizeUuids } from "../__fixtures__/load.js";
import { createDefaultPolicy } from "../state/schema.js";
import {
  addPolicyEntry,
  applyLearningAdjustment,
  derivePolicyFromFeedback,
  escapeRegExp,
  flattenPolicies,
  subjectToken,
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

  // A fully-populated alert so each scope has something to derive from.
  const richAlert = {
    fromAddress: "alice@example.com",
    domain: "example.com",
    subject: "Invoice freigegeben",
    zone: "amber" as const,
  };

  it("matches the derivePolicyFromFeedback golden fixture across scopes", () => {
    const result = {
      itemAlways: derivePolicyFromFeedback(richAlert, "always-like-this", "item"),
      senderAlways: derivePolicyFromFeedback(richAlert, "always-like-this", "sender"),
      senderReduceRed: derivePolicyFromFeedback({ ...richAlert, zone: "red" }, "reduce", "sender"),
      domainDigest: derivePolicyFromFeedback(richAlert, "digest-only", "domain"),
      subjectAuto: derivePolicyFromFeedback(richAlert, "reduce", "subject"),
      subjectContains: derivePolicyFromFeedback(richAlert, "reduce", "subject", {
        contains: "free.ride",
      }),
      contentContains: derivePolicyFromFeedback(richAlert, "digest-only", "content", {
        contains: "wire transfer",
      }),
      notDerivableAction: derivePolicyFromFeedback(richAlert, "important", "sender"),
      noSender: derivePolicyFromFeedback(
        { ...richAlert, fromAddress: undefined },
        "always-like-this",
        "sender",
      ),
      noDomain: derivePolicyFromFeedback({ ...richAlert, domain: undefined }, "reduce", "domain"),
      noSubject: derivePolicyFromFeedback({ ...richAlert, subject: "" }, "reduce", "subject"),
      contentNoContains: derivePolicyFromFeedback(richAlert, "reduce", "content"),
    };
    expect(normalizeUuids(result)).toEqual(loadGolden("derivePolicyFromFeedback"));
  });

  it("uses red minZone for an always-like-this sender rule on a red alert", () => {
    const derived = derivePolicyFromFeedback(
      { ...richAlert, zone: "red" },
      "always-like-this",
      "sender",
    );
    expect(derived?.entry.minZone).toBe("red");
  });

  it("uses gray maxZone for a reduce sender rule on a non-red alert", () => {
    const derived = derivePolicyFromFeedback(richAlert, "reduce", "sender");
    expect(derived?.entry.maxZone).toBe("gray");
  });

  it("caps a digest-only domain rule at amber regardless of source zone", () => {
    for (const zone of ["red", "amber"] as const) {
      const derived = derivePolicyFromFeedback({ ...richAlert, zone }, "digest-only", "domain");
      expect(derived?.type).toBe("domain");
      expect(derived?.entry.maxZone).toBe("amber");
      expect(derived?.entry.minZone).toBeUndefined();
      expect(derived?.entry.reason).toBe("Derived from digest-only feedback for example.com");
    }
  });

  it("derives a subject-scoped content rule with the regex-escaped token", () => {
    const derived = derivePolicyFromFeedback(
      { ...richAlert, subject: "Re: Invoice freigegeben" },
      "reduce",
      "subject",
    );
    expect(derived?.type).toBe("content");
    expect(derived?.entry.scope).toBe("subject");
    expect(derived?.entry.pattern).toBe("freigegeben");
  });

  it("derives a body-scoped content rule from an explicit --contains token", () => {
    const derived = derivePolicyFromFeedback(richAlert, "reduce", "content", {
      contains: "a.b+c",
    });
    expect(derived?.type).toBe("content");
    expect(derived?.entry.scope).toBe("body");
    expect(derived?.entry.pattern).toBe("a\\.b\\+c");
    expect(derived?.entry.reason).toBe('Derived from reduce feedback for "a.b+c"');
  });

  it("falls back to the derived subject token when --contains is an empty string", () => {
    // An empty `contains` is not a usable token, so subject scope derives from
    // the alert subject instead.
    const derived = derivePolicyFromFeedback(richAlert, "reduce", "subject", { contains: "" });
    expect(derived?.entry.pattern).toBe("freigegeben");
  });

  it("returns null for a subject scope when the alert has no subject at all", () => {
    expect(
      derivePolicyFromFeedback({ ...richAlert, subject: undefined }, "reduce", "subject"),
    ).toBeNull();
  });

  it("returns null for the item scope (no broad rule)", () => {
    expect(derivePolicyFromFeedback(richAlert, "reduce", "item")).toBeNull();
  });

  it("returns null for a non-policy action regardless of scope", () => {
    expect(derivePolicyFromFeedback(richAlert, "important", "sender")).toBeNull();
  });

  it("uses the alert's subject when subjectToken returns no token but cleaned text remains", () => {
    // All words are short fillers/stopwords, so subjectToken falls back to the
    // whole cleaned subject — the rule is still derivable.
    const derived = derivePolicyFromFeedback(
      { ...richAlert, subject: "re: ab" },
      "reduce",
      "subject",
    );
    expect(derived?.entry.pattern).toBe(escapeRegExp("re: ab"));
  });

  describe("subjectToken", () => {
    it("picks the longest non-stopword token", () => {
      expect(subjectToken("Re: Invoice freigegeben")).toBe("freigegeben");
    });

    it("strips surrounding punctuation from candidate words", () => {
      expect(subjectToken("[URGENT] payment!")).toBe("payment");
    });

    it("keeps the longest token when a shorter one follows it", () => {
      // Exercises the reduce's keep-current branch: "freigegeben" stays the
      // winner even though "invoice" is scanned after it.
      expect(subjectToken("freigegeben invoice")).toBe("freigegeben");
    });

    it("falls back to the whole cleaned subject when only fillers remain", () => {
      expect(subjectToken("Re: the und")).toBe("Re: the und");
    });

    it("returns an empty string for an empty subject", () => {
      expect(subjectToken("   ")).toBe("");
    });

    it("ignores e2e tags via cleanSubjectForDisplay", () => {
      expect(subjectToken("Invoice freigegeben e2e-123")).toBe("freigegeben");
    });
  });

  describe("escapeRegExp", () => {
    it("escapes regex metacharacters", () => {
      expect(escapeRegExp("a.b+c*(d)")).toBe("a\\.b\\+c\\*\\(d\\)");
    });

    it("leaves plain text untouched", () => {
      expect(escapeRegExp("freigegeben")).toBe("freigegeben");
    });
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
