import { describe, expect, it } from "vitest";
import { sampleMessage, samplePolicy } from "../__fixtures__/inputs.js";
import { loadGolden } from "../__fixtures__/load.js";
import { evaluatePolicy, isTimeInSchedule, matchesPolicyEntry } from "./engine.js";

describe("policy/engine", () => {
  it("matches the matchesPolicyEntry golden fixture", () => {
    expect({
      senderHit: matchesPolicyEntry(sampleMessage, samplePolicy.senderPolicies[0]!),
      senderMiss: matchesPolicyEntry(sampleMessage, { match: "bob@*.com" }),
      empty: matchesPolicyEntry(sampleMessage, { match: "" }),
    }).toEqual(loadGolden("matchesPolicyEntry"));
  });

  it("ignores policy entries without a match/pattern", () => {
    expect(matchesPolicyEntry(sampleMessage, {})).toBe(false);
  });

  it("matches the isTimeInSchedule golden fixture", () => {
    expect({
      inside: isTimeInSchedule(new Date("2026-04-08T12:00:00Z"), "09:00-17:00"),
      outside: isTimeInSchedule(new Date("2026-04-08T05:00:00Z"), "09:00-17:00"),
      crossMidnight: isTimeInSchedule(new Date("2026-04-08T23:30:00Z"), "22:00-06:00"),
      invalid: isTimeInSchedule(new Date("2026-04-08T12:00:00Z"), "nope"),
    }).toEqual(loadGolden("isTimeInSchedule"));
  });

  it("treats a non-string schedule as no match", () => {
    expect(isTimeInSchedule(new Date(), 42 as unknown as string)).toBe(false);
  });

  it("covers both sides of the cross-midnight OR (TZ-independent)", () => {
    // Use Date constructor with local components so the test is deterministic
    // across runner timezones. 02:30 local falls inside 22:00-06:00 via the
    // `<= endMinutes` branch, and 23:30 local falls inside via the
    // `>= startMinutes` branch.
    const earlyMorning = new Date(2026, 3, 8, 2, 30, 0);
    const lateNight = new Date(2026, 3, 8, 23, 30, 0);
    expect(isTimeInSchedule(earlyMorning, "22:00-06:00")).toBe(true);
    expect(isTimeInSchedule(lateNight, "22:00-06:00")).toBe(true);
    // Outside the window still returns false.
    const noon = new Date(2026, 3, 8, 12, 0, 0);
    expect(isTimeInSchedule(noon, "22:00-06:00")).toBe(false);
  });

  it("matches the evaluatePolicy golden fixture", () => {
    expect(
      evaluatePolicy(
        sampleMessage,
        { category: "financial-relevance" },
        samplePolicy,
        new Date("2026-04-08T12:00:00Z"),
      ),
    ).toEqual(loadGolden("evaluatePolicy"));
  });

  it("mutes a message that matches a mute policy", () => {
    const result = evaluatePolicy(
      { ...sampleMessage, fromAddress: "noreply@foo.example", from: "noreply@foo.example" },
      { category: "financial-relevance" },
      {
        ...samplePolicy,
        senderPolicies: [],
        contentPolicies: [],
        timePolicies: [],
        categoryPolicies: [],
        domainPolicies: [],
      },
      new Date("2026-04-08T12:00:00Z"),
    );
    expect(result.muted).toBe(true);
    expect(result.zoneCeiling).toBe("gray");
  });

  it("skips content policies without a pattern or with a non-matching regex", () => {
    const result = evaluatePolicy(
      sampleMessage,
      { category: "financial-relevance" },
      {
        version: 1,
        senderPolicies: [],
        domainPolicies: [],
        categoryPolicies: [],
        contentPolicies: [
          { id: "c-nopattern" },
          { id: "c-nomatch", pattern: "definitely-not-in-subject-or-body" },
          { id: "c-amount-below", pattern: "invoice", amountThreshold: 99999 },
        ],
        timePolicies: [],
        mutePolicies: [],
      },
      new Date("2026-04-08T12:00:00Z"),
    );
    expect(result.matchedPolicyIds).toEqual([]);
  });

  it("matches empty-match policies against messages with undefined fields (degenerate empty-empty match)", () => {
    const bareMessage = { ...sampleMessage, fromAddress: undefined, domain: undefined };
    const result = evaluatePolicy(
      bareMessage,
      { category: "financial-relevance" },
      {
        version: 1,
        senderPolicies: [{ id: "p1" }],
        domainPolicies: [{ id: "p2" }],
        categoryPolicies: [],
        contentPolicies: [],
        timePolicies: [],
        mutePolicies: [],
      },
      new Date("2026-04-08T12:00:00Z"),
    );
    // matchGlob("", "") matches because both escape to "^$" which matches empty.
    expect(result.matchedPolicyIds).toEqual(["p1", "p2"]);
  });

  it("matches sender and domain policies even when the message has undefined fields", () => {
    const bareMessage = { ...sampleMessage, fromAddress: undefined, domain: undefined };
    const result = evaluatePolicy(
      bareMessage,
      { category: "financial-relevance" },
      {
        version: 1,
        senderPolicies: [{ id: "p1", match: "*@example.com", reason: "wide" }],
        domainPolicies: [{ id: "p2", match: "example.com", reason: "domain" }],
        categoryPolicies: [],
        contentPolicies: [],
        timePolicies: [],
        mutePolicies: [],
      },
      new Date("2026-04-08T12:00:00Z"),
    );
    // Neither should match because fromAddress and domain are undefined
    expect(result.matchedPolicyIds).toEqual([]);
  });

  it("tracks maxZone and the zoneMin ceiling when two entries compete", () => {
    const result = evaluatePolicy(
      sampleMessage,
      { category: "financial-relevance" },
      {
        version: 1,
        senderPolicies: [
          { id: "pA", match: "alice@*", maxZone: "red" },
          { id: "pB", match: "alice@*", maxZone: "amber" },
        ],
        domainPolicies: [],
        categoryPolicies: [],
        contentPolicies: [],
        timePolicies: [],
        mutePolicies: [],
      },
      new Date("2026-04-08T12:00:00Z"),
    );
    expect(result.zoneCeiling).toBe("amber");
  });

  it("matches policies via the matchGlob fallback on fromAddress", () => {
    const result = evaluatePolicy(
      sampleMessage,
      { category: "financial-relevance" },
      {
        version: 1,
        senderPolicies: [{ id: "p", match: "alice@example.com", reason: "exact" }],
        domainPolicies: [],
        categoryPolicies: [],
        contentPolicies: [],
        timePolicies: [],
        mutePolicies: [],
      },
      new Date("2026-04-08T12:00:00Z"),
    );
    expect(result.matchedPolicyIds).toContain("p");
  });

  it("matches domain, category, and time policies to exercise noteMatch", () => {
    const result = evaluatePolicy(
      sampleMessage,
      { category: "financial-relevance" },
      {
        version: 1,
        senderPolicies: [],
        domainPolicies: [{ id: "d", match: "example.com", reason: "known" }],
        categoryPolicies: [{ id: "c", category: "financial-relevance", reason: "finance" }],
        contentPolicies: [],
        timePolicies: [{ id: "t", schedule: "00:00-23:59", reason: "business" }],
        mutePolicies: [],
      },
      new Date("2026-04-08T12:00:00Z"),
    );
    expect(result.matchedPolicyIds).toEqual(["d", "c", "t"]);
  });

  it("uses the mute policy reason as the matched reason", () => {
    const result = evaluatePolicy(
      { ...sampleMessage, fromAddress: "noreply@spam", from: "noreply@spam" },
      { category: "financial-relevance" },
      {
        version: 1,
        senderPolicies: [],
        domainPolicies: [],
        categoryPolicies: [],
        contentPolicies: [],
        timePolicies: [],
        mutePolicies: [{ id: "m", match: "noreply@*", reason: "custom mute reason" }],
      },
      new Date("2026-04-08T12:00:00Z"),
    );
    expect(result.reasons).toContain("custom mute reason");
  });

  it("falls back to the default mute reason when the policy has none", () => {
    const result = evaluatePolicy(
      { ...sampleMessage, fromAddress: "noreply@spam", from: "noreply@spam" },
      { category: "financial-relevance" },
      {
        version: 1,
        senderPolicies: [],
        domainPolicies: [],
        categoryPolicies: [],
        contentPolicies: [],
        timePolicies: [],
        mutePolicies: [{ id: "m", match: "noreply@*" }],
      },
      new Date("2026-04-08T12:00:00Z"),
    );
    expect(result.reasons.some((r) => r.includes("muted by policy"))).toBe(true);
  });

  it("records policy matches without an id", () => {
    const result = evaluatePolicy(
      sampleMessage,
      { category: "financial-relevance" },
      {
        version: 1,
        senderPolicies: [{ match: "alice@*", boost: 1 }],
        domainPolicies: [],
        categoryPolicies: [],
        contentPolicies: [],
        timePolicies: [],
        mutePolicies: [],
      },
      new Date("2026-04-08T12:00:00Z"),
    );
    expect(result.scoreModifier).toBe(1);
    expect(result.matchedPolicyIds).toEqual([]);
  });

  it("stacks sender-policy boost with zone floor and minConfidence", () => {
    const result = evaluatePolicy(
      sampleMessage,
      { category: "financial-relevance" },
      {
        version: 1,
        senderPolicies: [
          { id: "p1", match: "alice@*", minZone: "amber", boost: 2, minConfidence: 50 },
          { id: "p2", match: "alice@*", minZone: "red", boost: 3, minConfidence: 70 },
        ],
        domainPolicies: [],
        categoryPolicies: [],
        contentPolicies: [],
        timePolicies: [],
        mutePolicies: [],
      },
      new Date("2026-04-08T12:00:00Z"),
    );
    expect(result.zoneFloor).toBe("red");
    expect(result.minConfidence).toBe(70);
    expect(result.scoreModifier).toBe(5);
  });

  it("matches a receiver policy when toAddresses contains the match", () => {
    const result = evaluatePolicy(
      { ...sampleMessage, toAddresses: ["me@business.com", "cc@other.com"] },
      { category: "financial-relevance" },
      {
        version: 1,
        senderPolicies: [],
        domainPolicies: [],
        receiverPolicies: [
          { id: "r1", match: "me@business.com", minZone: "red", boost: 5, reason: "business mail" },
        ],
        categoryPolicies: [],
        contentPolicies: [],
        timePolicies: [],
        mutePolicies: [],
      },
      new Date("2026-04-08T12:00:00Z"),
    );
    expect(result.matchedPolicyIds).toContain("r1");
    expect(result.zoneFloor).toBe("red");
    expect(result.scoreModifier).toBe(5);
    expect(result.reasons).toContain("business mail");
  });

  it("matches a receiver policy with a glob pattern", () => {
    const result = evaluatePolicy(
      { ...sampleMessage, toAddresses: ["me@mybusiness.com"] },
      { category: "financial-relevance" },
      {
        version: 1,
        senderPolicies: [],
        domainPolicies: [],
        receiverPolicies: [
          { id: "r2", match: "*@mybusiness.com", boost: 3, reason: "all business addresses" },
        ],
        categoryPolicies: [],
        contentPolicies: [],
        timePolicies: [],
        mutePolicies: [],
      },
      new Date("2026-04-08T12:00:00Z"),
    );
    expect(result.matchedPolicyIds).toContain("r2");
    expect(result.scoreModifier).toBe(3);
  });

  it("does not match a receiver policy when no toAddresses match", () => {
    const result = evaluatePolicy(
      { ...sampleMessage, toAddresses: ["personal@home.com"] },
      { category: "financial-relevance" },
      {
        version: 1,
        senderPolicies: [],
        domainPolicies: [],
        receiverPolicies: [
          { id: "r3", match: "me@business.com", boost: 5 },
        ],
        categoryPolicies: [],
        contentPolicies: [],
        timePolicies: [],
        mutePolicies: [],
      },
      new Date("2026-04-08T12:00:00Z"),
    );
    expect(result.matchedPolicyIds).toEqual([]);
  });

  it("skips receiver policies with an empty match pattern", () => {
    const result = evaluatePolicy(
      { ...sampleMessage, toAddresses: ["me@business.com"] },
      { category: "financial-relevance" },
      {
        version: 1,
        senderPolicies: [],
        domainPolicies: [],
        receiverPolicies: [{ id: "r4", match: "", boost: 5 }],
        categoryPolicies: [],
        contentPolicies: [],
        timePolicies: [],
        mutePolicies: [],
      },
      new Date("2026-04-08T12:00:00Z"),
    );
    expect(result.matchedPolicyIds).toEqual([]);
  });

  it("does not match a receiver policy when toAddresses is empty", () => {
    const result = evaluatePolicy(
      { ...sampleMessage, toAddresses: [] },
      { category: "financial-relevance" },
      {
        version: 1,
        senderPolicies: [],
        domainPolicies: [],
        receiverPolicies: [
          { id: "r5", match: "me@business.com", boost: 5 },
        ],
        categoryPolicies: [],
        contentPolicies: [],
        timePolicies: [],
        mutePolicies: [],
      },
      new Date("2026-04-08T12:00:00Z"),
    );
    expect(result.matchedPolicyIds).toEqual([]);
  });
});
