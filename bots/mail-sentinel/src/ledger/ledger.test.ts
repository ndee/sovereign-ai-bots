import { describe, expect, it } from "vitest";

import {
  applyInventoryListing,
  buildKeySpace,
  buildLedgerKey,
  createLedger,
  flagDay,
  INVENTORY_GAP_MS,
  inventoriedDayOf,
  isInFlightState,
  isOutcomeState,
  isUnaccountedState,
  isVerdictState,
  LEDGER_RETENTION_DAYS,
  localDay,
  type MailLedger,
  markOutageAffected,
  nextLocalDay,
  normalizeLedger,
  noteBelowWatermark,
  noteSearchTruncated,
  OUTCOME_STATES,
  parseLedgerKey,
  pendingGraceMs,
  pruneLedger,
  recordedDayOf,
  recordInventoryUnavailable,
  recordOutcome,
  resolveOverduePending,
  resolveStuckReviewRetries,
} from "./ledger.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Noon UTC keeps the local calendar day equal to the UTC date in every
// timezone between UTC-11 and UTC+11, so day math here is runner-independent.
const NOON = new Date("2026-10-19T12:00:00.000Z");
const at = (offsetMs: number): Date => new Date(NOON.getTime() + offsetMs);
const KS = "imap:7";
const key = (uid: number, keySpace = KS): string => buildLedgerKey(keySpace, uid);
const WINDOW = { searchWindowMs: 25 * HOUR_MS };

/** A ledger whose inventory has already taken its baseline through `throughUid`. */
const withBaseline = (throughUid: number, now: Date = NOON): MailLedger => {
  const ledger = createLedger();
  applyInventoryListing(
    ledger,
    { keySpace: KS, fullCensus: true, uidRanges: throughUid > 0 ? [[1, throughUid]] : [] },
    now,
    WINDOW,
  );
  return ledger;
};

describe("ledger/ledger > state predicates", () => {
  it("knows every outcome state and nothing else", () => {
    for (const state of OUTCOME_STATES) {
      expect(isOutcomeState(state)).toBe(true);
    }
    expect(isOutcomeState("blue")).toBe(false);
    expect(isOutcomeState(3)).toBe(false);
  });

  it("classifies verdict, in-flight and unaccounted states", () => {
    expect(isVerdictState("red")).toBe(true);
    expect(isVerdictState("amber")).toBe(true);
    expect(isVerdictState("gray")).toBe(true);
    expect(isVerdictState("pending")).toBe(false);
    expect(isInFlightState("pending")).toBe(true);
    expect(isInFlightState("deferred")).toBe(true);
    expect(isInFlightState("red")).toBe(false);
    expect(isUnaccountedState("no-verdict:refused")).toBe(true);
    expect(isUnaccountedState("too-large")).toBe(true);
    expect(isUnaccountedState("gray")).toBe(false);
    expect(isUnaccountedState(undefined)).toBe(false);
  });
});

describe("ledger/ledger > keys and days", () => {
  it("builds key spaces and keys and parses them back", () => {
    expect(buildKeySpace("imap", "7")).toBe("imap:7");
    expect(buildKeySpace("imap", undefined)).toBe("imap:-");
    expect(buildLedgerKey("pop3:ab12:3", 42)).toBe("pop3:ab12:3:42");
    expect(parseLedgerKey("pop3:ab12:3:42")).toEqual({ keySpace: "pop3:ab12:3", uid: 42 });
  });

  it("rejects keys without a key space or a numeric identifier", () => {
    expect(parseLedgerKey("42")).toBeUndefined();
    expect(parseLedgerKey(":42")).toBeUndefined();
    expect(parseLedgerKey("imap:7:abc")).toBeUndefined();
    expect(parseLedgerKey("imap:7:-1")).toBeUndefined();
  });

  it("computes local days and walks them forward", () => {
    const day = localDay(NOON);
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(localDay(NOON.toISOString())).toBe(day);
    expect(nextLocalDay(day)).toBe(localDay(at(DAY_MS)));
    expect(nextLocalDay("2026-12-31")).toBe("2027-01-01");
  });

  it("flags a day once per flag", () => {
    const ledger = createLedger();
    flagDay(ledger, "2026-10-19", "coverage-break");
    flagDay(ledger, "2026-10-19", "coverage-break");
    flagDay(ledger, "2026-10-19", "search-truncated");
    expect(ledger.days["2026-10-19"]).toEqual({
      recorded: 0,
      inventoried: 0,
      inventoryRuns: 0,
      flags: ["coverage-break", "search-truncated"],
    });
  });

  it("reports the day an entry counts on", () => {
    const ledger = createLedger();
    recordOutcome(ledger, key(1), { state: "gray" }, NOON);
    const entry = ledger.entries[key(1)];
    expect(entry && recordedDayOf(entry)).toBe(localDay(NOON));
    expect(entry && inventoriedDayOf(entry)).toBeUndefined();
  });
});

describe("ledger/ledger > recordOutcome", () => {
  it("creates an entry, counts it on its day and reports the creation", () => {
    const ledger = createLedger();
    const created = recordOutcome(
      ledger,
      key(5),
      { state: "read-failed", reason: "timeout" },
      NOON,
      { attempt: true, outageAffected: true },
    );
    expect(created).toBe(true);
    expect(ledger.entries[key(5)]).toEqual({
      key: key(5),
      firstSeenAt: NOON.toISOString(),
      state: "read-failed",
      reason: "timeout",
      review: undefined,
      attempts: 1,
      updatedAt: NOON.toISOString(),
      scannedAt: NOON.toISOString(),
      outageAffected: true,
    });
    expect(ledger.days[localDay(NOON)]?.recorded).toBe(1);
  });

  it("moves an existing entry to its new state without recounting it", () => {
    const ledger = createLedger();
    recordOutcome(ledger, key(5), { state: "read-failed", reason: "other" }, NOON, {
      attempt: true,
    });
    const created = recordOutcome(
      ledger,
      key(5),
      { state: "red", review: "reviewer" },
      at(HOUR_MS),
      { attempt: true, outageAffected: true },
    );
    expect(created).toBe(false);
    const entry = ledger.entries[key(5)];
    expect(entry?.state).toBe("red");
    expect(entry?.reason).toBeUndefined();
    expect(entry?.review).toBe("reviewer");
    expect(entry?.attempts).toBe(2);
    expect(entry?.firstSeenAt).toBe(NOON.toISOString());
    expect(entry?.scannedAt).toBe(NOON.toISOString());
    expect(entry?.updatedAt).toBe(at(HOUR_MS).toISOString());
    // The overlay applies at creation only.
    expect(entry?.outageAffected).toBeUndefined();
    expect(ledger.days[localDay(NOON)]?.recorded).toBe(1);
  });

  it("counts no attempt when none was made", () => {
    const ledger = createLedger();
    recordOutcome(ledger, key(9), { state: "deferred" }, NOON);
    expect(ledger.entries[key(9)]?.attempts).toBe(0);
  });
});

describe("ledger/ledger > search notes", () => {
  it("notes a pending, never-scanned entry seen below the watermark", () => {
    const ledger = withBaseline(10);
    applyInventoryListing(
      ledger,
      { keySpace: KS, fullCensus: false, uidRanges: [[11, 12]] },
      NOON,
      WINDOW,
    );
    recordOutcome(ledger, key(12), { state: "pending" }, NOON);
    recordOutcome(ledger, key(20), { state: "gray" }, NOON);
    noteBelowWatermark(ledger, key(11));
    noteBelowWatermark(ledger, key(12));
    noteBelowWatermark(ledger, key(20));
    noteBelowWatermark(ledger, key(99));
    expect(ledger.entries[key(11)]?.reason).toBe("below-watermark");
    expect(ledger.entries[key(12)]?.reason).toBeUndefined();
    expect(ledger.entries[key(20)]?.reason).toBeUndefined();
  });

  it("marks pending entries older than everything a truncated search returned", () => {
    const ledger = withBaseline(10);
    applyInventoryListing(
      ledger,
      { keySpace: KS, fullCensus: false, uidRanges: [[11, 14]] },
      NOON,
      WINDOW,
    );
    recordOutcome(ledger, key(12), { state: "pending" }, NOON);
    recordOutcome(ledger, key(13), { state: "gray" }, NOON);
    for (const odd of ["imap:8:2", "odd"]) {
      ledger.entries[odd] = {
        key: odd,
        firstSeenAt: NOON.toISOString(),
        state: "pending",
        attempts: 0,
        updatedAt: NOON.toISOString(),
      };
    }
    noteSearchTruncated(ledger, KS, 14, NOON);
    expect(ledger.entries[key(11)]?.reason).toBe("truncated");
    expect(ledger.entries[key(12)]?.reason).toBeUndefined();
    expect(ledger.entries[key(13)]?.reason).toBeUndefined();
    expect(ledger.entries[key(14)]?.reason).toBeUndefined();
    expect(ledger.entries["imap:8:2"]?.reason).toBeUndefined();
    expect(ledger.entries.odd?.reason).toBeUndefined();
    expect(ledger.days[localDay(NOON)]?.flags).toEqual(["search-truncated"]);
  });
});

describe("ledger/ledger > applyInventoryListing", () => {
  it("takes the first run as the baseline and creates no entries", () => {
    const ledger = createLedger();
    const created = applyInventoryListing(
      ledger,
      {
        keySpace: KS,
        fullCensus: true,
        uidRanges: [
          [1, 3],
          [7, 9],
        ],
      },
      NOON,
      WINDOW,
    );
    expect(created).toEqual([]);
    expect(ledger.entries).toEqual({});
    expect(ledger.inventory).toEqual({
      status: "available",
      lastAttemptAt: NOON.toISOString(),
      lastSuccessAt: NOON.toISOString(),
      cursor: { keySpace: KS, afterUid: 9 },
      baseline: { keySpace: KS, throughUid: 9 },
    });
    expect(ledger.days[localDay(NOON)]).toEqual({ recorded: 0, inventoried: 0, inventoryRuns: 1 });
  });

  it("flags the day when the scan recorded mail before the first baseline", () => {
    const ledger = createLedger();
    recordOutcome(ledger, key(4), { state: "gray", review: "rules-only" }, at(-HOUR_MS));
    applyInventoryListing(
      ledger,
      { keySpace: KS, fullCensus: true, uidRanges: [[1, 4]] },
      NOON,
      WINDOW,
    );
    expect(ledger.days[localDay(NOON)]?.flags).toEqual(["coverage-break"]);
    expect(ledger.inventory.baseline).toEqual({ keySpace: KS, throughUid: 4 });
  });

  it("baselines an empty mailbox at zero", () => {
    const ledger = withBaseline(0);
    expect(ledger.inventory.cursor).toEqual({ keySpace: KS, afterUid: 0 });
  });

  it("lists arrivals above the cursor as pending and advances the cursor", () => {
    const ledger = withBaseline(10);
    const created = applyInventoryListing(
      ledger,
      {
        keySpace: KS,
        fullCensus: false,
        uidRanges: [
          [8, 12],
          [15, 15],
        ],
      },
      at(HOUR_MS),
      { searchWindowMs: 25 * HOUR_MS, outageAffected: true },
    );
    expect(created).toEqual([key(11), key(12), key(15)]);
    expect(ledger.entries[key(11)]).toEqual({
      key: key(11),
      firstSeenAt: at(HOUR_MS).toISOString(),
      state: "pending",
      attempts: 0,
      updatedAt: at(HOUR_MS).toISOString(),
      inventoriedAt: at(HOUR_MS).toISOString(),
      outageAffected: true,
    });
    expect(ledger.inventory.cursor).toEqual({ keySpace: KS, afterUid: 15 });
    expect(ledger.days[localDay(NOON)]).toMatchObject({
      recorded: 3,
      inventoried: 3,
      inventoryRuns: 2,
    });
  });

  it("never moves the cursor backwards", () => {
    const ledger = withBaseline(10);
    applyInventoryListing(ledger, { keySpace: KS, fullCensus: false, uidRanges: [] }, NOON, WINDOW);
    expect(ledger.inventory.cursor?.afterUid).toBe(10);
  });

  it("stamps a scan-created entry once and keeps its state", () => {
    const ledger = withBaseline(10);
    recordOutcome(ledger, key(11), { state: "red", review: "reviewer" }, NOON);
    applyInventoryListing(
      ledger,
      { keySpace: KS, fullCensus: false, uidRanges: [[11, 11]] },
      at(HOUR_MS),
      WINDOW,
    );
    // A re-listing of an already-inventoried identifier is not counted twice.
    ledger.inventory.cursor = { keySpace: KS, afterUid: 10 };
    applyInventoryListing(
      ledger,
      { keySpace: KS, fullCensus: false, uidRanges: [[11, 11]] },
      at(2 * HOUR_MS),
      WINDOW,
    );
    expect(ledger.entries[key(11)]?.state).toBe("red");
    expect(ledger.entries[key(11)]?.inventoriedAt).toBe(at(HOUR_MS).toISOString());
    expect(ledger.days[localDay(NOON)]).toMatchObject({ recorded: 1, inventoried: 1 });
  });

  it("notes the tool's own baseline flag and arrivals that may predate the search window", () => {
    const ledger = withBaseline(10);
    applyInventoryListing(
      ledger,
      { keySpace: KS, fullCensus: true, uidRanges: [[11, 12]], baselineUids: [11] },
      at(30 * HOUR_MS),
      WINDOW,
    );
    expect(ledger.entries[key(11)]?.reason).toBe("baseline");
    expect(ledger.entries[key(12)]?.reason).toBe("outside-window");
  });

  it("flags every day of an inventory gap longer than a day", () => {
    const ledger = withBaseline(10);
    applyInventoryListing(
      ledger,
      { keySpace: KS, fullCensus: false, uidRanges: [] },
      at(INVENTORY_GAP_MS + 2 * DAY_MS),
      WINDOW,
    );
    for (const offset of [0, DAY_MS, 2 * DAY_MS, 3 * DAY_MS]) {
      expect(ledger.days[localDay(at(offset))]?.flags).toEqual(["inventory-gap"]);
    }
  });

  it("does not flag a short pause as a gap", () => {
    const ledger = withBaseline(10);
    applyInventoryListing(
      ledger,
      { keySpace: KS, fullCensus: false, uidRanges: [] },
      at(HOUR_MS),
      WINDOW,
    );
    expect(ledger.days[localDay(NOON)]?.flags).toBeUndefined();
  });

  it("re-baselines on a key space change when the run was a full census", () => {
    const ledger = withBaseline(10);
    applyInventoryListing(
      ledger,
      { keySpace: "imap:8", fullCensus: true, uidRanges: [[1, 4]] },
      at(HOUR_MS),
      WINDOW,
    );
    expect(ledger.days[localDay(NOON)]?.flags).toEqual(["coverage-break"]);
    expect(ledger.inventory.cursor).toEqual({ keySpace: "imap:8", afterUid: 4 });
    expect(ledger.inventory.baseline).toEqual({ keySpace: "imap:8", throughUid: 4 });
    expect(ledger.entries).toEqual({});
  });

  it("drops the cursor on a key space change when the run was bounded", () => {
    const ledger = withBaseline(10);
    applyInventoryListing(
      ledger,
      { keySpace: "imap:8", fullCensus: false, uidRanges: [[11, 12]] },
      at(HOUR_MS),
      WINDOW,
    );
    expect(ledger.inventory.cursor).toBeUndefined();
    expect(ledger.inventory.baseline).toBeUndefined();
    expect(ledger.entries).toEqual({});
  });

  it("adds UID gaps from incremental runs only", () => {
    const ledger = createLedger();
    applyInventoryListing(
      ledger,
      { keySpace: KS, fullCensus: true, uidRanges: [[1, 9]], uidGaps: 4 },
      NOON,
      WINDOW,
    );
    applyInventoryListing(
      ledger,
      { keySpace: KS, fullCensus: true, uidRanges: [], uidGaps: 4 },
      NOON,
      WINDOW,
    );
    applyInventoryListing(
      ledger,
      { keySpace: KS, fullCensus: false, uidRanges: [], uidGaps: 0 },
      NOON,
      WINDOW,
    );
    expect(ledger.days[localDay(NOON)]?.uidGaps).toBeUndefined();
    applyInventoryListing(
      ledger,
      { keySpace: KS, fullCensus: false, uidRanges: [], uidGaps: 2 },
      NOON,
      WINDOW,
    );
    applyInventoryListing(
      ledger,
      { keySpace: KS, fullCensus: false, uidRanges: [], uidGaps: 3 },
      NOON,
      WINDOW,
    );
    expect(ledger.days[localDay(NOON)]?.uidGaps).toBe(5);
  });

  it("treats a cursor without a recorded success as not predating the window", () => {
    const ledger = normalizeLedger({ inventory: { cursor: { keySpace: KS, afterUid: 3 } } });
    applyInventoryListing(
      ledger,
      { keySpace: KS, fullCensus: false, uidRanges: [[4, 4]] },
      NOON,
      WINDOW,
    );
    expect(ledger.entries[key(4)]?.reason).toBeUndefined();
  });

  it("records an unavailable inventory", () => {
    const ledger = createLedger();
    recordInventoryUnavailable(ledger, "unsupported", NOON);
    expect(ledger.inventory).toEqual({ status: "unsupported", lastAttemptAt: NOON.toISOString() });
  });
});

describe("ledger/ledger > overdue, outage and retention", () => {
  it("resolves pending entries past the grace period as not returned", () => {
    const grace = pendingGraceMs(30 * 60 * 1000);
    expect(grace).toBe(70 * 60 * 1000);
    const ledger = withBaseline(10);
    applyInventoryListing(
      ledger,
      { keySpace: KS, fullCensus: false, uidRanges: [[11, 13]] },
      NOON,
      WINDOW,
    );
    noteBelowWatermark(ledger, key(11));
    recordOutcome(ledger, key(12), { state: "pending" }, NOON);
    recordOutcome(ledger, key(20), { state: "pending" }, NOON);
    resolveOverduePending(ledger, at(grace), grace);
    expect(ledger.entries[key(13)]?.state).toBe("pending");
    resolveOverduePending(ledger, at(grace + 1), grace);
    expect(ledger.entries[key(11)]).toMatchObject({
      state: "not-returned",
      reason: "below-watermark",
      updatedAt: at(grace + 1).toISOString(),
    });
    expect(ledger.entries[key(13)]?.state).toBe("not-returned");
    // Returned by a search, or never inventoried: not this rule's business.
    expect(ledger.entries[key(12)]?.state).toBe("pending");
    expect(ledger.entries[key(20)]?.state).toBe("pending");
  });

  it("marks only existing entries as outage-affected", () => {
    const ledger = createLedger();
    recordOutcome(ledger, key(1), { state: "no-verdict:reviewer-unavailable" }, NOON);
    markOutageAffected(ledger, [key(1), key(2)]);
    expect(ledger.entries[key(1)]?.outageAffected).toBe(true);
    expect(ledger.entries[key(2)]).toBeUndefined();
  });

  it("drops days, notice records and entries older than the retention window", () => {
    const ledger = createLedger();
    const old = at(-(LEDGER_RETENTION_DAYS + 2) * DAY_MS);
    const recent = at(-DAY_MS);
    recordOutcome(ledger, key(1), { state: "gray" }, old);
    recordOutcome(ledger, key(2), { state: "gray" }, recent);
    // Recorded long ago, inventoried recently: kept for its inventoried day.
    recordOutcome(ledger, key(3), { state: "gray" }, old);
    (ledger.entries[key(3)] as { inventoriedAt?: string }).inventoriedAt = recent.toISOString();
    ledger.notice.reported[localDay(old)] = 1;
    ledger.notice.reported[localDay(recent)] = 2;
    pruneLedger(ledger, NOON);
    expect(Object.keys(ledger.entries).sort()).toEqual([key(2), key(3)]);
    expect(Object.keys(ledger.days)).toEqual([localDay(recent)]);
    expect(ledger.notice.reported).toEqual({ [localDay(recent)]: 2 });
  });
});

describe("ledger/ledger > stuck review retries", () => {
  it("finalizes a review retry older than its window as retries-exhausted, and nothing else", () => {
    const ledger = createLedger();
    const maxAge = 12 * HOUR_MS + 30 * 60 * 1000;
    recordOutcome(ledger, key(1), { state: "deferred", reason: "review-retry" }, NOON);
    recordOutcome(ledger, key(2), { state: "deferred", reason: "review-retry" }, at(HOUR_MS));
    // Unread mail deferred by the time budget is re-read, not swept.
    recordOutcome(ledger, key(3), { state: "deferred" }, NOON);
    recordOutcome(ledger, key(4), { state: "amber", review: "reviewer" }, NOON);
    resolveStuckReviewRetries(ledger, at(maxAge), maxAge);
    expect(ledger.entries[key(1)]?.state).toBe("deferred");
    resolveStuckReviewRetries(ledger, at(maxAge + 1), maxAge);
    expect(ledger.entries[key(1)]).toMatchObject({
      state: "no-verdict:reviewer-unavailable",
      reason: "retries-exhausted",
      updatedAt: at(maxAge + 1).toISOString(),
    });
    expect(ledger.entries[key(2)]).toMatchObject({ state: "deferred", reason: "review-retry" });
    expect(ledger.entries[key(3)]).toMatchObject({ state: "deferred" });
    expect(ledger.entries[key(4)]).toMatchObject({ state: "amber" });
  });

  it("measures the age from the first scan that acted on the message", () => {
    const ledger = withBaseline(10);
    applyInventoryListing(
      ledger,
      { keySpace: KS, fullCensus: false, uidRanges: [[11, 11]] },
      at(-DAY_MS),
      WINDOW,
    );
    recordOutcome(ledger, key(11), { state: "deferred", reason: "review-retry" }, NOON);
    resolveStuckReviewRetries(ledger, at(HOUR_MS), 12 * HOUR_MS);
    expect(ledger.entries[key(11)]?.state).toBe("deferred");
  });
});

describe("ledger/ledger > normalizeLedger", () => {
  it("returns an empty ledger for anything that is not an object", () => {
    expect(normalizeLedger(null)).toEqual(createLedger());
    expect(normalizeLedger([])).toEqual(createLedger());
    expect(normalizeLedger({ entries: [], days: 3, inventory: "x", notice: null })).toEqual(
      createLedger(),
    );
  });

  it("keeps well-formed entries, defaults missing fields and drops malformed ones", () => {
    const ledger = normalizeLedger({
      entries: {
        a: {
          firstSeenAt: "2026-10-19T10:00:00.000Z",
          state: "read-failed",
          reason: "timeout",
          review: "reviewer",
          attempts: 2,
          updatedAt: "2026-10-19T11:00:00.000Z",
          inventoriedAt: "2026-10-19T10:00:00.000Z",
          scannedAt: "2026-10-19T10:30:00.000Z",
          outageAffected: true,
        },
        b: {
          firstSeenAt: "2026-10-19T10:00:00.000Z",
          state: "made-up",
          review: "bogus",
          attempts: -1,
          outageAffected: "yes",
        },
        c: "nope",
        d: { state: "red" },
      },
    });
    expect(ledger.entries).toEqual({
      a: {
        key: "a",
        firstSeenAt: "2026-10-19T10:00:00.000Z",
        state: "read-failed",
        reason: "timeout",
        review: "reviewer",
        attempts: 2,
        updatedAt: "2026-10-19T11:00:00.000Z",
        inventoriedAt: "2026-10-19T10:00:00.000Z",
        scannedAt: "2026-10-19T10:30:00.000Z",
        outageAffected: true,
      },
      // The unknown state survives: it must show up as a residual.
      b: {
        key: "b",
        firstSeenAt: "2026-10-19T10:00:00.000Z",
        state: "made-up",
        attempts: 0,
        updatedAt: "2026-10-19T10:00:00.000Z",
      },
    });
  });

  it("coerces day counters and keeps only known flags", () => {
    const ledger = normalizeLedger({
      days: {
        "2026-10-18": {
          recorded: 3,
          inventoried: 2,
          inventoryRuns: 1,
          uidGaps: 4,
          flags: ["inventory-gap", "bogus", 7],
        },
        "2026-10-19": { recorded: "x", flags: "inventory-gap" },
        "2026-10-20": null,
      },
    });
    expect(ledger.days).toEqual({
      "2026-10-18": {
        recorded: 3,
        inventoried: 2,
        inventoryRuns: 1,
        uidGaps: 4,
        flags: ["inventory-gap"],
      },
      "2026-10-19": { recorded: 0, inventoried: 0, inventoryRuns: 0 },
    });
  });

  it("restores the inventory state and rejects malformed marks", () => {
    expect(
      normalizeLedger({
        inventory: {
          status: "failed",
          lastAttemptAt: "a",
          lastSuccessAt: "b",
          cursor: { keySpace: KS, afterUid: 9 },
          baseline: { keySpace: KS, throughUid: 0 },
        },
      }).inventory,
    ).toEqual({
      status: "failed",
      lastAttemptAt: "a",
      lastSuccessAt: "b",
      cursor: { keySpace: KS, afterUid: 9 },
      baseline: { keySpace: KS, throughUid: 0 },
    });
    for (const cursor of [
      "x",
      { keySpace: 3, afterUid: 1 },
      { keySpace: KS, afterUid: -1 },
      { keySpace: KS, afterUid: 1.5 },
      { keySpace: KS, afterUid: "1" },
    ]) {
      expect(
        normalizeLedger({ inventory: { status: 4, cursor, baseline: cursor } }).inventory,
      ).toEqual({
        status: "unknown",
      });
    }
    expect(normalizeLedger({ inventory: { status: "sideways" } }).inventory.status).toBe("unknown");
  });

  it("restores the notice record", () => {
    expect(
      normalizeLedger({
        notice: { reported: { "2026-10-19": 3, "2026-10-18": "x" }, lastSentDay: "2026-10-19" },
      }).notice,
    ).toEqual({ reported: { "2026-10-19": 3, "2026-10-18": 0 }, lastSentDay: "2026-10-19" });
    expect(normalizeLedger({ notice: { reported: [] } }).notice).toEqual({ reported: {} });
  });
});
