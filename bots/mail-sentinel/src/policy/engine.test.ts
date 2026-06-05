import { describe, expect, it } from "vitest";
import { sampleMessage, samplePolicy } from "../__fixtures__/inputs.js";
import { loadGolden } from "../__fixtures__/load.js";
import type { MailSentinelPolicy, ReceiverTarget } from "../types.js";
import {
  contentHaystack,
  defaultContentReason,
  evaluatePolicy,
  isTimeInSchedule,
  matchesPolicyEntry,
  receiverCandidates,
} from "./engine.js";

const emptyPolicy = (
  receiverPolicies: MailSentinelPolicy["receiverPolicies"],
): MailSentinelPolicy => ({
  version: 1,
  senderPolicies: [],
  domainPolicies: [],
  receiverPolicies,
  categoryPolicies: [],
  contentPolicies: [],
  timePolicies: [],
  mutePolicies: [],
});

const bucketMessage = {
  ...sampleMessage,
  ccAddresses: ["match@business.com"],
  deliveredToAddresses: ["match@business.com"],
  aliasTargets: ["match@business.com"],
};

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
        receiverPolicies: [],
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
        receiverPolicies: [],
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
        receiverPolicies: [],
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
        receiverPolicies: [],
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
        receiverPolicies: [],
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
        receiverPolicies: [],
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
        receiverPolicies: [],
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
        receiverPolicies: [],
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
        receiverPolicies: [],
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
        receiverPolicies: [],
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
        receiverPolicies: [{ id: "r3", match: "me@business.com", boost: 5 }],
        categoryPolicies: [],
        contentPolicies: [],
        timePolicies: [],
        mutePolicies: [],
      },
      new Date("2026-04-08T12:00:00Z"),
    );
    expect(result.matchedPolicyIds).toEqual([]);
  });

  it("skips receiver policies with an empty or missing match pattern", () => {
    const result = evaluatePolicy(
      { ...sampleMessage, toAddresses: ["me@business.com"] },
      { category: "financial-relevance" },
      {
        version: 1,
        senderPolicies: [],
        domainPolicies: [],
        receiverPolicies: [
          { id: "r4", match: "", boost: 5 },
          { id: "r4b", boost: 5 },
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

  it("does not match a receiver policy when toAddresses is empty", () => {
    const result = evaluatePolicy(
      { ...sampleMessage, toAddresses: [] },
      { category: "financial-relevance" },
      emptyPolicy([{ id: "r5", match: "me@business.com", boost: 5 }]),
      new Date("2026-04-08T12:00:00Z"),
    );
    expect(result.matchedPolicyIds).toEqual([]);
  });

  describe("receiverCandidates", () => {
    const message = {
      ...sampleMessage,
      toAddresses: ["me@business.com", "cc@example.com"],
      ccAddresses: ["cc@example.com"],
      deliveredToAddresses: ["alias@business.com"],
      aliasTargets: ["catchall@business.com"],
    };

    it("resolves each target to its bucket", () => {
      expect(receiverCandidates(message, "cc")).toEqual(["cc@example.com"]);
      expect(receiverCandidates(message, "delivered_to")).toEqual(["alias@business.com"]);
      expect(receiverCandidates(message, "alias")).toEqual(["catchall@business.com"]);
      expect(receiverCandidates(message, "to")).toEqual(["me@business.com", "cc@example.com"]);
      expect(receiverCandidates(message, undefined)).toEqual(["me@business.com", "cc@example.com"]);
    });

    it("falls back to an empty list when a targeted bucket is absent", () => {
      expect(receiverCandidates(sampleMessage, "cc")).toEqual([]);
      expect(receiverCandidates(sampleMessage, "delivered_to")).toEqual([]);
      expect(receiverCandidates(sampleMessage, "alias")).toEqual([]);
    });
  });

  it.each<[ReceiverTarget, keyof typeof bucketMessage]>([
    ["cc", "ccAddresses"],
    ["delivered_to", "deliveredToAddresses"],
    ["alias", "aliasTargets"],
  ])("matches a receiver policy targeted at %s", (target) => {
    const result = evaluatePolicy(
      bucketMessage,
      { category: "financial-relevance" },
      emptyPolicy([{ id: "t1", match: "match@business.com", target, boost: 4 }]),
      new Date("2026-04-08T12:00:00Z"),
    );
    expect(result.matchedPolicyIds).toContain("t1");
    expect(result.scoreModifier).toBe(4);
  });

  it("does not match a targeted receiver policy against the wrong bucket", () => {
    const result = evaluatePolicy(
      // The match address lives only in cc, but the rule targets delivered_to.
      { ...sampleMessage, ccAddresses: ["match@business.com"] },
      { category: "financial-relevance" },
      emptyPolicy([{ id: "t2", match: "match@business.com", target: "delivered_to", boost: 4 }]),
      new Date("2026-04-08T12:00:00Z"),
    );
    expect(result.matchedPolicyIds).toEqual([]);
  });

  it("applies mute > ceiling precedence for a targeted alias mute rule", () => {
    const result = evaluatePolicy(
      { ...sampleMessage, aliasTargets: ["newsletters@business.com"] },
      { category: "financial-relevance" },
      emptyPolicy([
        { id: "t3", match: "newsletters@business.com", target: "alias", action: "mute" },
      ]),
      new Date("2026-04-08T12:00:00Z"),
    );
    expect(result.matchedPolicyIds).toContain("t3");
    expect(result.muted).toBe(true);
    expect(result.zoneCeiling).toBe("gray");
  });
});

describe("policy/engine subject-scoped content policies", () => {
  // Distinct tokens: "freigegeben" only in the subject, "approveinbody" only in
  // the body, "snippetonly" only in the preview snippet, so subject/body/snippet
  // scoping is unambiguous.
  const scopedMessage = {
    ...sampleMessage,
    subject: "Auftrag freigegeben",
    text: "Internal note: approveinbody marker",
    snippet: "Preview: snippetonly marker",
  };
  const emptyPolicy = {
    version: 1,
    senderPolicies: [],
    domainPolicies: [],
    receiverPolicies: [],
    categoryPolicies: [],
    contentPolicies: [],
    timePolicies: [],
    mutePolicies: [],
  };
  const referenceDate = new Date("2026-04-08T12:00:00Z");

  it("selects the haystack per scope", () => {
    expect(contentHaystack(scopedMessage, "subject")).toBe("Auftrag freigegeben");
    expect(contentHaystack(scopedMessage, "body")).toBe("Internal note: approveinbody marker");
    expect(contentHaystack(scopedMessage, "snippet")).toBe("Preview: snippetonly marker");
    expect(contentHaystack(scopedMessage, "any")).toBe(
      "Auftrag freigegeben\nInternal note: approveinbody marker",
    );
    expect(contentHaystack(scopedMessage, undefined)).toBe(
      "Auftrag freigegeben\nInternal note: approveinbody marker",
    );
  });

  it("builds a scope-aware default reason", () => {
    expect(defaultContentReason({ scope: "subject", pattern: "freigegeben" })).toBe(
      "subject matches /freigegeben/",
    );
    expect(defaultContentReason({ scope: "body", pattern: "x" })).toBe("body matches /x/");
    expect(defaultContentReason({ scope: "snippet", pattern: "z" })).toBe("snippet matches /z/");
    expect(defaultContentReason({ pattern: "y" })).toBe("content matches /y/");
    expect(defaultContentReason({})).toBe("content matches //");
  });

  it("NFC-normalizes the haystack so decomposed accents fold to precomposed", () => {
    // Subject carries a decomposed umlaut: "u" + U+0308 COMBINING DIAERESIS.
    const decomposed = { ...sampleMessage, subject: "Auftrag überfällig" };
    const haystack = contentHaystack(decomposed, "subject");
    expect(haystack).toBe("Auftrag überfällig");
    expect(haystack).toBe("Auftrag überfällig".normalize("NFC"));
  });

  // Build the matcher exactly like policyAdd does for `--contains`.
  const subjectRule = (id: string, term: string) => ({
    id,
    pattern: term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    scope: "subject" as const,
    maxZone: "gray" as const,
  });
  const evalSubject = (subject: string, term: string) =>
    evaluatePolicy(
      { ...sampleMessage, subject },
      { category: "financial-relevance" },
      { ...emptyPolicy, contentPolicies: [subjectRule("c-de", term)] },
      referenceDate,
    ).matchedPolicyIds;

  it("matches German subjects regardless of case (umlaut case-folding)", () => {
    expect(evalSubject("Rechnung freigegeben", "freigegeben")).toEqual(["c-de"]);
    expect(evalSubject("Rechnung FREIGEGEBEN", "freigegeben")).toEqual(["c-de"]);
    // Umlaut case folds: Ä/Ö/Ü <-> ä/ö/ü under the regex `i` flag.
    expect(evalSubject("ÜBERFÄLLIG zahlung", "überfällig")).toEqual(["c-de"]);
    expect(evalSubject("Große Überweisung", "große")).toEqual(["c-de"]);
  });

  it("matches a decomposed subject against a precomposed German rule term", () => {
    // Precomposed rule term vs subject with decomposed umlauts — this is the
    // cross-normalization case NFC closes.
    expect(evalSubject("Rechnung überfällig", "überfällig")).toEqual(["c-de"]);
    // And the mirror: precomposed subject vs a decomposed rule term.
    expect(evalSubject("Rechnung überfällig", "überfällig")).toEqual(["c-de"]);
  });

  it("does not match a German term that is absent from the subject", () => {
    expect(evalSubject("Routine update", "freigegeben")).toEqual([]);
  });

  it("matches a subject-scoped rule on the subject but not the body", () => {
    const subjectHit = evaluatePolicy(
      scopedMessage,
      { category: "financial-relevance" },
      {
        ...emptyPolicy,
        contentPolicies: [
          { id: "c-subject", pattern: "freigegeben", scope: "subject", maxZone: "gray" },
        ],
      },
      referenceDate,
    );
    expect(subjectHit.matchedPolicyIds).toEqual(["c-subject"]);
    expect(subjectHit.reasons).toEqual(["subject matches /freigegeben/"]);
    expect(subjectHit.zoneCeiling).toBe("gray");

    const bodyTokenInSubjectScope = evaluatePolicy(
      scopedMessage,
      { category: "financial-relevance" },
      {
        ...emptyPolicy,
        contentPolicies: [{ id: "c-subject-miss", pattern: "approveinbody", scope: "subject" }],
      },
      referenceDate,
    );
    expect(bodyTokenInSubjectScope.matchedPolicyIds).toEqual([]);
  });

  it("matches a body-scoped rule on the body but not the subject", () => {
    const bodyHit = evaluatePolicy(
      scopedMessage,
      { category: "financial-relevance" },
      {
        ...emptyPolicy,
        contentPolicies: [
          { id: "c-body", pattern: "approveinbody", scope: "body", minZone: "red" },
        ],
      },
      referenceDate,
    );
    expect(bodyHit.matchedPolicyIds).toEqual(["c-body"]);
    expect(bodyHit.reasons).toEqual(["body matches /approveinbody/"]);
    expect(bodyHit.zoneFloor).toBe("red");

    const subjectTokenInBodyScope = evaluatePolicy(
      scopedMessage,
      { category: "financial-relevance" },
      {
        ...emptyPolicy,
        contentPolicies: [{ id: "c-body-miss", pattern: "freigegeben", scope: "body" }],
      },
      referenceDate,
    );
    expect(subjectTokenInBodyScope.matchedPolicyIds).toEqual([]);
  });

  it("matches a snippet-scoped rule on the preview but not the subject or body", () => {
    const snippetHit = evaluatePolicy(
      scopedMessage,
      { category: "financial-relevance" },
      {
        ...emptyPolicy,
        contentPolicies: [
          { id: "c-snippet", pattern: "snippetonly", scope: "snippet", maxZone: "gray" },
        ],
      },
      referenceDate,
    );
    expect(snippetHit.matchedPolicyIds).toEqual(["c-snippet"]);
    expect(snippetHit.reasons).toEqual(["snippet matches /snippetonly/"]);
    expect(snippetHit.zoneCeiling).toBe("gray");

    const bodyTokenInSnippetScope = evaluatePolicy(
      scopedMessage,
      { category: "financial-relevance" },
      {
        ...emptyPolicy,
        contentPolicies: [{ id: "c-snippet-miss", pattern: "approveinbody", scope: "snippet" }],
      },
      referenceDate,
    );
    expect(bodyTokenInSnippetScope.matchedPolicyIds).toEqual([]);
  });

  it("confines a snippet-scoped rule to the local preview, not the full body", () => {
    // A token that lives only in the full body past the preview window must not
    // match a snippet-scoped rule: the haystack is the local snippet alone, never
    // the rest of the body (and never a remote fetch).
    const longBody = {
      ...scopedMessage,
      snippet: "Preview text without the tail token",
      text: "Preview text without the tail token ... beyondsnippet marker",
    };
    const result = evaluatePolicy(
      longBody,
      { category: "financial-relevance" },
      {
        ...emptyPolicy,
        contentPolicies: [{ id: "c-snippet-tail", pattern: "beyondsnippet", scope: "snippet" }],
      },
      referenceDate,
    );
    expect(result.matchedPolicyIds).toEqual([]);
  });

  it("treats any/absent scope as subject+body combined", () => {
    const anyHit = evaluatePolicy(
      scopedMessage,
      { category: "financial-relevance" },
      {
        ...emptyPolicy,
        contentPolicies: [
          { id: "c-any-subject", pattern: "freigegeben", scope: "any" },
          { id: "c-absent-body", pattern: "approveinbody" },
        ],
      },
      referenceDate,
    );
    expect(anyHit.matchedPolicyIds).toEqual(["c-any-subject", "c-absent-body"]);
  });

  it("honours an explicit reason over the scope-aware default", () => {
    const result = evaluatePolicy(
      scopedMessage,
      { category: "financial-relevance" },
      {
        ...emptyPolicy,
        contentPolicies: [
          { id: "c-reason", pattern: "freigegeben", scope: "subject", reason: "release notice" },
        ],
      },
      referenceDate,
    );
    expect(result.reasons).toEqual(["release notice"]);
  });

  it("applies the amount threshold against the scoped haystack only", () => {
    // The subject carries no amount, so a subject-scoped amount rule never fires
    // even though the body mentions a large amount.
    const amountMessage = {
      ...sampleMessage,
      subject: "Payment freigegeben",
      text: "Total due: $5000",
    };
    const subjectAmountMiss = evaluatePolicy(
      amountMessage,
      { category: "financial-relevance" },
      {
        ...emptyPolicy,
        contentPolicies: [
          { id: "c-amt-subject", pattern: "freigegeben", scope: "subject", amountThreshold: 100 },
        ],
      },
      referenceDate,
    );
    expect(subjectAmountMiss.matchedPolicyIds).toEqual([]);

    const bodyAmountHit = evaluatePolicy(
      amountMessage,
      { category: "financial-relevance" },
      {
        ...emptyPolicy,
        contentPolicies: [
          { id: "c-amt-body", pattern: "due", scope: "body", amountThreshold: 100 },
        ],
      },
      referenceDate,
    );
    expect(bodyAmountHit.matchedPolicyIds).toEqual(["c-amt-body"]);
  });
});
