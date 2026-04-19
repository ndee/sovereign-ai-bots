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

// Extract a calm operator-facing sender display from a raw From header.
// Preference order:
//   1. Display name, when present: `"Alice" <alice@example.com>` -> `Alice`.
//   2. Local part minus any `+alias` tag, when only a bare address is given:
//      `billing+invoice@privex.com` -> `billing`.
//      `sovereign-ai-node-test+decision@proton.me` -> `sovereign-ai-node-test`.
//   3. The raw string, trimmed, as a last resort.
// Full address is never lost: callers still have `alert.from` internally.
export const formatSenderDisplay = (from: string): string => {
  const displayName = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/u.exec(from);
  if (displayName !== null) {
    const name = (displayName[1] as string).trim();
    if (name.length > 0) {
      return name;
    }
  }
  const bareAddress = /^\s*([^\s<>@]+)@[^\s<>]+\s*$/u.exec(from);
  if (bareAddress !== null) {
    const localPart = (bareAddress[1] as string).split("+")[0] as string;
    if (localPart.length > 0) {
      return localPart;
    }
  }
  return from.trim();
};

// Strip synthetic/test suffix patterns that leak into visible subjects via
// the live e2e fixtures. Matches `e2e-<digits>` anywhere, plus any
// kebab-tag-wrapper directly preceding it (e.g. `invoice-overdue-e2e-123`),
// and any `—`/`-`/`:` separator immediately before. Preserves the stored
// subject; only the visible headline is cleaned.
const E2E_TAG_TOKEN = /\s*[—\-:]?\s*(?:[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*-)?e2e-\d+/giu;

export const cleanSubjectForDisplay = (subject: string): string =>
  subject
    .replace(E2E_TAG_TOKEN, "")
    .replace(/\s{2,}/gu, " ")
    .trim();

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
    title,
    `${zoneLabel(alert.zone)} · ${categoryLabel(alert.category)}`,
    "",
    cleanSubjectForDisplay(alert.subject),
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
      `${String(index + 1)}. ${trimSubject(cleanSubjectForDisplay(alert.subject))}`,
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
