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
});
