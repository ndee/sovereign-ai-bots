import { describe, expect, it, vi } from "vitest";
import { applyFeedbackToPolicy, effectiveDigestInterval, evaluateSignal } from "./policy.js";
import { createEmptySourcesDocument } from "./sources.js";
import { createDefaultState, createDefaultUserPolicy } from "./state.js";
import type { DeliveredSignal, NormalizedSignal, SourceConfigDocument } from "./types.js";

const config: SourceConfigDocument = {
  ...createEmptySourcesDocument(),
  profiles: [
    {
      id: "sovereign-ai-node",
      name: "Sovereign AI Node",
      enabled: true,
      lanePriorities: {
        matrix: 4,
        openclaw: 5,
        mail_stack: 3,
        ops_security: 4,
      },
      keywords: ["openclaw", "matrix", "security", "relay"],
      repoNames: ["openclaw/openclaw", "matrix-org/synapse"],
      organizations: ["openclaw", "matrix-org"],
      sourceAllowlist: ["openclaw-releases", "ubuntu-security"],
      sourceBlocklist: [],
      alerting: {
        redThreshold: 20,
        amberThreshold: 8,
        digestInterval: "6h",
      },
    },
    {
      id: "secondary",
      name: "Secondary",
      enabled: true,
      lanePriorities: { ops_security: 2 },
      keywords: ["ubuntu"],
      repoNames: [],
      organizations: [],
      sourceAllowlist: [],
      sourceBlocklist: [],
      alerting: {
        digestInterval: "3h",
      },
    },
  ],
  sources: [],
};

const signal = (overrides: Partial<NormalizedSignal> = {}): NormalizedSignal => ({
  fingerprint: "fp-1",
  contentFingerprint: "content-1",
  externalId: "release:1",
  sourceId: "openclaw-releases",
  sourceName: "OpenClaw Releases",
  sourceType: "github_releases",
  trustTier: "official",
  title: "OpenClaw v2.0.0 security release",
  url: "https://github.com/openclaw/openclaw/releases/tag/v2.0.0",
  summary: "Breaking adapter changes and security fixes.",
  publishedAt: "2026-04-17T10:00:00.000Z",
  updatedAt: "2026-04-17T10:00:00.000Z",
  lanes: ["openclaw", "ops_security"],
  repoName: "openclaw/openclaw",
  organization: "openclaw",
  tags: ["release", "security"],
  ...overrides,
});

const deliveredSignal = (overrides: Partial<DeliveredSignal> = {}): DeliveredSignal => ({
  signalId: "sig-1",
  fingerprint: "fp-1",
  kind: "new-signal",
  route: "amber",
  lane: "openclaw",
  lanes: ["openclaw"],
  sourceId: "openclaw-releases",
  sourceName: "OpenClaw Releases",
  sourceType: "github_releases",
  trustTier: "official",
  title: "OpenClaw v2.0.0",
  url: "https://github.com/openclaw/openclaw/releases/tag/v2.0.0",
  summary: "Release summary",
  why: "release stream",
  confidence: 70,
  score: 11,
  projectId: "sovereign-ai-node",
  publishedAt: "2026-04-17T10:00:00.000Z",
  updatedAt: "2026-04-17T10:00:00.000Z",
  sentAt: "2026-04-17T10:10:00.000Z",
  ...overrides,
});

describe("project-sentinel/policy", () => {
  it("picks the shortest configured digest interval", () => {
    expect(effectiveDigestInterval(config, "12h")).toBe("3h");
    expect(effectiveDigestInterval(createEmptySourcesDocument(), "12h")).toBe("12h");
    expect(
      effectiveDigestInterval(
        {
          ...createEmptySourcesDocument(),
          profiles: [
            {
              ...(config.profiles[0] as (typeof config.profiles)[number]),
              alerting: undefined,
            },
          ],
        },
        "12h",
      ),
    ).toBe("12h");
  });

  it("routes muted or unconfigured signals to gray", () => {
    const policy = createDefaultUserPolicy();
    policy.mutedFingerprints.push("fp-1");
    expect(evaluateSignal(signal({ lanes: [] }), config, policy, createDefaultState())).toEqual(
      expect.objectContaining({ route: "gray", lane: "ops_security" }),
    );
    expect(
      evaluateSignal(
        signal({ lanes: [] }),
        createEmptySourcesDocument(),
        createDefaultUserPolicy(),
        createDefaultState(),
      ),
    ).toEqual(expect.objectContaining({ why: "no active project profiles", lane: "ops_security" }));
    expect(
      evaluateSignal(
        signal({ lanes: [] }),
        createEmptySourcesDocument(),
        createDefaultUserPolicy(),
        createDefaultState(),
      ).why,
    ).toBe("no active project profiles");
  });

  it("routes strong official signals to red and weaker community signals to amber or gray", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-19T00:00:00.000Z"));
    const state = createDefaultState();
    expect(evaluateSignal(signal(), config, createDefaultUserPolicy(), state).route).toBe("red");
    expect(
      evaluateSignal(
        signal({
          sourceId: "community-issues",
          sourceName: "Community Issues",
          sourceType: "github_issues",
          trustTier: "community",
          title: "Adapter discussion",
          summary: "Potential plugin change.",
          repoName: undefined,
          organization: undefined,
          tags: ["issue"],
          contentFingerprint: "amber",
          externalId: "issue:1",
        }),
        config,
        createDefaultUserPolicy(),
        createDefaultState(),
      ).route,
    ).toBe("amber");
    expect(
      evaluateSignal(
        signal({
          sourceId: "low-feed",
          sourceName: "Low Feed",
          sourceType: "rss",
          trustTier: "low",
          title: "General commentary",
          summary: "This is broad ecosystem chatter.",
          repoName: undefined,
          organization: undefined,
          lanes: ["local_first_ai"],
          tags: ["commentary"],
          contentFingerprint: "gray",
          externalId: "rss:1",
        }),
        config,
        createDefaultUserPolicy(),
        createDefaultState(),
      ).route,
    ).toBe("gray");
    vi.useRealTimers();
  });

  it("applies source overrides and repeated-red suppression", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-19T00:00:00.000Z"));
    const state = createDefaultState();
    state.sourceStatus["openclaw-releases"] = {
      lastRedAt: "2026-04-18T22:30:00.000Z",
      consecutiveFailures: 0,
    };
    const policy = createDefaultUserPolicy();
    policy.sourceOverrides["openclaw-releases"] = { maxRoute: "amber" };
    expect(evaluateSignal(signal(), config, policy, state).route).toBe("amber");
    policy.sourceOverrides["openclaw-releases"] = { minRoute: "red" };
    expect(
      evaluateSignal(
        signal({
          title: "OpenClaw maintenance update",
          summary: "Minor release notes.",
          tags: ["release"],
          contentFingerprint: "suppressed",
        }),
        config,
        policy,
        state,
      ).route,
    ).toBe("red");

    const blockedConfig: SourceConfigDocument = {
      ...config,
      profiles: [
        {
          ...(config.profiles[0] as (typeof config.profiles)[number]),
          sourceBlocklist: ["blocked-source"],
          sourceAllowlist: [],
        },
      ],
    };
    const adjustedPolicy = createDefaultUserPolicy();
    adjustedPolicy.sourceWeights["weight-source"] = 3;
    adjustedPolicy.laneWeights.ops_security = 2;
    expect(
      evaluateSignal(
        signal({
          sourceId: "blocked-source",
          contentFingerprint: "blocked",
          title: "Blocked source relay notice",
          summary: "Relay maintenance window.",
          lanes: ["ops_security"],
        }),
        blockedConfig,
        adjustedPolicy,
        createDefaultState(),
      ).reasons,
    ).toContain("source blocked by project profile");

    const suppressed = evaluateSignal(
      signal({
        sourceId: "weight-source",
        contentFingerprint: "weighted",
        lanes: ["ops_security"],
      }),
      config,
      adjustedPolicy,
      {
        ...createDefaultState(),
        sourceStatus: {
          "weight-source": { lastRedAt: "2026-04-18T23:30:00.000Z", consecutiveFailures: 0 },
        },
      },
    );
    expect(suppressed.reasons).toContain("local source weight adjustment");
    expect(suppressed.reasons).toContain("local lane weight adjustment");
    expect(
      evaluateSignal(
        signal({ lanes: ["openclaw", "ops_security"], contentFingerprint: "plural" }),
        config,
        createDefaultUserPolicy(),
        createDefaultState(),
      ).reasons,
    ).toContain("matches openclaw, ops_security lanes");

    const repeatedPolicy = createDefaultUserPolicy();
    repeatedPolicy.sourceWeights["repeat-source"] = 2;
    const repeatedRed = evaluateSignal(
      signal({
        sourceId: "repeat-source",
        contentFingerprint: "repeat",
        sourceType: "rss",
        trustTier: "official",
        title: "Security discussion",
        summary: "Update note",
        lanes: ["ops_security"],
        repoName: undefined,
        organization: undefined,
        tags: [],
      }),
      config,
      repeatedPolicy,
      {
        ...createDefaultState(),
        sourceStatus: {
          "repeat-source": { lastRedAt: "2026-04-18T23:30:00.000Z", consecutiveFailures: 0 },
        },
      },
    );
    expect(repeatedRed.route).toBe("amber");
    expect(repeatedRed.reasons).toContain("recent red alert already sent from this source");
    expect(
      evaluateSignal(
        signal({ lanes: [], contentFingerprint: "fallback-lanes" }),
        config,
        createDefaultUserPolicy(),
        createDefaultState(),
      ),
    ).toEqual(expect.objectContaining({ lane: "ops_security", lanes: [] }));
    vi.useRealTimers();
  });

  it("applies each feedback action to local policy", () => {
    const base = createDefaultUserPolicy();
    expect(applyFeedbackToPolicy(base, deliveredSignal(), "more-like-this")).toEqual({
      policy: expect.objectContaining({
        sourceWeights: { "openclaw-releases": 2 },
      }),
      note: "Policy updated locally. Similar signals weighted higher.",
    });
    expect(applyFeedbackToPolicy(base, deliveredSignal(), "less-like-this")).toEqual({
      policy: expect.objectContaining({
        sourceWeights: { "openclaw-releases": -2 },
      }),
      note: "Policy updated locally. Similar signals weighted lower.",
    });
    expect(
      applyFeedbackToPolicy(
        {
          ...base,
          sourceOverrides: { "openclaw-releases": { minRoute: "red" } },
        },
        deliveredSignal(),
        "less-like-this",
      ).policy.sourceOverrides,
    ).toEqual({});
    expect(applyFeedbackToPolicy(base, deliveredSignal(), "always-alert")).toEqual({
      policy: expect.objectContaining({
        sourceOverrides: { "openclaw-releases": { minRoute: "red" } },
      }),
      note: "Policy updated locally. Source pinned to immediate alerts.",
    });
    expect(applyFeedbackToPolicy(base, deliveredSignal(), "digest-only")).toEqual({
      policy: expect.objectContaining({
        sourceOverrides: { "openclaw-releases": { maxRoute: "amber" } },
      }),
      note: "Policy updated locally. Source limited to digest routing.",
    });
    expect(applyFeedbackToPolicy(base, deliveredSignal(), "not-relevant")).toEqual({
      policy: expect.objectContaining({
        sourceWeights: { "openclaw-releases": -4 },
        mutedFingerprints: ["fp-1"],
      }),
      note: "Policy updated locally. Similar signals suppressed.",
    });
    expect(
      applyFeedbackToPolicy(
        {
          ...base,
          sourceOverrides: { "openclaw-releases": { minRoute: "red" } },
        },
        deliveredSignal(),
        "not-relevant",
      ).policy.sourceOverrides,
    ).toEqual({});
  });
});
