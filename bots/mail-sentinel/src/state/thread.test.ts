import { describe, expect, it } from "vitest";
import { senderState } from "../__fixtures__/inputs.js";
import { loadGolden } from "../__fixtures__/load.js";
import { migrateState } from "./schema.js";
import { buildThreadContext, queueAmberAlert, resolvePendingAmberAlerts } from "./thread.js";

describe("state/thread", () => {
  it("matches the buildThreadContext golden fixture", () => {
    expect(
      buildThreadContext(senderState, {
        key: "msg:new",
        normalizedThreadSubject: "hi",
      }),
    ).toEqual(loadGolden("buildThreadContext"));
  });

  it("excludes the current message from its own thread context", () => {
    const result = buildThreadContext(senderState, {
      key: "msg:1",
      normalizedThreadSubject: "hi",
    });
    expect(result.every((entry) => entry.subject !== "hi")).toBe(true);
  });

  it("returns thread entries when messages share a normalized subject", () => {
    const state = migrateState({
      messages: {
        a: {
          key: "a",
          uid: 1,
          subject: "Re: Budget",
          normalizedThreadSubject: "budget",
          from: "Alice <a@example.com>",
          snippet: "context a",
          date: "2026-04-07T10:00:00Z",
          firstSeenAt: "2026-04-07T10:00:00Z",
          lastSeenAt: "2026-04-07T10:00:00Z",
        },
        b: {
          key: "b",
          uid: 2,
          subject: "Budget",
          normalizedThreadSubject: "budget",
          from: "Bob <b@example.com>",
          snippet: "context b",
          firstSeenAt: "2026-04-08T10:00:00Z",
          lastSeenAt: "2026-04-08T10:00:00Z",
        },
      },
    });
    const result = buildThreadContext(state, {
      key: "new",
      normalizedThreadSubject: "budget",
    });
    expect(result).toHaveLength(2);
    // Most recent first
    expect(result[0]?.subject).toBe("Budget");
    expect(result[0]?.date).toBeUndefined();
    expect(result[1]?.date).toBe("2026-04-07T10:00:00Z");
  });

  it("dedupes queueAmberAlert calls for the same alert id", () => {
    expect(
      (() => {
        const s = migrateState({});
        queueAmberAlert(s, "alert-1");
        queueAmberAlert(s, "alert-1");
        queueAmberAlert(s, "alert-2");
        return s.digest;
      })(),
    ).toEqual(loadGolden("queueAmberAlert.new"));
  });

  it("matches the resolvePendingAmberAlerts golden fixture", () => {
    expect(
      resolvePendingAmberAlerts(
        migrateState({
          alerts: [
            { alertId: "a1", zone: "amber", sentAt: "2026-04-08T10:00:00Z" },
            { alertId: "a2", zone: "red", sentAt: "2026-04-08T11:00:00Z" },
          ],
          digest: { pendingAmber: ["a1", "a2", "a3-missing"] },
        }),
      ),
    ).toEqual(loadGolden("resolvePendingAmberAlerts"));
  });
});
