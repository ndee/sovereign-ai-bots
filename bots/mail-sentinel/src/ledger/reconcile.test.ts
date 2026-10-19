import { describe, expect, it } from "vitest";

import {
  applyInventoryListing,
  buildLedgerKey,
  createLedger,
  flagDay,
  isOutcomeState,
  localDay,
  type MailLedger,
  markOutageAffected,
  normalizeLedger,
  noteBelowWatermark,
  noteSearchTruncated,
  OUTCOME_STATES,
  type OutcomeState,
  pendingGraceMs,
  pruneLedger,
  recordInventoryUnavailable,
  recordOutcome,
  resolveOverduePending,
} from "./ledger.js";
import { buildCoverageLine, reconcileLedger, summarizeIntegrity } from "./reconcile.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOON = new Date("2026-10-19T12:00:00.000Z");
const at = (offsetMs: number): Date => new Date(NOON.getTime() + offsetMs);
const TODAY = localDay(NOON);
const KS = "imap:7";
const key = (uid: number, keySpace = KS): string => buildLedgerKey(keySpace, uid);
const WINDOW = { searchWindowMs: 25 * HOUR_MS };

/** Inventory baselined through uid 10, then uids 11..10+n listed as arrivals. */
const fullLedger = (arrivals: number): MailLedger => {
  const ledger = createLedger();
  applyInventoryListing(
    ledger,
    { keySpace: KS, fullCensus: true, uidRanges: [[1, 10]] },
    NOON,
    WINDOW,
  );
  if (arrivals > 0) {
    applyInventoryListing(
      ledger,
      { keySpace: KS, fullCensus: false, uidRanges: [[11, 10 + arrivals]] },
      NOON,
      WINDOW,
    );
  }
  return ledger;
};

describe("ledger/reconcile > reconcileLedger", () => {
  it("reports an empty ledger as partial with nothing to balance", () => {
    const report = reconcileLedger(createLedger(), NOON);
    expect(report).toMatchObject({
      generatedAt: NOON.toISOString(),
      coverage: "partial",
      inventory: { status: "unknown" },
      days: [],
    });
    expect(report.totals.residual).toBe(0);
  });

  it("balances a partial day against the ledger's own record count", () => {
    const ledger = createLedger();
    recordOutcome(ledger, key(1), { state: "red", review: "reviewer" }, NOON);
    recordOutcome(ledger, key(2), { state: "no-verdict:reviewer-unavailable" }, NOON, {
      outageAffected: true,
    });
    recordOutcome(ledger, key(3), { state: "read-failed", reason: "timeout" }, NOON);
    recordOutcome(ledger, key(4), { state: "too-large" }, NOON);
    recordOutcome(ledger, key(5), { state: "deferred" }, NOON);
    recordInventoryUnavailable(ledger, "unsupported", NOON);
    const report = reconcileLedger(ledger, NOON);
    expect(report.coverage).toBe("partial");
    expect(report.inventory).toEqual({ status: "unsupported" });
    expect(report.days).toHaveLength(1);
    const [day] = report.days;
    expect(day).toMatchObject({
      day: TODAY,
      coverage: "partial",
      expected: 5,
      accounted: 5,
      residual: 0,
      verdict: 1,
      noVerdict: 1,
      notProcessed: 2,
      inFlight: 1,
      unaccounted: 3,
      scanOnly: 0,
      outageAffected: 1,
      flags: [],
      detailedOutcomes: {
        red: 1,
        "no-verdict:reviewer-unavailable": 1,
        "read-failed:timeout": 1,
        "too-large": 1,
        deferred: 1,
      },
    });
    expect(report.totals).toMatchObject({ expected: 5, accounted: 5, residual: 0, unaccounted: 3 });
  });

  it("balances a full day against the inventory and lists scan-only mail separately", () => {
    const ledger = fullLedger(3);
    recordOutcome(ledger, key(11), { state: "gray", review: "rules-only" }, NOON);
    recordOutcome(ledger, key(12), { state: "not-returned", reason: "truncated" }, NOON);
    // Seen by a scan but never inventoried: outside the equation.
    recordOutcome(ledger, key(40), { state: "amber", review: "reviewer" }, NOON);
    // Within the baseline: neither in the equation nor scan-only.
    recordOutcome(ledger, key(5), { state: "gray" }, NOON);
    // Another key space, unparseable key: scan-only.
    recordOutcome(ledger, key(2, "imap:8"), { state: "gray" }, NOON);
    recordOutcome(ledger, "odd", { state: "gray" }, NOON);
    const report = reconcileLedger(ledger, NOON);
    expect(report.coverage).toBe("full");
    expect(report.inventory.lastSuccessAt).toBe(NOON.toISOString());
    const [day] = report.days;
    expect(day).toMatchObject({
      coverage: "full",
      expected: 3,
      accounted: 3,
      residual: 0,
      scanOnly: 3,
      verdict: 1,
      notProcessed: 1,
      inFlight: 1,
      detailedOutcomes: { gray: 1, "not-returned:truncated": 1, pending: 1 },
    });
  });

  it("names sub-causes only where a state carries one", () => {
    const ledger = createLedger();
    recordOutcome(ledger, key(1), { state: "not-returned" }, NOON);
    recordOutcome(ledger, key(2), { state: "gray", reason: "ignored" }, NOON);
    expect(reconcileLedger(ledger, NOON).days[0]?.detailedOutcomes).toEqual({
      "not-returned": 1,
      gray: 1,
    });
  });

  it("orders days newest first, limits them and sums the totals", () => {
    const ledger = createLedger();
    recordOutcome(ledger, key(1), { state: "gray" }, at(-2 * DAY_MS));
    recordOutcome(ledger, key(2), { state: "red" }, at(-DAY_MS));
    recordOutcome(ledger, key(3), { state: "amber" }, NOON);
    const all = reconcileLedger(ledger, NOON);
    expect(all.days.map((day) => day.day)).toEqual([
      TODAY,
      localDay(at(-DAY_MS)),
      localDay(at(-2 * DAY_MS)),
    ]);
    expect(all.totals).toMatchObject({ expected: 3, verdict: 3 });
    expect(all.totals.outcomes).toMatchObject({ gray: 1, red: 1, amber: 1 });
    const recent = reconcileLedger(ledger, NOON, { days: 2 });
    expect(recent.days).toHaveLength(2);
    expect(recent.totals.expected).toBe(2);
  });

  it("flags the days of an inventory outage that has not ended yet", () => {
    const ledger = fullLedger(0);
    flagDay(ledger, TODAY, "inventory-gap");
    recordInventoryUnavailable(ledger, "failed", at(2 * DAY_MS));
    const report = reconcileLedger(ledger, at(2 * DAY_MS));
    expect(report.coverage).toBe("partial");
    expect(report.days.map((day) => [day.day, day.flags])).toEqual([
      [localDay(at(2 * DAY_MS)), ["inventory-gap"]],
      [localDay(at(DAY_MS)), ["inventory-gap"]],
      [TODAY, ["inventory-gap"]],
    ]);
    // Still available but silent for too long: the same open gap.
    ledger.inventory.status = "available";
    expect(reconcileLedger(ledger, at(2 * DAY_MS)).days).toHaveLength(3);
  });

  it("does not report a gap for a short pause, an unsupported tool or no success yet", () => {
    const ledger = fullLedger(0);
    expect(reconcileLedger(ledger, at(HOUR_MS)).days[0]?.flags).toEqual([]);
    recordInventoryUnavailable(ledger, "unsupported", at(3 * DAY_MS));
    expect(reconcileLedger(ledger, at(3 * DAY_MS)).days).toHaveLength(1);
    const never = createLedger();
    recordInventoryUnavailable(never, "failed", NOON);
    expect(reconcileLedger(never, at(3 * DAY_MS)).days).toEqual([]);
  });
});

describe("ledger/reconcile > deliberate discrepancies", () => {
  it("shows a deleted entry as residual 1 on its day", () => {
    const ledger = fullLedger(3);
    delete ledger.entries[key(12)];
    const report = reconcileLedger(ledger, NOON);
    expect(report.days[0]?.residual).toBe(1);
    expect(report.totals.residual).toBe(1);
  });

  it("shows a fabricated inventoried entry as residual -1", () => {
    const ledger = fullLedger(3);
    ledger.entries[key(99)] = {
      key: key(99),
      firstSeenAt: NOON.toISOString(),
      state: "gray",
      attempts: 0,
      updatedAt: NOON.toISOString(),
      inventoriedAt: NOON.toISOString(),
    };
    expect(reconcileLedger(ledger, NOON).days[0]?.residual).toBe(-1);
  });

  it("keeps an entry with an unknown state and counts it as residual 1", () => {
    const ledger = createLedger();
    recordOutcome(ledger, key(1), { state: "gray" }, NOON);
    recordOutcome(ledger, key(2), { state: "gray" }, NOON);
    const raw = JSON.parse(JSON.stringify(ledger)) as {
      entries: Record<string, { state: string }>;
    };
    (raw.entries[key(2)] as { state: string }).state = "lost-in-space";
    const restored = normalizeLedger(raw);
    expect(restored.entries[key(2)]).toBeDefined();
    const [day] = reconcileLedger(restored, NOON).days;
    expect(day).toMatchObject({ expected: 2, accounted: 1, residual: 1 });
  });

  it("shows entries whose day counters vanished as a negative residual", () => {
    const ledger = createLedger();
    recordOutcome(ledger, key(1), { state: "gray" }, NOON);
    delete ledger.days[TODAY];
    expect(reconcileLedger(ledger, NOON).days[0]).toMatchObject({ expected: 0, residual: -1 });
  });
});

describe("ledger/reconcile > summarizeIntegrity", () => {
  it("emits counts only, keyed by day, omitting zero fields", () => {
    const ledger = fullLedger(2);
    recordOutcome(ledger, key(11), { state: "read-failed", reason: "other" }, NOON);
    recordOutcome(ledger, key(40), { state: "gray" }, NOON);
    markOutageAffected(ledger, [key(11)]);
    applyInventoryListing(
      ledger,
      { keySpace: KS, fullCensus: false, uidRanges: [], uidGaps: 2 },
      NOON,
      WINDOW,
    );
    flagDay(ledger, TODAY, "search-truncated");
    recordOutcome(ledger, key(1), { state: "gray" }, at(-DAY_MS));
    const block = summarizeIntegrity(ledger, NOON);
    expect(block).toEqual({
      version: 1,
      updatedAt: NOON.toISOString(),
      coverage: "full",
      inventory: "available",
      residual: 0,
      unaccounted: 1,
      inFlight: 1,
      days: {
        [TODAY]: {
          coverage: "full",
          inventory: 2,
          states: { "read-failed:other": 1, pending: 1 },
          unaccounted: 1,
          inFlight: 1,
          outageAffected: 1,
          seenNotInventoried: 1,
          uidGaps: 2,
          flags: ["search-truncated"],
        },
        [localDay(at(-DAY_MS))]: { coverage: "partial", inventory: 1, states: { gray: 1 } },
      },
    });
  });

  it("carries a residual into the block", () => {
    const ledger = fullLedger(1);
    delete ledger.entries[key(11)];
    const block = summarizeIntegrity(ledger, NOON);
    expect(block.residual).toBe(1);
    expect(block.days[TODAY]?.residual).toBe(1);
  });
});

describe("ledger/reconcile > buildCoverageLine", () => {
  it("says calmly that everything was checked", () => {
    const ledger = fullLedger(0);
    recordOutcome(ledger, key(11), { state: "gray" }, NOON);
    expect(buildCoverageLine(ledger, undefined, NOON)).toBe(
      "Since the last digest: 1 mail, 1 checked.",
    );
  });

  it("counts only mail since the last digest, outside the baseline", () => {
    const ledger = createLedger();
    recordOutcome(ledger, key(1), { state: "red" }, at(-2 * DAY_MS));
    recordOutcome(ledger, key(2), { state: "gray" }, NOON);
    recordOutcome(ledger, key(3), { state: "too-large" }, NOON);
    recordOutcome(ledger, key(4), { state: "no-verdict:defaulted" }, NOON);
    recordOutcome(ledger, key(5), { state: "deferred" }, NOON);
    expect(buildCoverageLine(ledger, at(-DAY_MS).toISOString(), NOON)).toBe(
      'Since the last digest: 4 mails, 1 checked, 2 not checked (ask "integrity"), 1 in progress. Coverage: partial.',
    );
  });

  it("skips baseline mail and names an unbalanced day since the last digest", () => {
    const ledger = fullLedger(1);
    recordOutcome(ledger, key(3), { state: "gray" }, NOON);
    delete ledger.entries[key(11)];
    expect(buildCoverageLine(ledger, at(-HOUR_MS).toISOString(), NOON)).toBe(
      'Since the last digest: 0 mails, 0 checked. Mail counts do not balance (ask "reconcile").',
    );
    expect(buildCoverageLine(ledger, undefined, NOON)).toContain("do not balance");
  });

  it("ignores an unbalanced day older than the last digest", () => {
    const ledger = createLedger();
    recordOutcome(ledger, key(1), { state: "gray" }, at(-3 * DAY_MS));
    delete ledger.days[localDay(at(-3 * DAY_MS))];
    recordOutcome(ledger, key(2), { state: "gray" }, NOON);
    expect(buildCoverageLine(ledger, at(-HOUR_MS).toISOString(), NOON)).toBe(
      "Since the last digest: 1 mail, 1 checked. Coverage: partial.",
    );
  });
});

/** Small seeded PRNG (mulberry32) so a failing sequence is reproducible. */
const prng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** The first broken invariant, or undefined. Plain checks: this runs thousands of times. */
const findViolation = (ledger: MailLedger, now: Date): string | undefined => {
  const keys = Object.keys(ledger.entries);
  if (new Set(keys).size !== keys.length) {
    return "duplicate key";
  }
  for (const [entryKey, entry] of Object.entries(ledger.entries)) {
    if (entry.key !== entryKey || !isOutcomeState(entry.state)) {
      return `${entryKey} -> ${String(entry.state)}`;
    }
  }
  const report = reconcileLedger(ledger, now);
  for (const day of report.days) {
    const summed = OUTCOME_STATES.reduce((sum, state) => sum + day.outcomes[state], 0);
    if (day.residual !== 0 || day.accounted !== summed) {
      return `residual ${String(day.residual)} on ${day.day}`;
    }
  }
  if (report.totals.residual !== 0) {
    return "total residual";
  }
  // Restart safety: counts come back identical from the persisted ledger.
  const restored = normalizeLedger(JSON.parse(JSON.stringify(ledger)));
  if (JSON.stringify(reconcileLedger(restored, now)) !== JSON.stringify(report)) {
    return "report changed across a restart";
  }
  return undefined;
};

/**
 * Random sequences of every ledger operation under a fake clock; after each
 * step every key has exactly one known state, every day balances to residual
 * 0, and a JSON round trip (a restart) reproduces the report exactly.
 */
const runPropertySequences = (sequences: number, steps: number, spanLimitMs: number): void => {
  const grace = pendingGraceMs(30 * 60 * 1000);
  for (let seed = 1; seed <= sequences; seed += 1) {
    const random = prng(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const ledger = createLedger();
    let clock = NOON.getTime();
    let keySpace = KS;
    let nextUid = 1 + Math.floor(random() * 20);
    for (let step = 0; step < steps; step += 1) {
      // Mostly minutes to hours; now and then a multi-day outage.
      clock = Math.min(
        clock +
          (random() < 0.1
            ? Math.floor(random() * 10 * DAY_MS)
            : Math.floor(random() * 6 * HOUR_MS)),
        NOON.getTime() + spanLimitMs,
      );
      const now = new Date(clock);
      const operation = random();
      if (operation < 0.25) {
        if (random() < 0.03) {
          keySpace = keySpace === KS ? "imap:8" : KS;
        }
        const count = Math.floor(random() * 5);
        const ranges: Array<[number, number]> = [];
        let start = Math.max(1, nextUid - Math.floor(random() * 3));
        for (let index = 0; index < count; index += 1) {
          const end = start + Math.floor(random() * 3);
          ranges.push([start, end]);
          start = end + 1 + Math.floor(random() * 2);
        }
        nextUid = Math.max(nextUid, start);
        applyInventoryListing(
          ledger,
          {
            keySpace,
            fullCensus: random() < 0.2,
            uidRanges: ranges,
            baselineUids: random() < 0.2 ? [nextUid - 1] : undefined,
            uidGaps: Math.floor(random() * 2),
          },
          now,
          { searchWindowMs: 25 * HOUR_MS, outageAffected: random() < 0.2 },
        );
      } else if (operation < 0.3) {
        recordInventoryUnavailable(ledger, pick(["unsupported", "failed"] as const), now);
      } else if (operation < 0.65) {
        const uid = Math.max(1, nextUid - Math.floor(random() * 15));
        recordOutcome(
          ledger,
          buildLedgerKey(keySpace, uid),
          {
            state: pick(OUTCOME_STATES) as OutcomeState,
            reason: random() < 0.5 ? "timeout" : undefined,
          },
          now,
          { attempt: random() < 0.5, outageAffected: random() < 0.2 },
        );
        nextUid = Math.max(nextUid, uid + 1);
      } else if (operation < 0.72) {
        noteBelowWatermark(
          ledger,
          buildLedgerKey(keySpace, Math.max(1, nextUid - Math.floor(random() * 10))),
        );
      } else if (operation < 0.78) {
        noteSearchTruncated(
          ledger,
          keySpace,
          Math.max(1, nextUid - Math.floor(random() * 10)),
          now,
        );
      } else if (operation < 0.88) {
        resolveOverduePending(ledger, now, grace);
      } else if (operation < 0.94) {
        markOutageAffected(
          ledger,
          Object.keys(ledger.entries).filter(() => random() < 0.3),
        );
      } else {
        pruneLedger(ledger, now);
      }
      const violation = findViolation(ledger, now);
      if (violation !== undefined) {
        expect.fail(`seed ${String(seed)} step ${String(step)}: ${violation}`);
      }
    }
  }
};

describe("ledger/reconcile > property: one key, one state, residual 0", () => {
  it("holds over random operation sequences within the retention window", {
    timeout: 60_000,
  }, () => {
    runPropertySequences(100, 80, 40 * DAY_MS);
  });

  // KNOWN DEFECT: pruneLedger drops a day's counters while an entry first
  // recorded that day survives (it was inventoried on a later, retained day),
  // so the pruned day reappears with residual -1. Flip to `it` once fixed.
  it("holds when sequences run past the retention window", { timeout: 60_000 }, () => {
    runPropertySequences(100, 80, 400 * DAY_MS);
  });

  it("keeps a pruned entry's recorded day balanced (deterministic repro)", () => {
    const ledger = createLedger();
    const recorded = at(-46 * DAY_MS);
    recordOutcome(ledger, key(30), { state: "red", review: "reviewer" }, recorded);
    applyInventoryListing(
      ledger,
      { keySpace: KS, fullCensus: true, uidRanges: [[1, 29]] },
      recorded,
      WINDOW,
    );
    ledger.inventory.cursor = { keySpace: KS, afterUid: 29 };
    applyInventoryListing(
      ledger,
      { keySpace: KS, fullCensus: false, uidRanges: [[30, 30]] },
      at(-44 * DAY_MS),
      WINDOW,
    );
    pruneLedger(ledger, NOON);
    expect(ledger.entries[key(30)]).toBeDefined();
    expect(reconcileLedger(ledger, NOON).totals.residual).toBe(0);
  });
});
