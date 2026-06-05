import { describe, expect, it } from "vitest";
import { createDefaultState } from "../state/schema.js";
import type { MailSentinelState, StoredAlert } from "../types.js";
import { resolveAlertTarget } from "./resolve.js";

const alert = (overrides: Partial<StoredAlert> = {}): StoredAlert => ({
  alertId: "11111111-1111-1111-1111-111111111111",
  shortRef: "111111",
  zone: "amber",
  category: "financial-relevance",
  subject: "Invoice overdue",
  from: "Billing <billing@example.com>",
  fromAddress: "billing@example.com",
  domain: "example.com",
  why: "w",
  sentAt: "2026-04-08T08:00:00.000Z",
  feedbackState: "pending",
  ...overrides,
});

const stateWith = (alerts: StoredAlert[], lastDigestAlertIds?: string[]): MailSentinelState => {
  const state = createDefaultState();
  state.alerts = alerts;
  if (lastDigestAlertIds !== undefined) {
    state.digest.lastDigestAlertIds = lastDigestAlertIds;
  }
  return state;
};

describe("commands/resolve resolveAlertTarget", () => {
  it("returns none for an empty / whitespace ref", () => {
    expect(resolveAlertTarget(stateWith([alert()]), "   ").status).toBe("none");
  });

  it("returns none when nothing matches any modality", () => {
    expect(resolveAlertTarget(stateWith([alert()]), "zzzzzz").status).toBe("none");
  });

  it("resolves by full alertId (case-insensitive)", () => {
    const result = resolveAlertTarget(
      stateWith([
        alert(),
        alert({ alertId: "22222222-2222-2222-2222-222222222222", shortRef: "222222" }),
      ]),
      "22222222-2222-2222-2222-222222222222".toUpperCase(),
    );
    expect(result).toEqual({
      status: "ok",
      alert: expect.objectContaining({ shortRef: "222222" }),
    });
  });

  it("resolves by a unique short-ref prefix and strips brackets", () => {
    const result = resolveAlertTarget(
      stateWith([
        alert(),
        alert({ alertId: "abcdef00-0000-0000-0000-000000000000", shortRef: "abcdef" }),
      ]),
      "[abc]",
    );
    expect(result).toEqual({
      status: "ok",
      alert: expect.objectContaining({ shortRef: "abcdef" }),
    });
  });

  it("returns ambiguous with candidates when a short-ref prefix matches many", () => {
    const result = resolveAlertTarget(
      stateWith([
        alert({
          alertId: "aa000000-0000-0000-0000-000000000000",
          shortRef: "aa0000",
          subject: "First",
        }),
        alert({
          alertId: "aa111111-0000-0000-0000-000000000000",
          shortRef: "aa1111",
          subject: "Second",
        }),
      ]),
      "aa",
    );
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates.map((c) => c.subject)).toEqual(["First", "Second"]);
      expect(result.candidates[0]).toEqual({
        alertId: "aa000000-0000-0000-0000-000000000000",
        shortRef: "aa0000",
        subject: "First",
        from: "Billing <billing@example.com>",
      });
    }
  });

  it("resolves by digest position (strips a leading #)", () => {
    // Short refs deliberately do not start with the position digit, so the
    // short-ref stage (which runs before position) cannot intercept "2".
    const first = alert({
      alertId: "aa000000-0000-0000-0000-000000000000",
      shortRef: "aaaaaa",
      subject: "First",
    });
    const second = alert({
      alertId: "bb000000-0000-0000-0000-000000000000",
      shortRef: "bbbbbb",
      subject: "Second",
    });
    const result = resolveAlertTarget(
      stateWith([first, second], [first.alertId, second.alertId]),
      "#2",
    );
    expect(result).toEqual({ status: "ok", alert: expect.objectContaining({ subject: "Second" }) });
  });

  it("falls through to none for an out-of-range position", () => {
    expect(resolveAlertTarget(stateWith([alert()], [alert().alertId]), "9").status).toBe("none");
  });

  it("treats a numeric ref as no-match when no digest has been sent", () => {
    // lastDigestAlertIds is undefined; the short-ref here does not start with
    // the digit, so position is the deciding stage and finds no order.
    expect(resolveAlertTarget(stateWith([alert({ shortRef: "aaaaaa" })]), "1").status).toBe("none");
  });

  it("does not treat a position pointing at an absent alert as a match", () => {
    // lastDigestAlertIds references an alert no longer in state.alerts. Use a
    // shortRef that does not start with the position digit so the short-ref
    // stage (which runs before position) cannot intercept it.
    const result = resolveAlertTarget(
      stateWith([alert({ shortRef: "aaaaaa" })], ["ghost-id"]),
      "2",
    );
    // position #2 -> undefined (only one id); falls through to none.
    expect(result.status).toBe("none");
  });

  it("resolves by subject substring, normalizing Re:/whitespace", () => {
    const result = resolveAlertTarget(
      stateWith([
        alert({
          alertId: "33333333-3333-3333-3333-333333333333",
          shortRef: "333333",
          subject: "Re: Quarterly Report",
        }),
        alert({
          alertId: "44444444-4444-4444-4444-444444444444",
          shortRef: "444444",
          subject: "Lunch",
        }),
      ]),
      "quarterly report",
    );
    expect(result).toEqual({
      status: "ok",
      alert: expect.objectContaining({ subject: "Re: Quarterly Report" }),
    });
  });

  it("returns ambiguous when a subject substring matches many", () => {
    const result = resolveAlertTarget(
      stateWith([
        alert({
          alertId: "55555555-5555-5555-5555-555555555555",
          shortRef: "555555",
          subject: "Invoice March",
          fromAddress: "a@x.com",
          from: "a@x.com",
        }),
        alert({
          alertId: "66666666-6666-6666-6666-666666666666",
          shortRef: "666666",
          subject: "Invoice April",
          fromAddress: "b@y.com",
          from: "b@y.com",
        }),
      ]),
      "invoice",
    );
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidates).toHaveLength(2);
    }
  });

  it("ignores a subject ref that normalizes to empty and falls through", () => {
    // "re:" normalizes to "" so subject matching is skipped; nothing else
    // matches -> none.
    expect(resolveAlertTarget(stateWith([alert({ subject: "Anything" })]), "re:").status).toBe(
      "none",
    );
  });

  it("resolves by sender when subject does not match", () => {
    const result = resolveAlertTarget(
      stateWith([
        alert({
          alertId: "77777777-7777-7777-7777-777777777777",
          shortRef: "777777",
          subject: "Receipt",
          from: "Billing <billing@example.com>",
          fromAddress: "billing@example.com",
        }),
      ]),
      "billing@example.com",
    );
    expect(result).toEqual({
      status: "ok",
      alert: expect.objectContaining({ shortRef: "777777" }),
    });
  });

  it("returns ambiguous when a sender matches multiple alerts", () => {
    const result = resolveAlertTarget(
      stateWith([
        alert({
          alertId: "88888888-8888-8888-8888-888888888888",
          shortRef: "888888",
          subject: "One",
          from: "Billing <billing@example.com>",
          fromAddress: "billing@example.com",
        }),
        alert({
          alertId: "99999999-9999-9999-9999-999999999999",
          shortRef: "999999",
          subject: "Two",
          from: "Billing <billing@example.com>",
          fromAddress: "billing@example.com",
        }),
      ]),
      "billing@example.com",
    );
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidates.map((c) => c.subject)).toEqual(["One", "Two"]);
    }
  });

  it("skips alerts without a fromAddress when matching by sender", () => {
    const result = resolveAlertTarget(
      stateWith([
        alert({
          alertId: "aaaaaaaa-0000-0000-0000-000000000000",
          shortRef: "aaaaaa",
          subject: "Has addr",
          from: "Billing <billing@example.com>",
          fromAddress: "billing@example.com",
        }),
        alert({
          alertId: "bbbbbbbb-0000-0000-0000-000000000000",
          shortRef: "bbbbbb",
          subject: "No addr",
          from: "billing text only",
          fromAddress: undefined,
        }),
      ]),
      "billing@example.com",
    );
    expect(result).toEqual({
      status: "ok",
      alert: expect.objectContaining({ subject: "Has addr" }),
    });
  });
});
