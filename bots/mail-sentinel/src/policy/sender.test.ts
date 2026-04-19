import { describe, expect, it, vi } from "vitest";
import { senderState } from "../__fixtures__/inputs.js";
import { loadGolden, normalizeUuids } from "../__fixtures__/load.js";
import { createDefaultPolicy } from "../state/schema.js";
import {
  collectKnownSenders,
  extractDisplayName,
  findSenderCandidates,
  pickResolvedSender,
  scoreSenderCandidate,
  summarizeSenderCandidate,
  tokenizeSenderText,
  upsertSenderPolicy,
} from "./sender.js";

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    randomUUID: () => "00000000-0000-0000-0000-000000000000",
  };
});

describe("policy/sender", () => {
  it("matches the extractDisplayName golden fixture", () => {
    expect({
      withAngle: extractDisplayName("Alice Smith <alice@example.com>"),
      justName: extractDisplayName("Alice"),
      empty: extractDisplayName(""),
    }).toEqual(loadGolden("extractDisplayName"));
  });

  it("matches the tokenizeSenderText golden fixture", () => {
    expect({
      simple: tokenizeSenderText("Alice Smith"),
      withEmail: tokenizeSenderText("alice <alice@example.com>"),
      punct: tokenizeSenderText("Alice: Smith!"),
    }).toEqual(loadGolden("tokenizeSenderText"));
  });

  it("matches the collectKnownSenders golden fixture", () => {
    expect(collectKnownSenders(senderState)).toEqual(loadGolden("collectKnownSenders"));
  });

  it("matches the scoreSenderCandidate golden fixture", () => {
    expect({
      exact: scoreSenderCandidate(
        {
          from: "Alice Smith <alice@example.com>",
          fromAddress: "alice@example.com",
          domain: "example.com",
        },
        "alice@example.com",
      ),
      display: scoreSenderCandidate(
        {
          from: "Alice Smith <alice@example.com>",
          fromAddress: "alice@example.com",
          domain: "example.com",
        },
        "alice smith",
      ),
      none: scoreSenderCandidate(
        {
          from: "Alice Smith <alice@example.com>",
          fromAddress: "alice@example.com",
          domain: "example.com",
        },
        "zzz",
      ),
    }).toEqual(loadGolden("scoreSenderCandidate"));
  });

  it("matches the findSenderCandidates golden fixtures", () => {
    expect(findSenderCandidates(senderState, "alice")).toEqual(
      loadGolden("findSenderCandidates.alice"),
    );
    expect(findSenderCandidates(senderState, "alice@example.com")).toEqual(
      loadGolden("findSenderCandidates.exact"),
    );
    expect(findSenderCandidates(senderState, "")).toEqual(loadGolden("findSenderCandidates.empty"));
    expect(findSenderCandidates(senderState, "zzz")).toEqual(
      loadGolden("findSenderCandidates.noMatch"),
    );
  });

  it("skips messages without a fromAddress when collecting known senders", () => {
    const state = {
      ...senderState,
      messages: {
        bad: { ...senderState.messages["msg:1"]!, fromAddress: undefined, key: "bad" },
      },
    };
    expect(collectKnownSenders(state)).toEqual([]);
  });

  it("matches the pickResolvedSender empty golden fixture", () => {
    expect(pickResolvedSender([])).toBeNull();
  });

  it("returns the single match unchanged", () => {
    expect(
      pickResolvedSender([
        {
          fromAddress: "a@b",
          score: 100,
          from: "A <a@b>",
          domain: "b",
          messageCount: 1,
          lastSeenAt: "x",
        },
      ]),
    ).toEqual({
      fromAddress: "a@b",
      score: 100,
      from: "A <a@b>",
      domain: "b",
      messageCount: 1,
      lastSeenAt: "x",
    });
  });

  it("returns null when two high-display-token matches collide", () => {
    expect(
      pickResolvedSender([
        {
          fromAddress: "alice@example.com",
          score: 210,
          from: "Alice Smith <alice@example.com>",
          domain: "example.com",
          messageCount: 3,
          lastSeenAt: "x",
        },
        {
          fromAddress: "other@example.com",
          score: 210,
          from: "Alice Smith <other@example.com>",
          domain: "example.com",
          messageCount: 1,
          lastSeenAt: "y",
        },
      ]),
    ).toBeNull();
  });

  it("resolves the top match when it is clearly ahead", () => {
    expect(
      pickResolvedSender([
        {
          fromAddress: "alice@example.com",
          score: 250,
          from: "Alice <alice@example.com>",
          domain: "example.com",
          messageCount: 2,
          lastSeenAt: "x",
        },
        {
          fromAddress: "alicia@example.com",
          score: 130,
          from: "Alicia <alicia@example.com>",
          domain: "example.com",
          messageCount: 1,
          lastSeenAt: "y",
        },
      ])?.fromAddress,
    ).toBe("alice@example.com");
  });

  it("resolves by wide-gap rule when top score is only 160 but 40+ ahead", () => {
    expect(
      pickResolvedSender([
        {
          fromAddress: "alice@example.com",
          score: 160,
          from: "Alice <alice@example.com>",
          domain: "example.com",
          messageCount: 2,
          lastSeenAt: "x",
        },
        {
          fromAddress: "alicia@example.com",
          score: 100,
          from: "Alicia <alicia@example.com>",
          domain: "example.com",
          messageCount: 1,
          lastSeenAt: "y",
        },
      ])?.fromAddress,
    ).toBe("alice@example.com");
  });

  it("returns null when both top scores are close and below the clear-lead threshold", () => {
    expect(
      pickResolvedSender([
        {
          fromAddress: "alice@example.com",
          score: 130,
          from: "Alice <alice@example.com>",
          domain: "example.com",
          messageCount: 2,
          lastSeenAt: "x",
        },
        {
          fromAddress: "alicia@example.com",
          score: 120,
          from: "Alicia <alicia@example.com>",
          domain: "example.com",
          messageCount: 1,
          lastSeenAt: "y",
        },
      ]),
    ).toBeNull();
  });

  it("matches the summarizeSenderCandidate golden fixture", () => {
    expect(
      summarizeSenderCandidate({
        from: "Alice",
        fromAddress: "alice@example.com",
        domain: "example.com",
        messageCount: 5,
        lastSeenAt: "2026-04-08T10:00:00Z",
      }),
    ).toEqual(loadGolden("summarizeSenderCandidate"));
  });

  it("omits domain from the summary when unknown", () => {
    expect(
      summarizeSenderCandidate({
        from: "Bob",
        fromAddress: "bob@somewhere",
        messageCount: 1,
        lastSeenAt: "x",
      }),
    ).toEqual({ from: "Bob", fromAddress: "bob@somewhere", messageCount: 1, lastSeenAt: "x" });
  });

  it("matches the upsertSenderPolicy create golden fixture", () => {
    expect(
      normalizeUuids(
        upsertSenderPolicy(createDefaultPolicy(), {
          match: "alice@example.com",
          minZone: "amber",
          reason: "test",
        }),
      ),
    ).toEqual(loadGolden("upsertSenderPolicy.create"));
  });

  it("matches the upsertSenderPolicy updateNoop golden fixture", () => {
    expect(
      normalizeUuids(
        upsertSenderPolicy(
          {
            version: 1,
            senderPolicies: [
              { id: "existing", match: "alice@example.com", minZone: "amber", reason: "old" },
            ],
            domainPolicies: [],
            receiverPolicies: [],
            categoryPolicies: [],
            contentPolicies: [],
            timePolicies: [],
            mutePolicies: [],
          },
          { match: "alice@example.com", minZone: "amber", reason: "new" },
        ),
      ),
    ).toEqual(loadGolden("upsertSenderPolicy.updateNoop"));
  });

  it("matches the upsertSenderPolicy updateRaiseZone golden fixture", () => {
    expect(
      normalizeUuids(
        upsertSenderPolicy(
          {
            version: 1,
            senderPolicies: [{ id: "existing", match: "alice@example.com", minZone: "amber" }],
            domainPolicies: [],
            receiverPolicies: [],
            categoryPolicies: [],
            contentPolicies: [],
            timePolicies: [],
            mutePolicies: [],
          },
          { match: "alice@example.com", minZone: "red" },
        ),
      ),
    ).toEqual(loadGolden("upsertSenderPolicy.updateRaiseZone"));
  });

  it("matches the upsertSenderPolicy clearMaxZone golden fixture", () => {
    expect(
      normalizeUuids(
        upsertSenderPolicy(
          {
            version: 1,
            senderPolicies: [{ id: "existing", match: "alice@example.com", maxZone: "amber" }],
            domainPolicies: [],
            receiverPolicies: [],
            categoryPolicies: [],
            contentPolicies: [],
            timePolicies: [],
            mutePolicies: [],
          },
          { match: "alice@example.com", clearMaxZone: true },
        ),
      ),
    ).toEqual(loadGolden("upsertSenderPolicy.clearMaxZone"));
  });

  it("scores a sender via each field branch", () => {
    // exact from match
    expect(
      scoreSenderCandidate(
        { from: "alice", fromAddress: "alice@example.com", domain: "example.com" },
        "alice",
      ),
    ).toBeGreaterThanOrEqual(220);
    // exact domain match
    expect(
      scoreSenderCandidate(
        { from: "alice@example.com", fromAddress: "alice@example.com", domain: "example" },
        "example",
      ),
    ).toBeGreaterThanOrEqual(200);
    // startsWith on from
    expect(
      scoreSenderCandidate(
        {
          from: "alice smith <alice@example.com>",
          fromAddress: "alice@example.com",
          domain: "example.com",
        },
        "alice smith",
      ),
    ).toBeGreaterThanOrEqual(160);
    // startsWith on domain
    expect(
      scoreSenderCandidate(
        {
          from: "Alice <alice@example.com>",
          fromAddress: "alice@example.com",
          domain: "example.com",
        },
        "example",
      ),
    ).toBeGreaterThanOrEqual(140);
    // includes on address
    expect(
      scoreSenderCandidate(
        {
          from: "Alice <alice@example.com>",
          fromAddress: "xx-alice-yy@example.com",
          domain: "example.com",
        },
        "alice",
      ),
    ).toBeGreaterThanOrEqual(130);
    // includes on from
    expect(
      scoreSenderCandidate(
        { from: "Person alice Smith <a@b>", fromAddress: "a@b", domain: "b" },
        "alice",
      ),
    ).toBeGreaterThanOrEqual(120);
    // includes on domain
    expect(
      scoreSenderCandidate(
        {
          from: "Alice <alice@foo-example-bar.com>",
          fromAddress: "alice@foo-example-bar.com",
          domain: "foo-example-bar.com",
        },
        "example",
      ),
    ).toBeGreaterThanOrEqual(100);
    // display token path
    expect(
      scoreSenderCandidate(
        { from: "Alice Smith", fromAddress: "alice@example.com", domain: "example.com" },
        "alice smith",
      ),
    ).toBeGreaterThanOrEqual(210);
    // from token path
    expect(
      scoreSenderCandidate(
        { from: "alice xyzzyp", fromAddress: "alice@example.com", domain: "example.com" },
        "xyzzyp",
      ),
    ).toBeGreaterThanOrEqual(120);
  });

  it("keeps the existing domain when a later message has no domain", () => {
    const state = {
      ...senderState,
      messages: {
        "msg:first": {
          ...senderState.messages["msg:1"]!,
          key: "msg:first",
          fromAddress: "alice@example.com",
          domain: "example.com",
          lastSeenAt: "2026-04-08T10:00:00Z",
        },
        "msg:second": {
          ...senderState.messages["msg:1"]!,
          key: "msg:second",
          fromAddress: "alice@example.com",
          domain: undefined,
          lastSeenAt: "2026-04-08T11:00:00Z",
        },
      },
    };
    const senders = collectKnownSenders(state);
    const alice = senders.find((s) => s.fromAddress === "alice@example.com");
    expect(alice?.domain).toBe("example.com");
  });

  it("uses an ASCII fallback for collectKnownSenders when an existing sender has no domain", () => {
    const state = {
      ...senderState,
      messages: {
        ...senderState.messages,
        nodomain: {
          ...senderState.messages["msg:1"]!,
          key: "nodomain",
          fromAddress: "x@somewhere",
          domain: undefined,
        },
      },
    };
    const senders = collectKnownSenders(state);
    const match = senders.find((s) => s.fromAddress === "x@somewhere");
    expect(match?.domain).toBe("somewhere");
  });

  it("extractDisplayName handles nullish values", () => {
    expect(extractDisplayName(null)).toBe("");
    expect(extractDisplayName(undefined)).toBe("");
  });

  it("scoreSenderCandidate handles candidates with missing from/domain", () => {
    const score = scoreSenderCandidate(
      { from: undefined as unknown as string, fromAddress: "alice@example.com", domain: undefined },
      "alice",
    );
    expect(score).toBeGreaterThan(0);
  });

  it("sorts candidates by score descending when scores differ", () => {
    // exact address match (score 250) vs. domain includes match (score 100)
    const candidates = findSenderCandidates(
      {
        ...senderState,
        messages: {
          a: {
            ...senderState.messages["msg:1"]!,
            key: "a",
            fromAddress: "alice",
            from: "Alice <alice>",
            domain: undefined,
            lastSeenAt: "2026-04-08T10:00:00Z",
          },
          b: {
            ...senderState.messages["msg:1"]!,
            key: "b",
            fromAddress: "bob@alicecorp.example",
            from: "Bob <bob@alicecorp.example>",
            domain: "alicecorp.example",
            lastSeenAt: "2026-04-08T11:00:00Z",
          },
        },
      },
      "alice",
    );
    expect(candidates.length).toBe(2);
    // "alice" === "alice" → 250
    // "bob@alicecorp.example" includes "alice" → 130, domain "alicecorp.example" includes → 100
    expect(candidates[0]?.fromAddress).toBe("alice");
    expect(candidates[1]?.fromAddress).toBe("bob@alicecorp.example");
  });

  it("sorts two equal-score candidates by lastSeenAt descending", () => {
    const candidates = findSenderCandidates(
      {
        ...senderState,
        messages: {
          newer: {
            ...senderState.messages["msg:1"]!,
            key: "newer",
            fromAddress: "aaa@example.com",
            from: "Alice <aaa@example.com>",
            lastSeenAt: "2026-04-08T11:00:00Z",
          },
          older: {
            ...senderState.messages["msg:1"]!,
            key: "older",
            fromAddress: "aab@example.com",
            from: "Alice <aab@example.com>",
            lastSeenAt: "2026-04-08T09:00:00Z",
          },
        },
      },
      "alice",
    );
    expect(candidates[0]?.fromAddress).toBe("aaa@example.com");
  });

  it("tie-breaks by lastSeenAt then fromAddress when scores match", () => {
    const candidates = findSenderCandidates(
      {
        ...senderState,
        messages: {
          "msg:a": {
            ...senderState.messages["msg:1"]!,
            key: "msg:a",
            fromAddress: "aaa@example.com",
            from: "Alice <aaa@example.com>",
            lastSeenAt: "2026-04-08T10:00:00Z",
          },
          "msg:b": {
            ...senderState.messages["msg:1"]!,
            key: "msg:b",
            fromAddress: "bbb@example.com",
            from: "Alice <bbb@example.com>",
            lastSeenAt: "2026-04-08T10:00:00Z",
          },
        },
      },
      "alice",
    );
    expect(candidates[0]?.fromAddress).toBe("aaa@example.com");
  });

  it("upsertSenderPolicy handles existing entries without a match field", () => {
    const result = upsertSenderPolicy(
      {
        version: 1,
        senderPolicies: [{ id: "other" } as unknown as { id: string }],
        domainPolicies: [],
        receiverPolicies: [],
        categoryPolicies: [],
        contentPolicies: [],
        timePolicies: [],
        mutePolicies: [],
      },
      { match: "alice@example.com", minZone: "amber" },
    );
    expect(result.created).toBe(true);
  });

  it("takes the minimum of two max zones when both are provided", () => {
    const result = upsertSenderPolicy(
      {
        version: 1,
        senderPolicies: [{ id: "existing", match: "a@b", maxZone: "amber" }],
        domainPolicies: [],
        receiverPolicies: [],
        categoryPolicies: [],
        contentPolicies: [],
        timePolicies: [],
        mutePolicies: [],
      },
      { match: "a@b", maxZone: "red" },
    );
    expect(result.entry.maxZone).toBe("amber");
  });
});
