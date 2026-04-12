import { randomUUID } from "node:crypto";

import { CATEGORY_LABELS } from "../constants.js";
import type { AlertSummary, StoredAlert } from "../types.js";
import { formatConfidenceLabel } from "../util/time.js";

type AlertKind = AlertSummary["kind"];

export const formatAlertLine = (
  alert: Pick<StoredAlert, "alertId" | "zone" | "category" | "from" | "subject">,
): string =>
  `- [${alert.alertId}] ${String(alert.zone ?? "red").toUpperCase()} | ${
    CATEGORY_LABELS[alert.category] ?? alert.category
  } | ${alert.from} | ${alert.subject}`;

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
    `${title} [${alert.alertId}]`,
    `Zone: ${String(alert.zone ?? "red").toUpperCase()}`,
    `Category: ${CATEGORY_LABELS[alert.category] ?? alert.category}`,
    `Subject: ${alert.subject}`,
    `From: ${alert.from}`,
    `Why it matters: ${alert.why}`,
    `Confidence: ${formatConfidenceLabel(alert.confidence)}`,
    "Feedback: Reply with 'Very important', 'Not important', 'Remind later', 'Always treat like this', or 'Less of this'.",
  ];
  if (alert.messageId !== undefined) {
    lines.push(`Message ID: ${alert.messageId}`);
  }
  return lines.join("\n");
};

export const buildDigestMessage = (
  alerts: readonly StoredAlert[],
  interval: string,
  sentAt: string,
): string => {
  const lines = [
    `Mail Sentinel Digest [${randomUUID()}]`,
    `Window: last ${interval}`,
    `Amber signals: ${String(alerts.length)}`,
    "",
  ];
  for (const [index, alert] of alerts.slice(0, 10).entries()) {
    lines.push(
      `${String(index + 1)}. ${alert.subject}`,
      `   From: ${alert.from}`,
      `   Category: ${CATEGORY_LABELS[alert.category] ?? alert.category}`,
      `   Confidence: ${formatConfidenceLabel(alert.confidence)}`,
      `   Why it matters: ${alert.why}`,
    );
  }
  if (alerts.length > 10) {
    lines.push(`... and ${String(alerts.length - 10)} more.`);
  }
  lines.push("", `Generated: ${sentAt}`);
  return lines.join("\n");
};
