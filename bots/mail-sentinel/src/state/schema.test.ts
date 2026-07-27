import { describe, expect, it } from "vitest";

import { loadGolden } from "../__fixtures__/load.js";
import type { MailSentinelState } from "../types.js";
import {
  createDefaultPolicy,
  createDefaultState,
  migrateState,
  normalizePolicy,
  pruneState,
} from "./schema.js";

describe("state/schema", () => {
  it("matches the createDefaultPolicy golden fixture", () => {
    expect(createDefaultPolicy()).toEqual(loadGolden("createDefaultPolicy"));
  });

  it("matches the createDefaultState golden fixture", () => {
    expect(createDefaultState()).toEqual(loadGolden("createDefaultState"));
  });

  it("matches the migrateState.empty golden fixture", () => {
    expect(migrateState({})).toEqual(loadGolden("migrateState.empty"));
  });

  it("matches the migrateState.partial golden fixture", () => {
    expect(
      migrateState({
        version: 1,
        mailbox: { lastSeenUid: 7 },
        messages: {
          "msg:<a@b>": { key: "msg:<a@b>", uid: 5, lastSeenAt: "2026-04-08T10:00:00Z" },
        },
        alerts: [{ alertId: "x", sentAt: "2026-04-08T10:00:00Z", zone: "red" }],
        feedback: "not-an-array",
        learning: { senderWeights: { "a@b.com": 2 } },
        digest: { pendingAmber: ["x"], lastDigestAt: "2026-04-08T09:00:00Z" },
      }),
    ).toEqual(loadGolden("migrateState.partial"));
  });

  it("matches the pruneState golden fixture", () => {
    const bulkMessages: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 12; i += 1) {
      const key = `msg:<${i}@bulk>`;
      bulkMessages[key] = {
        key,
        uid: i,
        lastSeenAt: new Date(Date.UTC(2026, 3, 8, 10, i, 0)).toISOString(),
        subject: `msg ${i}`,
      };
    }
    const migrated = migrateState({
      mailbox: { lastSeenUid: 11 },
      messages: bulkMessages,
      alerts: Array.from({ length: 3 }, (_, i) => ({
        alertId: `alert-${i}`,
        sentAt: new Date(Date.UTC(2026, 3, 8, 10, i, 0)).toISOString(),
        zone: "amber",
      })),
      feedback: Array.from({ length: 3 }, (_, i) => ({
        alertId: `alert-${i}`,
        action: "important",
        at: new Date(Date.UTC(2026, 3, 8, 10, i, 0)).toISOString(),
      })),
      digest: {
        pendingAmber: Array.from({ length: 5 }, (_, i) => `alert-${i}`),
      },
      zoneHistory: Array.from({ length: 4 }, (_, i) => ({
        at: new Date(Date.UTC(2026, 3, 8, 10, i, 0)).toISOString(),
        messageKey: `msg:<${i}@bulk>`,
        zone: "gray",
        reason: "none",
      })),
    });
    expect(pruneState(migrated)).toEqual(loadGolden("pruneState"));
  });

  it("drops pending-amber IDs whose alert was pruned, keeping resolvable ones", () => {
    // A pending-amber ID pointing at an alert that no longer exists in
    // state.alerts (evicted by the newest-500 cap on a red-heavy mailbox) would
    // otherwise linger forever and, once every pending ID is dangling, wedge the
    // digest permanently empty (it clears pendingAmber only on a real send).
    const state = migrateState({
      alerts: [{ alertId: "live-amber", sentAt: "2026-04-08T10:00:00.000Z", zone: "amber" }],
      digest: {
        pendingAmber: ["live-amber", "pruned-away"],
      },
    }) as MailSentinelState;
    pruneState(state);
    expect(state.digest.pendingAmber).toEqual(["live-amber"]);
  });

  it("prunes state down to the retention window", () => {
    const bulkMessages: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 5100; i += 1) {
      const key = `msg:${i}`;
      bulkMessages[key] = { key, uid: i, lastSeenAt: new Date(i).toISOString() };
    }
    const state = migrateState({ messages: bulkMessages }) as MailSentinelState;
    pruneState(state);
    expect(Object.keys(state.messages)).toHaveLength(5000);
  });

  // F-01 added degradation counters to the state file. Nodes upgrading in place
  // load a state document written before those fields existed, and it must not
  // fault or invent counts.
  describe("degradation-field migration (F-01)", () => {
    const preDegradationState = {
      version: 2,
      lastPollAt: "2026-04-08T10:00:00.000Z",
      lastAlertAt: "2026-04-08T09:00:00.000Z",
      lastImapSuccessAt: "2026-04-08T10:00:00.000Z",
      consecutiveFailures: 0,
      mailbox: { lastSeenUid: 42, uidValidity: "111" },
      messages: {},
      alerts: [],
      feedback: [],
      learning: { senderWeights: {}, domainWeights: {}, ruleAdjustments: {} },
      digest: { pendingAmber: [] },
      zoneHistory: [],
    };

    it("loads a pre-degradation state file without inventing counters", () => {
      const migrated = migrateState(preDegradationState);
      expect(migrated.lastScanLlmFailures).toBeUndefined();
      expect(migrated.lastScanCandidates).toBeUndefined();
      expect(migrated.lastScanWarnings).toBeUndefined();
      expect(migrated.degradationState).toBeUndefined();
    });

    it("preserves everything else from a pre-degradation state file", () => {
      const migrated = migrateState(preDegradationState);
      expect(migrated.mailbox.lastSeenUid).toBe(42);
      expect(migrated.mailbox.uidValidity).toBe("111");
      expect(migrated.lastPollAt).toBe("2026-04-08T10:00:00.000Z");
      expect(migrated.version).toBe(2);
    });

    it("round-trips persisted degradation counters", () => {
      const migrated = migrateState({
        ...preDegradationState,
        lastScanLlmFailures: 3,
        lastScanCandidates: 7,
        lastScanWarnings: 2,
        degradationState: "classification-degraded",
      });
      expect(migrated.lastScanLlmFailures).toBe(3);
      expect(migrated.lastScanCandidates).toBe(7);
      expect(migrated.lastScanWarnings).toBe(2);
      expect(migrated.degradationState).toBe("classification-degraded");
    });

    it("keeps zero counters as zero rather than dropping them", () => {
      const migrated = migrateState({ ...preDegradationState, lastScanLlmFailures: 0 });
      expect(migrated.lastScanLlmFailures).toBe(0);
    });

    // A NaN or a string counter reaching deriveDegradationState would silently
    // break the comparison, so a hand-edited file falls back to "unknown".
    it("discards non-numeric, negative, and non-finite counters", () => {
      const migrated = migrateState({
        ...preDegradationState,
        lastScanLlmFailures: "many",
        lastScanCandidates: -1,
        lastScanWarnings: Number.POSITIVE_INFINITY,
        degradationState: 42,
      } as unknown);
      expect(migrated.lastScanLlmFailures).toBeUndefined();
      expect(migrated.lastScanCandidates).toBeUndefined();
      expect(migrated.lastScanWarnings).toBeUndefined();
      expect(migrated.degradationState).toBeUndefined();
    });
  });

  it("matches the normalizePolicy golden fixture", () => {
    expect({
      empty: normalizePolicy(undefined),
      partial: normalizePolicy({ senderPolicies: [{ id: "x", match: "a@b" }] }),
    }).toEqual(loadGolden("normalizePolicy"));
  });

  it("migrateState handles a null input", () => {
    expect(migrateState(null)).toEqual(createDefaultState());
  });

  it("normalizes non-array policy lists to empty arrays", () => {
    expect(
      normalizePolicy({
        senderPolicies: "nope",
        domainPolicies: null,
        categoryPolicies: undefined,
        contentPolicies: {},
        timePolicies: 42,
        mutePolicies: "also-nope",
      } as unknown),
    ).toEqual(createDefaultPolicy());
  });

  it("preserves the content-policy scope through a normalize round-trip", () => {
    const normalized = normalizePolicy({
      contentPolicies: [{ id: "c1", pattern: "freigegeben", scope: "subject", maxZone: "gray" }],
    });
    expect(normalized.contentPolicies[0]).toEqual({
      id: "c1",
      pattern: "freigegeben",
      scope: "subject",
      maxZone: "gray",
    });
  });

  it("preserves a receiver-policy target through a normalize round-trip", () => {
    const normalized = normalizePolicy({
      receiverPolicies: [{ id: "r1", match: "cc@business.com", target: "cc", minZone: "amber" }],
    });
    expect(normalized.receiverPolicies[0]).toEqual({
      id: "r1",
      match: "cc@business.com",
      target: "cc",
      minZone: "amber",
    });
  });
});
