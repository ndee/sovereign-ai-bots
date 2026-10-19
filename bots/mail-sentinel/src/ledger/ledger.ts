/**
 * Content-free per-message outcome ledger.
 *
 * The state file cannot answer "was every message actually checked?": it keeps
 * mail content (subject, sender, snippet) and only per-scan counters, so a
 * message that failed to read, was too large, or never got a review verdict
 * leaves at most one warning in one scan's output. The ledger records exactly
 * one outcome state per message identifier and nothing else — no subject,
 * sender, recipient, Message-ID or body — so its counts can be shown and
 * exported without exposing mail.
 *
 * Everything here is a pure function over a `MailLedger` value with an
 * injected clock. Reading and writing the file lives in `./io.ts`.
 */

export const VERDICT_STATES = ["red", "amber", "gray"] as const;
export const NO_VERDICT_STATES = [
  "no-verdict:reviewer-unavailable",
  "no-verdict:refused",
  "no-verdict:defaulted",
] as const;
export const NOT_PROCESSED_STATES = ["read-failed", "too-large", "not-returned"] as const;
export const IN_FLIGHT_STATES = ["pending", "deferred"] as const;

export type VerdictState = (typeof VERDICT_STATES)[number];
export type NoVerdictState = (typeof NO_VERDICT_STATES)[number];
export type NotProcessedState = (typeof NOT_PROCESSED_STATES)[number];
export type InFlightState = (typeof IN_FLIGHT_STATES)[number];
export type OutcomeState = VerdictState | NoVerdictState | NotProcessedState | InFlightState;

/** Every outcome state, in the order reports list them. */
export const OUTCOME_STATES: readonly OutcomeState[] = [
  ...VERDICT_STATES,
  ...NO_VERDICT_STATES,
  ...NOT_PROCESSED_STATES,
  ...IN_FLIGHT_STATES,
];

const OUTCOME_STATE_SET = new Set<string>(OUTCOME_STATES);
const UNACCOUNTED_STATE_SET = new Set<string>([...NO_VERDICT_STATES, ...NOT_PROCESSED_STATES]);

export const isOutcomeState = (value: unknown): value is OutcomeState =>
  typeof value === "string" && OUTCOME_STATE_SET.has(value);

export const isVerdictState = (value: unknown): value is VerdictState =>
  value === "red" || value === "amber" || value === "gray";

export const isInFlightState = (value: unknown): value is InFlightState =>
  value === "pending" || value === "deferred";

/** No verdict and not processed: the messages an operator has to check by hand. */
export const isUnaccountedState = (value: unknown): boolean =>
  typeof value === "string" && UNACCOUNTED_STATE_SET.has(value);

/**
 * How a verdict was reached. `duplicate` is a message whose Message-ID was
 * already handled under another identifier, so it inherits that outcome.
 */
export type ReviewType = "reviewer" | "rules-only" | "policy-skipped" | "duplicate";

export interface LedgerEntry {
  key: string;
  firstSeenAt: string;
  state: OutcomeState;
  /**
   * Sub-cause of the state (`timeout` / `other` for `read-failed`; `truncated`,
   * `baseline`, `outside-window`, `below-watermark` for `not-returned`). On a
   * `pending` entry it holds the cause that applies if the entry is never
   * returned by a search.
   */
  reason?: string | undefined;
  review?: ReviewType | undefined;
  /** Read or review attempts the scan made for this message. */
  attempts: number;
  updatedAt: string;
  /** When the independent inventory first listed this identifier. */
  inventoriedAt?: string | undefined;
  /** When a scan search first returned this identifier and acted on it. */
  scannedAt?: string | undefined;
  /** First seen while mail retrieval or classification was degraded. */
  outageAffected?: true | undefined;
}

export type DayFlag = "inventory-gap" | "coverage-break" | "search-truncated" | "ledger-reset";

export interface LedgerDay {
  /** Identifiers first recorded on this day, by any source. */
  recorded: number;
  /** Identifiers the independent inventory first listed on this day. */
  inventoried: number;
  /** Successful inventory runs on this day; non-zero means full coverage. */
  inventoryRuns: number;
  /** UID gaps newly found inside incremental inventory ranges (informational). */
  uidGaps?: number | undefined;
  flags?: DayFlag[] | undefined;
}

export type InventoryStatus = "unknown" | "available" | "unsupported" | "failed";

export interface LedgerInventoryState {
  status: InventoryStatus;
  lastAttemptAt?: string | undefined;
  lastSuccessAt?: string | undefined;
  /** Highest identifier listed so far, per key space; the next run starts after it. */
  cursor?: { keySpace: string; afterUid: number } | undefined;
  /** Identifiers that already existed when the inventory first ran in a key space. */
  baseline?: { keySpace: string; throughUid: number } | undefined;
}

export interface LedgerNoticeState {
  /** Per day, the unaccounted count the last delivered notice covered. */
  reported: Record<string, number>;
  lastSentDay?: string | undefined;
}

export interface MailLedger {
  version: 1;
  entries: Record<string, LedgerEntry>;
  days: Record<string, LedgerDay>;
  inventory: LedgerInventoryState;
  notice: LedgerNoticeState;
}

export const LEDGER_RETENTION_DAYS = 45;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A span with no successful inventory longer than this is an inventory gap. */
export const INVENTORY_GAP_MS = DAY_MS;

export const createLedger = (): MailLedger => ({
  version: 1,
  entries: {},
  days: {},
  inventory: { status: "unknown" },
  notice: { reported: {} },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

const readOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const DAY_FLAGS = new Set<string>([
  "inventory-gap",
  "coverage-break",
  "search-truncated",
  "ledger-reset",
]);
const REVIEW_TYPES = new Set<string>(["reviewer", "rules-only", "policy-skipped", "duplicate"]);
const INVENTORY_STATUSES = new Set<string>(["unknown", "available", "unsupported", "failed"]);

const readKeySpaceMark = (
  value: unknown,
  field: "afterUid" | "throughUid",
): { keySpace: string; uid: number } | undefined => {
  if (!isRecord(value) || typeof value.keySpace !== "string") {
    return undefined;
  }
  const uid = value[field];
  return typeof uid === "number" && Number.isInteger(uid) && uid >= 0
    ? { keySpace: value.keySpace, uid }
    : undefined;
};

/**
 * Coerce a persisted ledger. Entries are kept even when their state is not a
 * known outcome: such an entry is a reconciliation defect, and dropping it here
 * would hide it instead of surfacing it as a non-zero residual.
 */
export const normalizeLedger = (raw: unknown): MailLedger => {
  const ledger = createLedger();
  if (!isRecord(raw)) {
    return ledger;
  }
  if (isRecord(raw.entries)) {
    for (const [key, value] of Object.entries(raw.entries)) {
      if (!isRecord(value) || typeof value.firstSeenAt !== "string") {
        continue;
      }
      const entry: LedgerEntry = {
        key,
        firstSeenAt: value.firstSeenAt,
        state: value.state as OutcomeState,
        attempts: readCount(value.attempts),
        updatedAt: readOptionalString(value.updatedAt) ?? value.firstSeenAt,
      };
      const reason = readOptionalString(value.reason);
      if (reason !== undefined) entry.reason = reason;
      if (typeof value.review === "string" && REVIEW_TYPES.has(value.review)) {
        entry.review = value.review as ReviewType;
      }
      const inventoriedAt = readOptionalString(value.inventoriedAt);
      if (inventoriedAt !== undefined) entry.inventoriedAt = inventoriedAt;
      const scannedAt = readOptionalString(value.scannedAt);
      if (scannedAt !== undefined) entry.scannedAt = scannedAt;
      if (value.outageAffected === true) entry.outageAffected = true;
      ledger.entries[key] = entry;
    }
  }
  if (isRecord(raw.days)) {
    for (const [day, value] of Object.entries(raw.days)) {
      if (!isRecord(value)) {
        continue;
      }
      const flags = Array.isArray(value.flags)
        ? (value.flags.filter(
            (flag) => typeof flag === "string" && DAY_FLAGS.has(flag),
          ) as DayFlag[])
        : [];
      const uidGaps = readCount(value.uidGaps);
      ledger.days[day] = {
        recorded: readCount(value.recorded),
        inventoried: readCount(value.inventoried),
        inventoryRuns: readCount(value.inventoryRuns),
        ...(uidGaps === 0 ? {} : { uidGaps }),
        ...(flags.length === 0 ? {} : { flags }),
      };
    }
  }
  if (isRecord(raw.inventory)) {
    const source = raw.inventory;
    const status = source.status;
    ledger.inventory.status =
      typeof status === "string" && INVENTORY_STATUSES.has(status)
        ? (status as InventoryStatus)
        : "unknown";
    const lastAttemptAt = readOptionalString(source.lastAttemptAt);
    if (lastAttemptAt !== undefined) ledger.inventory.lastAttemptAt = lastAttemptAt;
    const lastSuccessAt = readOptionalString(source.lastSuccessAt);
    if (lastSuccessAt !== undefined) ledger.inventory.lastSuccessAt = lastSuccessAt;
    const cursor = readKeySpaceMark(source.cursor, "afterUid");
    if (cursor !== undefined) {
      ledger.inventory.cursor = { keySpace: cursor.keySpace, afterUid: cursor.uid };
    }
    const baseline = readKeySpaceMark(source.baseline, "throughUid");
    if (baseline !== undefined) {
      ledger.inventory.baseline = { keySpace: baseline.keySpace, throughUid: baseline.uid };
    }
  }
  if (isRecord(raw.notice)) {
    if (isRecord(raw.notice.reported)) {
      for (const [day, count] of Object.entries(raw.notice.reported)) {
        ledger.notice.reported[day] = readCount(count);
      }
    }
    const lastSentDay = readOptionalString(raw.notice.lastSentDay);
    if (lastSentDay !== undefined) ledger.notice.lastSentDay = lastSentDay;
  }
  return ledger;
};

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** Calendar day (`YYYY-MM-DD`) in the device's local time zone. */
export const localDay = (value: string | Date): string => {
  const date = new Date(value);
  return `${String(date.getFullYear())}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
};

/** Day after `day`, in local calendar terms (DST-safe). */
export const nextLocalDay = (day: string): string => {
  const [year, month, date] = day.split("-").map((part) => Number.parseInt(part, 10));
  return localDay(new Date(year as number, (month as number) - 1, (date as number) + 1, 12));
};

/** `<protocol>:<uidValidity>`; identifiers never match across key spaces. */
export const buildKeySpace = (protocol: string, uidValidity: string | undefined): string =>
  `${protocol}:${uidValidity ?? "-"}`;

export const buildLedgerKey = (keySpace: string, uid: number): string =>
  `${keySpace}:${String(uid)}`;

/** Split a ledger key back into its key space and numeric identifier. */
export const parseLedgerKey = (key: string): { keySpace: string; uid: number } | undefined => {
  const index = key.lastIndexOf(":");
  if (index <= 0) {
    return undefined;
  }
  const uid = Number(key.slice(index + 1));
  return Number.isInteger(uid) && uid >= 0 ? { keySpace: key.slice(0, index), uid } : undefined;
};

const ensureDay = (ledger: MailLedger, day: string): LedgerDay => {
  const existing = ledger.days[day];
  if (existing !== undefined) {
    return existing;
  }
  const created: LedgerDay = { recorded: 0, inventoried: 0, inventoryRuns: 0 };
  ledger.days[day] = created;
  return created;
};

export const flagDay = (ledger: MailLedger, day: string, flag: DayFlag): void => {
  const entry = ensureDay(ledger, day);
  const flags = entry.flags ?? [];
  if (!flags.includes(flag)) {
    entry.flags = [...flags, flag];
  }
};

export interface Outcome {
  state: OutcomeState;
  reason?: string | undefined;
  review?: ReviewType | undefined;
}

export interface RecordOutcomeOptions {
  /** The scan made a read or review attempt for this message. */
  attempt?: boolean | undefined;
  /** Set the outage overlay if the entry is created by this call. */
  outageAffected?: boolean | undefined;
}

/**
 * Put `key` into exactly one outcome state, creating the entry if needed.
 * Returns true when the entry was created by this call.
 */
export const recordOutcome = (
  ledger: MailLedger,
  key: string,
  outcome: Outcome,
  now: Date,
  options: RecordOutcomeOptions = {},
): boolean => {
  const at = now.toISOString();
  const existing = ledger.entries[key];
  const entry: LedgerEntry = existing ?? {
    key,
    firstSeenAt: at,
    state: outcome.state,
    attempts: 0,
    updatedAt: at,
  };
  entry.state = outcome.state;
  entry.reason = outcome.reason;
  entry.review = outcome.review;
  entry.updatedAt = at;
  entry.scannedAt ??= at;
  if (options.attempt === true) {
    entry.attempts += 1;
  }
  if (existing === undefined) {
    if (options.outageAffected === true) {
      entry.outageAffected = true;
    }
    ledger.entries[key] = entry;
    ensureDay(ledger, localDay(at)).recorded += 1;
    return true;
  }
  return false;
};

/**
 * A search returned `key` at or below the watermark, so the scan skips it
 * unread. A message the inventory listed but no scan has acted on is noted, so
 * it resolves as `not-returned:below-watermark` instead of an unexplained one.
 */
export const noteBelowWatermark = (ledger: MailLedger, key: string): void => {
  const entry = ledger.entries[key];
  if (entry !== undefined && entry.state === "pending" && entry.scannedAt === undefined) {
    entry.reason = "below-watermark";
  }
};

/**
 * The search matched more messages than it returned, so the oldest were cut.
 * Pending entries older than everything returned are the ones that fell off.
 */
export const noteSearchTruncated = (
  ledger: MailLedger,
  keySpace: string,
  lowestReturnedUid: number,
  now: Date,
): void => {
  flagDay(ledger, localDay(now), "search-truncated");
  for (const entry of Object.values(ledger.entries)) {
    if (entry.state !== "pending" || entry.scannedAt !== undefined) {
      continue;
    }
    const parsed = parseLedgerKey(entry.key);
    if (parsed !== undefined && parsed.keySpace === keySpace && parsed.uid < lowestReturnedUid) {
      entry.reason = "truncated";
    }
  }
};

export interface InventoryListing {
  keySpace: string;
  /**
   * True when the run listed the whole mailbox rather than only identifiers
   * above the cursor it was given; only such a run can serve as a baseline.
   */
  fullCensus: boolean;
  /** Ascending, inclusive identifier ranges. */
  uidRanges: readonly (readonly [number, number])[];
  /** Identifiers the mail tool itself treats as pre-existing (e.g. a POP3 index baseline). */
  baselineUids?: readonly number[] | undefined;
  /** Identifiers inside the listed range that the server no longer holds. */
  uidGaps?: number | undefined;
}

export interface InventoryContext {
  /** How far back the scan's search can still reach. */
  searchWindowMs: number;
  outageAffected?: boolean | undefined;
}

/**
 * Apply one successful inventory run. The first run in a key space lists the
 * mailbox as it already was: that is the baseline and is excluded from every
 * period. Later runs list arrivals; each one not yet in the ledger becomes
 * `pending` until a scan resolves it.
 */
export const applyInventoryListing = (
  ledger: MailLedger,
  listing: InventoryListing,
  now: Date,
  context: InventoryContext,
): string[] => {
  const at = now.toISOString();
  const today = localDay(now);
  const previousSuccessAt = ledger.inventory.lastSuccessAt;
  const highest = listing.uidRanges.reduce((max, [, last]) => Math.max(max, last), 0);
  const cursor = ledger.inventory.cursor;
  const sincePreviousMs =
    previousSuccessAt === undefined
      ? undefined
      : now.getTime() - new Date(previousSuccessAt).getTime();

  if (previousSuccessAt !== undefined && (sincePreviousMs as number) > INVENTORY_GAP_MS) {
    for (let day = localDay(previousSuccessAt); day <= today; day = nextLocalDay(day)) {
      flagDay(ledger, day, "inventory-gap");
    }
  }

  ledger.inventory.status = "available";
  ledger.inventory.lastAttemptAt = at;
  ledger.inventory.lastSuccessAt = at;
  const counters = ensureDay(ledger, today);
  counters.inventoryRuns += 1;

  if (cursor === undefined || cursor.keySpace !== listing.keySpace) {
    // A new key space, or mail the scan already recorded today that predates
    // the baseline: either way today's count carries no clean claim.
    if (cursor !== undefined || counters.recorded > 0) {
      flagDay(ledger, today, "coverage-break");
    }
    if (!listing.fullCensus) {
      // Bounded by another key space's cursor, so it cannot be a baseline.
      // Without a cursor the next run is a full census.
      delete ledger.inventory.cursor;
      delete ledger.inventory.baseline;
      return [];
    }
    ledger.inventory.cursor = { keySpace: listing.keySpace, afterUid: highest };
    ledger.inventory.baseline = { keySpace: listing.keySpace, throughUid: highest };
    return [];
  }

  if (!listing.fullCensus && (listing.uidGaps ?? 0) > 0) {
    counters.uidGaps = (counters.uidGaps ?? 0) + (listing.uidGaps as number);
  }
  // After a long inventory gap, an arrival may predate the search window.
  const mayPredateWindow =
    sincePreviousMs !== undefined && sincePreviousMs > context.searchWindowMs;
  const baselineUids = new Set(listing.baselineUids ?? []);
  const created: string[] = [];
  for (const [first, last] of listing.uidRanges) {
    for (let uid = Math.max(first, cursor.afterUid + 1); uid <= last; uid += 1) {
      const key = buildLedgerKey(listing.keySpace, uid);
      const existing = ledger.entries[key];
      if (existing !== undefined) {
        if (existing.inventoriedAt === undefined) {
          existing.inventoriedAt = at;
          counters.inventoried += 1;
        }
        continue;
      }
      const entry: LedgerEntry = {
        key,
        firstSeenAt: at,
        state: "pending",
        attempts: 0,
        updatedAt: at,
        inventoriedAt: at,
      };
      if (baselineUids.has(uid)) {
        entry.reason = "baseline";
      } else if (mayPredateWindow) {
        entry.reason = "outside-window";
      }
      if (context.outageAffected === true) {
        entry.outageAffected = true;
      }
      ledger.entries[key] = entry;
      created.push(key);
      counters.recorded += 1;
      counters.inventoried += 1;
    }
  }
  ledger.inventory.cursor = {
    keySpace: listing.keySpace,
    afterUid: Math.max(highest, cursor.afterUid),
  };
  return created;
};

export const recordInventoryUnavailable = (
  ledger: MailLedger,
  status: "unsupported" | "failed",
  now: Date,
): void => {
  ledger.inventory.status = status;
  ledger.inventory.lastAttemptAt = now.toISOString();
};

/** Time an inventoried message may stay `pending` before it counts as not returned. */
export const pendingGraceMs = (pollIntervalMs: number): number =>
  2 * pollIntervalMs + 10 * 60 * 1000;

/**
 * Inventoried messages no search returned within the grace period are
 * `not-returned`, keeping the cause noted while they were pending.
 */
export const resolveOverduePending = (ledger: MailLedger, now: Date, graceMs: number): void => {
  const at = now.toISOString();
  for (const entry of Object.values(ledger.entries)) {
    if (
      entry.state === "pending" &&
      entry.scannedAt === undefined &&
      entry.inventoriedAt !== undefined &&
      now.getTime() - new Date(entry.inventoriedAt).getTime() > graceMs
    ) {
      entry.state = "not-returned";
      entry.updatedAt = at;
    }
  }
};

export const markOutageAffected = (ledger: MailLedger, keys: Iterable<string>): void => {
  for (const key of keys) {
    const entry = ledger.entries[key];
    if (entry !== undefined) {
      entry.outageAffected = true;
    }
  }
};

/** The day an entry is counted on in partial coverage: when it was first recorded. */
export const recordedDayOf = (entry: LedgerEntry): string => localDay(entry.firstSeenAt);

/** The day an entry is counted on in full coverage: when the inventory first listed it. */
export const inventoriedDayOf = (entry: LedgerEntry): string | undefined =>
  entry.inventoriedAt === undefined ? undefined : localDay(entry.inventoriedAt);

/** Oldest day still inside the retention window. */
export const retentionCutoffDay = (now: Date): string =>
  localDay(new Date(now.getTime() - LEDGER_RETENTION_DAYS * DAY_MS));

/**
 * Drop everything older than the retention window. Days and entries are cut on
 * the same day boundary, and an entry is kept while any day it counts on is
 * kept, so a retained day's equation never loses one side. An entry kept for a
 * later day may still name a dropped day; reports skip days before the cutoff.
 */
export const pruneLedger = (ledger: MailLedger, now: Date): void => {
  const cutoff = retentionCutoffDay(now);
  for (const day of Object.keys(ledger.days)) {
    if (day < cutoff) {
      delete ledger.days[day];
    }
  }
  for (const day of Object.keys(ledger.notice.reported)) {
    if (day < cutoff) {
      delete ledger.notice.reported[day];
    }
  }
  for (const [key, entry] of Object.entries(ledger.entries)) {
    const inventoriedDay = inventoriedDayOf(entry);
    const keep =
      recordedDayOf(entry) >= cutoff || (inventoriedDay !== undefined && inventoriedDay >= cutoff);
    if (!keep) {
      delete ledger.entries[key];
    }
  }
};
