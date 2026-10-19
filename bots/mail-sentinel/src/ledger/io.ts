import { dirname, resolve as resolvePath } from "node:path";

import { readJsonFile, writeJsonFile } from "../state/io.js";
import { createLedger, flagDay, localDay, type MailLedger, normalizeLedger } from "./ledger.js";

/** Sits beside the state file, which carries mail content and so can never be exported. */
export const LEDGER_FILENAME = "mail-sentinel-ledger.json";

export const ledgerPathFor = (statePath: string): string =>
  resolvePath(dirname(statePath), LEDGER_FILENAME);

/**
 * An unreadable ledger must not stop a scan. It restarts empty, and the day is
 * flagged so the lost history shows up in every report instead of silently
 * reading as a quiet mailbox.
 */
export const readLedgerFile = async (path: string, now: Date): Promise<MailLedger> => {
  try {
    return normalizeLedger(await readJsonFile<unknown>(path, null));
  } catch {
    const ledger = createLedger();
    flagDay(ledger, localDay(now), "ledger-reset");
    return ledger;
  }
};

/** Atomic (temp file + rename); callers hold the state lock. */
export const writeLedgerFile = async (path: string, ledger: MailLedger): Promise<void> => {
  await writeJsonFile(path, ledger);
};
