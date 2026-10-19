import { describe, expect, it, vi } from "vitest";

import {
  applyInventoryListing,
  buildLedgerKey,
  createLedger,
  localDay,
  type MailLedger,
  type OutcomeState,
  recordOutcome,
} from "./ledger.js";
import {
  announceUnaccountedIfDue,
  buildUnaccountedNotice,
  NOTICE_LOOKBACK_DAYS,
} from "./notice.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOON = new Date("2026-10-19T12:00:00.000Z");
const at = (offsetMs: number): Date => new Date(NOON.getTime() + offsetMs);
const TODAY = localDay(NOON);
const key = (uid: number): string => buildLedgerKey("imap:7", uid);

const ledgerWith = (states: Array<[OutcomeState, Date?]>): MailLedger => {
  const ledger = createLedger();
  states.forEach(([state, when], index) => {
    recordOutcome(ledger, key(index + 1), { state }, when ?? NOON);
  });
  return ledger;
};

describe("ledger/notice > buildUnaccountedNotice", () => {
  it("stays quiet when everything was checked or is still in progress", () => {
    expect(
      buildUnaccountedNotice(ledgerWith([["red"], ["gray"], ["pending"]]), NOON),
    ).toBeUndefined();
  });

  it("summarises today's unaccounted mail by cause", () => {
    const notice = buildUnaccountedNotice(
      ledgerWith([
        ["read-failed"],
        ["read-failed"],
        ["too-large"],
        ["not-returned"],
        ["no-verdict:reviewer-unavailable"],
        ["gray"],
      ]),
      NOON,
    );
    expect(notice).toEqual({
      body: 'Mail Sentinel: 5 messages received today could not be checked: 2 could not be read, 1 too large to read, 1 never reached the scan, 1 got no review verdict. Check them in your mail client, or ask "integrity" for details.',
      formattedBody:
        '<b>Mail Sentinel: 5 messages received today could not be checked: 2 could not be read, 1 too large to read, 1 never reached the scan, 1 got no review verdict.</b> Check them in your mail client, or ask "integrity" for details.',
      reported: { [TODAY]: 5 },
    });
  });

  it("names a single earlier day and uses the singular", () => {
    const notice = buildUnaccountedNotice(ledgerWith([["no-verdict:refused", at(-DAY_MS)]]), NOON);
    expect(notice?.body).toContain(
      `1 message received on ${localDay(at(-DAY_MS))} could not be checked: 1 got no review verdict.`,
    );
  });

  it("spans several days and leaves out causes with no count", () => {
    const notice = buildUnaccountedNotice(
      ledgerWith([
        ["too-large", at(-2 * DAY_MS)],
        ["too-large", NOON],
      ]),
      NOON,
    );
    expect(notice?.body).toContain(
      `2 messages received between ${localDay(at(-2 * DAY_MS))} and ${TODAY} could not be checked: 2 too large to read.`,
    );
    expect(notice?.reported).toEqual({ [localDay(at(-2 * DAY_MS))]: 1, [TODAY]: 1 });
  });

  it("reports a counting defect on its own when nothing else is unaccounted", () => {
    const ledger = ledgerWith([["gray"], ["gray"]]);
    delete ledger.entries[key(1)];
    const notice = buildUnaccountedNotice(ledger, NOON);
    expect(notice?.body).toBe(
      'Mail Sentinel: the message counts for mail received today do not balance (difference 1). Ask "reconcile" for details.',
    );
    expect(notice?.formattedBody).toBe(`<b>${notice?.body}</b>`);
  });

  it("adds the counting defect after the unaccounted summary", () => {
    const ledger = ledgerWith([["read-failed"], ["gray"]]);
    delete ledger.entries[key(2)];
    const notice = buildUnaccountedNotice(ledger, NOON);
    expect(notice?.body).toMatch(
      /could not be read\. Check them .* do not balance \(difference 1\)\./u,
    );
    expect(notice?.reported).toEqual({ [TODAY]: 2 });
  });

  it("sends at most one notice per day", () => {
    const ledger = ledgerWith([["read-failed"]]);
    ledger.notice.lastSentDay = TODAY;
    expect(buildUnaccountedNotice(ledger, NOON)).toBeUndefined();
  });

  it("only raises days whose count grew past what was already reported", () => {
    const ledger = ledgerWith([["read-failed"], ["read-failed", at(-DAY_MS)]]);
    ledger.notice.reported[TODAY] = 1;
    ledger.notice.reported[localDay(at(-DAY_MS))] = 0;
    expect(buildUnaccountedNotice(ledger, NOON)?.reported).toEqual({ [localDay(at(-DAY_MS))]: 1 });
    ledger.notice.reported[localDay(at(-DAY_MS))] = 1;
    expect(buildUnaccountedNotice(ledger, NOON)).toBeUndefined();
  });

  it("ignores days older than the lookback", () => {
    const ledger = ledgerWith([["read-failed", at(-(NOTICE_LOOKBACK_DAYS + 1) * DAY_MS)]]);
    expect(buildUnaccountedNotice(ledger, NOON)).toBeUndefined();
  });

  it("never carries an identifier, subject or sender", () => {
    const ledger = createLedger();
    applyInventoryListing(
      ledger,
      { keySpace: "imap:7", fullCensus: true, uidRanges: [[1, 4]] },
      NOON,
      {
        searchWindowMs: DAY_MS,
      },
    );
    recordOutcome(ledger, key(98765), { state: "read-failed", reason: "timeout" }, NOON);
    const notice = buildUnaccountedNotice(ledger, NOON);
    const text = `${notice?.body} ${notice?.formattedBody}`;
    expect(text).not.toContain("98765");
    expect(text).not.toContain("imap:7");
    expect(text).not.toMatch(/@|Subject|From:/u);
  });
});

describe("ledger/notice > announceUnaccountedIfDue", () => {
  it("does nothing when no notice is due", async () => {
    const send = vi.fn(async () => undefined);
    expect(
      await announceUnaccountedIfDue({ sendMatrixRoomMessage: send }, createLedger(), NOON),
    ).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("records delivery only after the send succeeds", async () => {
    const ledger = ledgerWith([["too-large"]]);
    const send = vi.fn(
      async (_message: string | { body: string; formattedBody: string }) => undefined,
    );
    expect(await announceUnaccountedIfDue({ sendMatrixRoomMessage: send }, ledger, NOON)).toBe(
      true,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ body: expect.stringContaining("too large") });
    expect(ledger.notice).toEqual({ reported: { [TODAY]: 1 }, lastSentDay: TODAY });
    // Same day again: nothing more to send.
    expect(
      await announceUnaccountedIfDue({ sendMatrixRoomMessage: send }, ledger, at(HOUR_MS)),
    ).toBe(false);
  });

  it("keeps a failed notice queued for the next scan", async () => {
    const ledger = ledgerWith([["too-large"]]);
    const failing = vi.fn(async () => {
      throw new Error("matrix down");
    });
    expect(await announceUnaccountedIfDue({ sendMatrixRoomMessage: failing }, ledger, NOON)).toBe(
      false,
    );
    expect(ledger.notice).toEqual({ reported: {} });
    const send = vi.fn(async () => undefined);
    expect(
      await announceUnaccountedIfDue({ sendMatrixRoomMessage: send }, ledger, at(HOUR_MS)),
    ).toBe(true);
  });
});
