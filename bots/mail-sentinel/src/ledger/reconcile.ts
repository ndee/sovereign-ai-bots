import {
  type DayFlag,
  INVENTORY_GAP_MS,
  type InventoryStatus,
  inventoriedDayOf,
  isInFlightState,
  isOutcomeState,
  isUnaccountedState,
  isVerdictState,
  type LedgerEntry,
  localDay,
  type MailLedger,
  NO_VERDICT_STATES,
  nextLocalDay,
  OUTCOME_STATES,
  type OutcomeState,
  parseLedgerKey,
  recordedDayOf,
} from "./ledger.js";

/**
 * `full` when the independent mailbox inventory ran, so the equation balances
 * against identifiers the scan's search path did not produce. `partial` when
 * only the scan's own records exist: mail the search never returned cannot be
 * seen at all.
 */
export type Coverage = "full" | "partial";

export interface OutcomeGroups {
  verdict: number;
  noVerdict: number;
  notProcessed: number;
  inFlight: number;
}

export interface DayReconciliation extends OutcomeGroups {
  day: string;
  coverage: Coverage;
  /** The independent count the outcomes must add up to. */
  expected: number;
  outcomes: Record<OutcomeState, number>;
  /**
   * Non-zero outcome counts with the sub-cause folded into the name where one
   * is known (`read-failed:timeout`, `not-returned:truncated`).
   */
  detailedOutcomes: Record<string, number>;
  accounted: number;
  /** `expected - accounted`. Anything but 0 is a reconciliation defect. */
  residual: number;
  /** No verdict, or never processed: messages to check by hand. */
  unaccounted: number;
  /** Seen by a scan but never listed by the inventory (full coverage only). */
  scanOnly: number;
  outageAffected: number;
  flags: DayFlag[];
}

export interface ReconcileTotals extends OutcomeGroups {
  expected: number;
  outcomes: Record<OutcomeState, number>;
  accounted: number;
  residual: number;
  unaccounted: number;
  scanOnly: number;
  outageAffected: number;
}

export interface ReconcileReport {
  generatedAt: string;
  coverage: Coverage;
  inventory: { status: InventoryStatus; lastSuccessAt?: string };
  /** Newest first. */
  days: DayReconciliation[];
  /** Sums of the per-day figures shown. */
  totals: ReconcileTotals;
}

const zeroOutcomes = (): Record<OutcomeState, number> =>
  Object.fromEntries(OUTCOME_STATES.map((state) => [state, 0])) as Record<OutcomeState, number>;

const NO_VERDICT_STATE_SET = new Set<string>(NO_VERDICT_STATES);

const detailedStateName = (entry: LedgerEntry): string =>
  (entry.state === "read-failed" || entry.state === "not-returned") && entry.reason !== undefined
    ? `${entry.state}:${entry.reason}`
    : entry.state;

const isBaselineEntry = (ledger: MailLedger, entry: LedgerEntry): boolean => {
  const baseline = ledger.inventory.baseline;
  const parsed = parseLedgerKey(entry.key);
  return (
    baseline !== undefined &&
    parsed !== undefined &&
    parsed.keySpace === baseline.keySpace &&
    parsed.uid <= baseline.throughUid
  );
};

/** Days covered by an inventory outage that has not ended yet. */
const openInventoryGapDays = (ledger: MailLedger, now: Date): Set<string> => {
  const days = new Set<string>();
  const { status, lastSuccessAt } = ledger.inventory;
  if (
    (status === "available" || status === "failed") &&
    lastSuccessAt !== undefined &&
    now.getTime() - new Date(lastSuccessAt).getTime() > INVENTORY_GAP_MS
  ) {
    const today = localDay(now);
    for (let day = localDay(lastSuccessAt); day <= today; day = nextLocalDay(day)) {
      days.add(day);
    }
  }
  return days;
};

const groupOutcomes = (outcomes: Record<OutcomeState, number>): OutcomeGroups => {
  const groups: OutcomeGroups = { verdict: 0, noVerdict: 0, notProcessed: 0, inFlight: 0 };
  for (const state of OUTCOME_STATES) {
    const count = outcomes[state];
    if (isVerdictState(state)) groups.verdict += count;
    else if (NO_VERDICT_STATE_SET.has(state)) groups.noVerdict += count;
    else if (isInFlightState(state)) groups.inFlight += count;
    else groups.notProcessed += count;
  }
  return groups;
};

const reconcileDay = (
  ledger: MailLedger,
  day: string,
  gapDays: ReadonlySet<string>,
): DayReconciliation => {
  const counters = ledger.days[day];
  const coverage: Coverage = (counters?.inventoryRuns ?? 0) > 0 ? "full" : "partial";
  const outcomes = zeroOutcomes();
  const detailedOutcomes: Record<string, number> = {};
  let accounted = 0;
  let scanOnly = 0;
  let outageAffected = 0;
  for (const entry of Object.values(ledger.entries)) {
    const member =
      coverage === "full" ? inventoriedDayOf(entry) === day : recordedDayOf(entry) === day;
    if (!member) {
      if (
        coverage === "full" &&
        entry.inventoriedAt === undefined &&
        recordedDayOf(entry) === day &&
        !isBaselineEntry(ledger, entry)
      ) {
        scanOnly += 1;
      }
      continue;
    }
    if (entry.outageAffected === true) {
      outageAffected += 1;
    }
    // An unknown state is left out of `accounted` on purpose, so it shows up
    // in the residual rather than vanishing.
    if (isOutcomeState(entry.state)) {
      outcomes[entry.state] += 1;
      const detailed = detailedStateName(entry);
      detailedOutcomes[detailed] = (detailedOutcomes[detailed] ?? 0) + 1;
      accounted += 1;
    }
  }
  const expected = coverage === "full" ? (counters?.inventoried ?? 0) : (counters?.recorded ?? 0);
  const groups = groupOutcomes(outcomes);
  const flags = [...(counters?.flags ?? [])];
  if (gapDays.has(day) && !flags.includes("inventory-gap")) {
    flags.push("inventory-gap");
  }
  return {
    day,
    coverage,
    expected,
    outcomes,
    detailedOutcomes,
    ...groups,
    accounted,
    residual: expected - accounted,
    unaccounted: groups.noVerdict + groups.notProcessed,
    scanOnly,
    outageAffected,
    flags,
  };
};

export interface ReconcileOptions {
  /** Most recent days to report; all retained days when omitted. */
  days?: number | undefined;
}

export const reconcileLedger = (
  ledger: MailLedger,
  now: Date,
  options: ReconcileOptions = {},
): ReconcileReport => {
  const gapDays = openInventoryGapDays(ledger, now);
  const daySet = new Set<string>([...Object.keys(ledger.days), ...gapDays]);
  for (const entry of Object.values(ledger.entries)) {
    daySet.add(recordedDayOf(entry));
    const inventoriedDay = inventoriedDayOf(entry);
    if (inventoriedDay !== undefined) {
      daySet.add(inventoriedDay);
    }
  }
  const sortedDays = [...daySet].sort((left, right) => right.localeCompare(left));
  const selected = options.days === undefined ? sortedDays : sortedDays.slice(0, options.days);
  const days = selected.map((day) => reconcileDay(ledger, day, gapDays));
  const totals: ReconcileTotals = {
    expected: 0,
    outcomes: zeroOutcomes(),
    verdict: 0,
    noVerdict: 0,
    notProcessed: 0,
    inFlight: 0,
    accounted: 0,
    residual: 0,
    unaccounted: 0,
    scanOnly: 0,
    outageAffected: 0,
  };
  for (const day of days) {
    totals.expected += day.expected;
    for (const state of OUTCOME_STATES) {
      totals.outcomes[state] += day.outcomes[state];
    }
    totals.verdict += day.verdict;
    totals.noVerdict += day.noVerdict;
    totals.notProcessed += day.notProcessed;
    totals.inFlight += day.inFlight;
    totals.accounted += day.accounted;
    totals.residual += day.residual;
    totals.unaccounted += day.unaccounted;
    totals.scanOnly += day.scanOnly;
    totals.outageAffected += day.outageAffected;
  }
  const { status, lastSuccessAt } = ledger.inventory;
  return {
    generatedAt: now.toISOString(),
    coverage: status === "available" ? "full" : "partial",
    inventory: { status, ...(lastSuccessAt === undefined ? {} : { lastSuccessAt }) },
    days,
    totals,
  };
};

/**
 * Per-day counts persisted in the state file under `integrity`, for status
 * surfaces and diagnostics collectors. Recomputed from the ledger on every
 * write, never accumulated, so a restart cannot skew it. Counts only.
 */
export interface IntegrityDay {
  coverage: Coverage;
  /**
   * The count the day's outcomes balance against: the inventory's count on a
   * `full` day, the ledger's own record count on a `partial` one.
   */
  inventory: number;
  states: Record<string, number>;
  residual?: number;
  unaccounted?: number;
  inFlight?: number;
  outageAffected?: number;
  seenNotInventoried?: number;
  uidGaps?: number;
  flags?: DayFlag[];
}

export interface IntegrityBlock {
  version: 1;
  updatedAt: string;
  coverage: Coverage;
  inventory: InventoryStatus;
  residual: number;
  unaccounted: number;
  inFlight: number;
  days: Record<string, IntegrityDay>;
}

const nonZero = <K extends string>(key: K, value: number): Partial<Record<K, number>> =>
  value === 0 ? {} : ({ [key]: value } as Partial<Record<K, number>>);

export const summarizeIntegrity = (ledger: MailLedger, now: Date): IntegrityBlock => {
  const report = reconcileLedger(ledger, now);
  return {
    version: 1,
    updatedAt: report.generatedAt,
    coverage: report.coverage,
    inventory: report.inventory.status,
    residual: report.totals.residual,
    unaccounted: report.totals.unaccounted,
    inFlight: report.totals.inFlight,
    days: Object.fromEntries(
      report.days.map((day) => [
        day.day,
        {
          coverage: day.coverage,
          inventory: day.expected,
          states: day.detailedOutcomes,
          ...nonZero("residual", day.residual),
          ...nonZero("unaccounted", day.unaccounted),
          ...nonZero("inFlight", day.inFlight),
          ...nonZero("outageAffected", day.outageAffected),
          ...nonZero("seenNotInventoried", day.scanOnly),
          ...nonZero("uidGaps", ledger.days[day.day]?.uidGaps ?? 0),
          ...(day.flags.length === 0 ? {} : { flags: day.flags }),
        },
      ]),
    ),
  };
};

const plural = (count: number, word: string): string =>
  `${String(count)} ${word}${count === 1 ? "" : "s"}`;

/**
 * The one calm line the digest carries: how many messages arrived since the
 * previous digest and how many of them were actually checked.
 */
export const buildCoverageLine = (
  ledger: MailLedger,
  since: string | undefined,
  now: Date,
): string => {
  const sinceMs = since === undefined ? Number.NEGATIVE_INFINITY : new Date(since).getTime();
  let total = 0;
  let checked = 0;
  let unaccounted = 0;
  let inFlight = 0;
  for (const entry of Object.values(ledger.entries)) {
    if (new Date(entry.firstSeenAt).getTime() < sinceMs || isBaselineEntry(ledger, entry)) {
      continue;
    }
    total += 1;
    if (isVerdictState(entry.state)) checked += 1;
    else if (isUnaccountedState(entry.state)) unaccounted += 1;
    else if (isInFlightState(entry.state)) inFlight += 1;
  }
  const parts = [`${plural(total, "mail")}`, `${String(checked)} checked`];
  if (unaccounted > 0) {
    parts.push(`${String(unaccounted)} not checked (ask "integrity")`);
  }
  if (inFlight > 0) {
    parts.push(`${String(inFlight)} in progress`);
  }
  const report = reconcileLedger(ledger, now);
  const residual = report.days.some(
    (day) => day.residual !== 0 && (since === undefined || day.day >= localDay(since)),
  );
  return [
    `Since the last digest: ${parts.join(", ")}.`,
    ...(residual ? ['Mail counts do not balance (ask "reconcile").'] : []),
    ...(report.coverage === "partial" ? ["Coverage: partial."] : []),
  ].join(" ");
};
