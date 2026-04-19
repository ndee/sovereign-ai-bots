import { CATEGORY_LABELS } from "../constants.js";
import type { AlertSummary, StoredAlert } from "../types.js";
import { formatConfidenceLabel } from "../util/time.js";

type AlertKind = AlertSummary["kind"];

const FEEDBACK_ROW =
  "Feedback: Very important · Not important · Remind later · Always treat like this · Less of this";

const DIGEST_SUBJECT_MAX = 120;
const DIGEST_VISIBLE_LIMIT = 10;

const categoryLabel = (category: string): string => CATEGORY_LABELS[category] ?? category;

const zoneLabel = (zone: unknown): string => String(zone ?? "red").toUpperCase();

const formatCategoryConfidence = (category: string, confidence: unknown): string =>
  `${categoryLabel(category)} · ${formatConfidenceLabel(confidence)}`;

// Conservatively shorten overly long subjects so a single item doesn't blow
// up the digest layout. Non-destructive: we only trim, never rewrite.
const trimSubject = (subject: string): string =>
  subject.length <= DIGEST_SUBJECT_MAX
    ? subject
    : `${subject.slice(0, DIGEST_SUBJECT_MAX - 1).trimEnd()}…`;

// "Alice <alice@example.com>" -> "Alice"; bare addresses fall through unchanged.
export const formatSenderDisplay = (from: string): string => {
  // The capture group always matches when the regex matches, so match[1] is
  // guaranteed to be a string; the `as string` cast pins that invariant and
  // keeps branch coverage clean.
  const match = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/u.exec(from);
  if (match !== null) {
    const name = (match[1] as string).trim();
    if (name.length > 0) {
      return name;
    }
  }
  return from.trim();
};

export const formatAlertLine = (
  alert: Pick<StoredAlert, "alertId" | "zone" | "category" | "from" | "subject">,
): string =>
  `- [${alert.alertId}] ${zoneLabel(alert.zone)} | ${categoryLabel(alert.category)} | ${
    alert.from
  } | ${alert.subject}`;

export const mapAlertToSummary = (
  alert: StoredAlert,
  kind: AlertKind = "new-alert",
): AlertSummary => ({
  alertId: alert.alertId,
  kind,
  zone: alert.zone,
  category: alert.category,
  subject: alert.subject,
  from: alert.from,
  why: alert.why,
  sentAt: kind === "reminder" ? (alert.lastReminderAt ?? alert.sentAt) : alert.sentAt,
  ...(typeof alert.confidence === "number" ? { confidence: alert.confidence } : {}),
  ...(alert.messageId === undefined ? {} : { messageId: alert.messageId }),
  ...(alert.feedbackState === "pending" ? {} : { feedbackState: alert.feedbackState }),
});

export const buildRedAlertMessage = (alert: StoredAlert, kind: AlertKind): string => {
  const title = kind === "reminder" ? "Mail Sentinel Reminder" : "Mail Sentinel Alert";
  const lines = [
    `● ${title} [${alert.alertId}]`,
    `${zoneLabel(alert.zone)} · ${categoryLabel(alert.category)}`,
    "",
    alert.subject,
    "",
    `From: ${formatSenderDisplay(alert.from)}`,
    `Why it matters: ${alert.why}`,
    `Confidence: ${formatConfidenceLabel(alert.confidence)}`,
    "",
    FEEDBACK_ROW,
  ];
  return lines.join("\n");
};

export const buildDigestMessage = (
  alerts: readonly StoredAlert[],
  interval: string,
  sentAt: string,
): string => {
  const lines = [
    "Mail Sentinel Digest",
    `Window: last ${interval}`,
    `Amber signals: ${String(alerts.length)}`,
  ];
  for (const [index, alert] of alerts.slice(0, DIGEST_VISIBLE_LIMIT).entries()) {
    lines.push(
      "",
      `${String(index + 1)}. ${trimSubject(alert.subject)}`,
      `   From: ${formatSenderDisplay(alert.from)}  ·  id ${alert.alertId}`,
      `   ${formatCategoryConfidence(alert.category, alert.confidence)}`,
      `   Why it matters: ${alert.why}`,
    );
  }
  if (alerts.length > DIGEST_VISIBLE_LIMIT) {
    lines.push("", `... and ${String(alerts.length - DIGEST_VISIBLE_LIMIT)} more.`);
  }
  lines.push(
    "",
    `${FEEDBACK_ROW} — reference an item number or subject.`,
    "",
    `Generated: ${sentAt}`,
  );
  return lines.join("\n");
};
