import type { AlertSummary, CommandOptions, FlattenedPolicyEntry } from "../types.js";
import { formatAlertLine } from "./format.js";

export interface ScanResult {
  configured: boolean;
  note?: string;
  newMessages: number;
  redAlertsSent: number;
  amberQueued: number;
  digestsSent: number;
  remindersSent: number;
  alerts: readonly AlertSummary[];
}

export const formatScanResult = (result: Partial<ScanResult>): string => {
  if (!result.configured) {
    return result.note ?? "IMAP is not configured yet.";
  }
  const lines = [
    `Mail Sentinel scan: ${String(result.newMessages ?? 0)} new message(s), ${String(
      result.redAlertsSent ?? 0,
    )} red alert(s), ${String(result.amberQueued ?? 0)} amber candidate(s), ${String(
      result.digestsSent ?? 0,
    )} digest(s), ${String(result.remindersSent ?? 0)} reminder(s).`,
  ];
  const alerts = result.alerts ?? [];
  if (alerts.length > 0) {
    lines.push(...alerts.map((alert) => formatAlertLine(alert)));
  }
  return lines.join("\n");
};

export interface FeedbackResultCandidate {
  shortRef: string;
  subject: string;
  from: string;
}

export interface FeedbackResult {
  note?: string;
  alertId?: string;
  shortRef?: string;
  subject?: string;
  from?: string;
  nextReminderAt?: string;
  policyId?: string;
  status?: "ambiguous";
  ref?: string;
  candidates?: readonly FeedbackResultCandidate[];
}

// Name the exact item a confirmation applies to: "[shortRef] 'subject' from
// sender". Falls back to the bare alertId when the enriched fields are absent,
// so output is never empty.
const describeTarget = (result: FeedbackResult): string => {
  if (typeof result.shortRef === "string" && typeof result.subject === "string") {
    const sender = typeof result.from === "string" ? ` from ${result.from}` : "";
    return `[${result.shortRef}] '${result.subject}'${sender}`;
  }
  return `Alert ${String(result.alertId)}`;
};

export const formatFeedbackResult = (result: FeedbackResult): string => {
  // Ambiguous: lead with the status word, then list the candidates with their
  // short refs so the user can reply with an unambiguous one. No change applied.
  if (result.status === "ambiguous") {
    const candidates = result.candidates ?? [];
    return [
      `Ambiguous: '${result.ref ?? ""}' matches ${String(candidates.length)} items. Reply with one of:`,
      ...candidates.map(
        (candidate) => `- [${candidate.shortRef}] '${candidate.subject}' from ${candidate.from}`,
      ),
    ].join("\n");
  }
  const target = describeTarget(result);
  if (result.policyId !== undefined) {
    return `${result.note} Applied to: ${target}. Policy ${result.policyId} created.`;
  }
  return result.nextReminderAt === undefined
    ? `${result.note} Applied to: ${target}.`
    : `${result.note} Applied to: ${target}. Will be revisited at ${result.nextReminderAt}.`;
};

export interface ListAlertsResult {
  view: "today" | "recent" | string;
  alerts: readonly AlertSummary[];
}

export const formatListAlertsResult = (result: ListAlertsResult): string => {
  if (result.alerts.length === 0) {
    return result.view === "today"
      ? "No important Mail Sentinel alerts today."
      : "No Mail Sentinel alerts have been recorded yet.";
  }
  return [
    result.view === "today" ? "Important today:" : "Recent alerts:",
    ...result.alerts.map((alert) => formatAlertLine(alert)),
  ].join("\n");
};

export interface DigestResult {
  alerts: readonly AlertSummary[];
}

export const formatDigestResult = (result: DigestResult): string => {
  if (result.alerts.length === 0) {
    return "No amber digest entries are currently queued.";
  }
  return [
    `Amber digest queue (${String(result.alerts.length)} item(s)):`,
    ...result.alerts.map((alert) => formatAlertLine(alert)),
  ].join("\n");
};

export interface PolicyListResult {
  policies: readonly FlattenedPolicyEntry[];
}

const describePolicyEntry = (entry: FlattenedPolicyEntry): string => {
  // Content rules carry a regex (and optional subject/body scope); every other
  // policy type is described by its match/category/schedule. `pattern` is handled
  // here only via the content branch, so it is not part of the fallback chain.
  if (entry.type === "content" && typeof entry.pattern === "string") {
    const scope = entry.scope ?? "any";
    return `${scope}:/${entry.pattern}/`;
  }
  return String(entry.match ?? entry.category ?? entry.schedule);
};

export const formatPolicyResult = (result: PolicyListResult): string => {
  if (result.policies.length === 0) {
    return "No Mail Sentinel policies are configured.";
  }
  return [
    "Mail Sentinel policies:",
    ...result.policies.map(
      (entry) => `- [${entry.id}] ${entry.type} ${describePolicyEntry(entry)}`,
    ),
  ].join("\n");
};

export interface PolicyActionResult {
  note: string;
  matches?: readonly {
    from: string;
    fromAddress: string;
    messageCount: number;
    lastSeenAt: string;
  }[];
}

export const formatPolicyActionResult = (result: PolicyActionResult): string => {
  const lines = [result.note];
  if (Array.isArray(result.matches) && result.matches.length > 0) {
    lines.push(
      ...result.matches.map(
        (match) =>
          `- ${match.from} | ${match.fromAddress} | ${String(match.messageCount)} message(s) | last seen ${match.lastSeenAt}`,
      ),
    );
  }
  return lines.join("\n");
};

export const printOutput = <T>(
  result: T,
  options: Pick<CommandOptions, "json">,
  formatter: (value: T) => string,
): void => {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatter(result)}\n`);
};
