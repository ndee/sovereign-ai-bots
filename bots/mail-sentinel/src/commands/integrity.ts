import { resolveToolRuntime } from "../config/runtime.js";
import { isUnaccountedState, LEDGER_RETENTION_DAYS, localDay } from "../ledger/ledger.js";
import { type Coverage, reconcileLedger } from "../ledger/reconcile.js";
import type { CommandOptions } from "../types.js";
import { clampLimit } from "../util/time.js";

/**
 * The operator's answer to "which mails were not checked?". Unlike
 * `reconcile`, it names each unaccounted message by sender and subject where
 * the scan saw them, so it belongs in the operator's own room only and never in
 * an export.
 */
export interface IntegrityDaySummary {
  day: string;
  received: number;
  checked: number;
  notChecked: number;
  inProgress: number;
  countingDefect: number;
}

export interface UnaccountedMessage {
  firstSeenAt: string;
  state: string;
  reason?: string;
  from?: string;
  subject?: string;
}

export interface IntegrityCommandResult {
  instanceId: string;
  coverage: Coverage;
  days: IntegrityDaySummary[];
  unaccounted: UnaccountedMessage[];
}

export const DEFAULT_INTEGRITY_DAYS = 7;
const MAX_LISTED_MESSAGES = 20;

export const integrity = async (
  options: Pick<CommandOptions, "instance" | "configPath" | "limit">,
): Promise<IntegrityCommandResult> => {
  if (options.instance === undefined) {
    throw new Error("Expected --instance <id>");
  }
  const dayCount =
    options.limit === undefined
      ? DEFAULT_INTEGRITY_DAYS
      : clampLimit(options.limit, LEDGER_RETENTION_DAYS + 1);
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  const now = new Date();
  const ledger = await runtime.readLedger(now);
  const state = await runtime.readState();
  const report = reconcileLedger(ledger, now, { days: dayCount });
  const shownDays = new Set(report.days.map((day) => day.day));
  const details = state.integrityDetails ?? {};
  const unaccounted = Object.values(ledger.entries)
    .filter(
      (entry) => isUnaccountedState(entry.state) && shownDays.has(localDay(entry.firstSeenAt)),
    )
    .sort((left, right) => right.firstSeenAt.localeCompare(left.firstSeenAt))
    .slice(0, MAX_LISTED_MESSAGES)
    .map((entry): UnaccountedMessage => {
      const detail = details[entry.key];
      return {
        firstSeenAt: entry.firstSeenAt,
        state: entry.state,
        ...(entry.reason === undefined ? {} : { reason: entry.reason }),
        ...(detail === undefined ? {} : { from: detail.from, subject: detail.subject }),
      };
    });
  return {
    instanceId: runtime.instanceId,
    coverage: report.coverage,
    days: report.days.map((day) => ({
      day: day.day,
      received: day.expected,
      checked: day.verdict,
      notChecked: day.unaccounted,
      inProgress: day.inFlight,
      countingDefect: day.residual,
    })),
    unaccounted,
  };
};

const STATE_LABELS: Record<string, string> = {
  "no-verdict:reviewer-unavailable": "not reviewed: the AI reviewer was unavailable",
  "no-verdict:refused": "not reviewed: the AI provider refused under the privacy routing",
  "no-verdict:defaulted": "not reviewed: the AI reply was incomplete",
  "read-failed": "could not be read",
  "too-large": "too large to read",
  "not-returned": "in the mailbox, but never reached the scan",
};

const pad2 = (value: number): string => String(value).padStart(2, "0");

const formatLocalTime = (iso: string): string => {
  const date = new Date(iso);
  return `${localDay(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};

export const formatIntegrityResult = (result: IntegrityCommandResult): string => {
  const lines = [`Mail check (coverage: ${result.coverage}).`];
  if (result.days.length === 0) {
    lines.push("No mail recorded yet.");
    return lines.join("\n");
  }
  for (const day of result.days) {
    lines.push(
      `${day.day}: ${String(day.received)} received, ${String(day.checked)} checked, ${String(
        day.notChecked,
      )} not checked, ${String(day.inProgress)} in progress.${
        day.countingDefect === 0
          ? ""
          : ` Counts do not balance (difference ${String(day.countingDefect)}).`
      }`,
    );
  }
  if (result.unaccounted.length === 0) {
    lines.push("Every message in this period was checked or is still in progress.");
    return lines.join("\n");
  }
  lines.push("Not checked:");
  for (const message of result.unaccounted) {
    const label = STATE_LABELS[message.state] ?? message.state;
    const reason = message.reason === undefined ? "" : ` (${message.reason})`;
    const who =
      message.from === undefined
        ? "never read; look in your mail client around this time"
        : `${message.from} · ${message.subject as string}`;
    lines.push(`- ${formatLocalTime(message.firstSeenAt)} · ${label}${reason} · ${who}`);
  }
  return lines.join("\n");
};
