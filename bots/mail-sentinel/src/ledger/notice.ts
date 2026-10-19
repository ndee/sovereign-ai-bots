import type { MailSentinelRuntime } from "../config/runtime.js";
import { localDay, type MailLedger } from "./ledger.js";
import { type DayReconciliation, reconcileLedger } from "./reconcile.js";

/**
 * At most one notice per day when messages are unaccounted for.
 *
 * Built from counts alone: no identifier, subject or sender reaches the text,
 * so it is safe in a shared room and in screenshots. Which messages they were
 * is answered by the `integrity` command in the operator's own room. Delivery
 * is recorded only after Matrix accepts the message, so a failed send stays
 * queued and goes out with the next scan.
 */

/** Days older than this never trigger a notice; they are history, not news. */
export const NOTICE_LOOKBACK_DAYS = 7;

export interface UnaccountedNotice {
  body: string;
  formattedBody: string;
  /** Unaccounted-plus-defect count per included day, recorded once delivered. */
  reported: Record<string, number>;
}

const noticeWeight = (day: DayReconciliation): number => day.unaccounted + Math.abs(day.residual);

const plural = (count: number, word: string): string =>
  `${String(count)} ${word}${count === 1 ? "" : "s"}`;

const describeDays = (days: readonly string[], today: string): string => {
  const sorted = [...days].sort();
  if (sorted.length === 1) {
    return sorted[0] === today ? "today" : `on ${sorted[0] as string}`;
  }
  return `between ${sorted[0] as string} and ${sorted[sorted.length - 1] as string}`;
};

export const buildUnaccountedNotice = (
  ledger: MailLedger,
  now: Date,
): UnaccountedNotice | undefined => {
  const today = localDay(now);
  if (ledger.notice.lastSentDay === today) {
    return undefined;
  }
  const cutoff = localDay(new Date(now.getTime() - NOTICE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000));
  const included = reconcileLedger(ledger, now).days.filter(
    (day) => day.day >= cutoff && noticeWeight(day) > (ledger.notice.reported[day.day] ?? 0),
  );
  if (included.length === 0) {
    return undefined;
  }
  let notRead = 0;
  let tooLarge = 0;
  let notReturned = 0;
  let noVerdict = 0;
  let residual = 0;
  for (const day of included) {
    notRead += day.outcomes["read-failed"];
    tooLarge += day.outcomes["too-large"];
    notReturned += day.outcomes["not-returned"];
    noVerdict += day.noVerdict;
    residual += Math.abs(day.residual);
  }
  const when = describeDays(
    included.map((day) => day.day),
    today,
  );
  const unaccounted = notRead + tooLarge + notReturned + noVerdict;
  const parts = [
    ...(notRead > 0 ? [`${String(notRead)} could not be read`] : []),
    ...(tooLarge > 0 ? [`${String(tooLarge)} too large to read`] : []),
    ...(notReturned > 0 ? [`${String(notReturned)} never reached the scan`] : []),
    ...(noVerdict > 0 ? [`${String(noVerdict)} got no review verdict`] : []),
  ];
  const sentences = [
    ...(unaccounted > 0
      ? [
          `Mail Sentinel: ${plural(unaccounted, "message")} received ${when} could not be checked: ${parts.join(", ")}.`,
          'Check them in your mail client, or ask "integrity" for details.',
        ]
      : []),
    ...(residual > 0
      ? [
          `Mail Sentinel: the message counts for mail received ${when} do not balance (difference ${String(residual)}). Ask "reconcile" for details.`,
        ]
      : []),
  ];
  const [headline, ...rest] = sentences as [string, ...string[]];
  return {
    body: sentences.join(" "),
    formattedBody: [`<b>${headline}</b>`, ...rest].join(" "),
    reported: Object.fromEntries(included.map((day) => [day.day, noticeWeight(day)])),
  };
};

/** Send the day's notice if one is due. Never throws; the caller writes the ledger. */
export const announceUnaccountedIfDue = async (
  runtime: Pick<MailSentinelRuntime, "sendMatrixRoomMessage">,
  ledger: MailLedger,
  now: Date,
): Promise<boolean> => {
  const notice = buildUnaccountedNotice(ledger, now);
  if (notice === undefined) {
    return false;
  }
  try {
    await runtime.sendMatrixRoomMessage({ body: notice.body, formattedBody: notice.formattedBody });
  } catch {
    return false;
  }
  Object.assign(ledger.notice.reported, notice.reported);
  ledger.notice.lastSentDay = localDay(now);
  return true;
};
