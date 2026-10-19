import type { MailSentinelRuntime } from "../config/runtime.js";
import {
  applyInventoryListing,
  buildKeySpace,
  type InventoryContext,
  type InventoryListing,
  type MailLedger,
  recordInventoryUnavailable,
} from "./ledger.js";

/**
 * The independent inventory comes from the mail tool's `mail-inventory`
 * command, which lists message identifiers outside the scan's search path (no
 * result limit, no watermark, no lookback window). Older tool builds do not
 * have it; the command parser then rejects it by name, and coverage is
 * reported as partial instead of failing anything.
 */
const UNSUPPORTED_COMMAND_PATTERN = /unknown command/iu;

export type InventoryOutcome =
  | { kind: "listed"; listing: InventoryListing; created: string[] }
  | { kind: "unsupported" }
  | { kind: "failed"; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isUid = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const readRanges = (value: unknown): Array<[number, number]> | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const ranges: Array<[number, number]> = [];
  for (const range of value) {
    if (Array.isArray(range) && isUid(range[0]) && isUid(range[1]) && range[0] <= range[1]) {
      ranges.push([range[0], range[1]]);
    }
  }
  return ranges.sort((left, right) => left[0] - right[0]);
};

/**
 * Map the tool's result onto a listing. IMAP reports UID ranges; POP3 reports
 * every UIDL, of which only those the POP3 index has given a uid share an
 * identifier with the scan. The others are picked up once a search indexes
 * them, and the UIDL hashes themselves are never kept.
 */
export const parseInventoryResult = (
  raw: unknown,
  fallbackProtocol: string,
): InventoryListing | undefined => {
  if (!isRecord(raw)) {
    return undefined;
  }
  const protocol = typeof raw.protocol === "string" ? raw.protocol : fallbackProtocol;
  const uidValidity = typeof raw.uidValidity === "string" ? raw.uidValidity : undefined;
  const keySpace = buildKeySpace(protocol, uidValidity);
  if (Array.isArray(raw.messages)) {
    const uids: number[] = [];
    const baselineUids: number[] = [];
    for (const message of raw.messages) {
      if (isRecord(message) && isUid(message.uid)) {
        uids.push(message.uid);
        if (message.baseline === true) {
          baselineUids.push(message.uid);
        }
      }
    }
    uids.sort((left, right) => left - right);
    return {
      keySpace,
      fullCensus: true,
      uidRanges: uids.map((uid) => [uid, uid] as const),
      baselineUids,
    };
  }
  const uidRanges = readRanges(raw.uidRanges);
  if (uidRanges === undefined) {
    return undefined;
  }
  return {
    keySpace,
    fullCensus: raw.afterUid === 0 || raw.afterUid === undefined || raw.uidValidityChanged === true,
    uidRanges,
    ...(typeof raw.uidGaps === "number" && raw.uidGaps > 0 ? { uidGaps: raw.uidGaps } : {}),
  };
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The UIDVALIDITY part of a `<protocol>:<uidValidity>` key space. */
const uidValidityOf = (keySpace: string): string | undefined => {
  const value = keySpace.slice(keySpace.indexOf(":") + 1);
  return value === "-" ? undefined : value;
};

export const runInventory = async (
  runtime: Pick<MailSentinelRuntime, "inventoryMail" | "mailProtocol">,
  ledger: MailLedger,
): Promise<InventoryOutcome> => {
  // The tool refuses `--after-uid` without the UIDVALIDITY it belongs to, and
  // POP3 always lists everything; both then get a full listing, which the
  // ledger filters against its own cursor.
  const cursor = ledger.inventory.cursor;
  const uidValidity = cursor === undefined ? undefined : uidValidityOf(cursor.keySpace);
  let raw: unknown;
  try {
    raw = await runtime.inventoryMail(
      cursor === undefined || uidValidity === undefined || runtime.mailProtocol === "pop3"
        ? {}
        : { afterUid: cursor.afterUid, uidValidity },
    );
  } catch (error) {
    const message = describeError(error);
    return UNSUPPORTED_COMMAND_PATTERN.test(message)
      ? { kind: "unsupported" }
      : { kind: "failed", message };
  }
  const listing = parseInventoryResult(raw, runtime.mailProtocol);
  return listing === undefined
    ? { kind: "failed", message: "mail-inventory returned no identifier listing" }
    : { kind: "listed", listing, created: [] };
};

/** Run the inventory and fold the result into the ledger. Never throws. */
export const takeInventory = async (
  runtime: Pick<MailSentinelRuntime, "inventoryMail" | "mailProtocol">,
  ledger: MailLedger,
  now: Date,
  context: InventoryContext,
): Promise<InventoryOutcome> => {
  const outcome = await runInventory(runtime, ledger);
  if (outcome.kind === "listed") {
    outcome.created = applyInventoryListing(ledger, outcome.listing, now, context);
  } else {
    recordInventoryUnavailable(ledger, outcome.kind, now);
  }
  return outcome;
};
