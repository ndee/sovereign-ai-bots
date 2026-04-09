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
    `Kategorie: ${CATEGORY_LABELS[alert.category] ?? alert.category}`,
    `Betreff: ${alert.subject}`,
    `Absender: ${alert.from}`,
    `Warum wichtig: ${alert.why}`,
    `Confidence: ${formatConfidenceLabel(alert.confidence)}`,
    "Feedback: 'War wichtig', 'Nicht wichtig', 'Spater erinnern', 'Immer so behandeln' oder 'Weniger davon'.",
  ];
  if (alert.messageId !== undefined) {
    lines.push(`Mail-ID: ${alert.messageId}`);
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
    `Zeitraum: letzte ${interval}`,
    `Amber-Signale: ${String(alerts.length)}`,
    "",
  ];
  for (const [index, alert] of alerts.slice(0, 10).entries()) {
    lines.push(
      `${String(index + 1)}. ${alert.subject}`,
      `   Absender: ${alert.from}`,
      `   Kategorie: ${CATEGORY_LABELS[alert.category] ?? alert.category}`,
      `   Confidence: ${formatConfidenceLabel(alert.confidence)}`,
      `   Warum: ${alert.why}`,
    );
  }
  if (alerts.length > 10) {
    lines.push(`... und ${String(alerts.length - 10)} weitere.`);
  }
  lines.push("", `Erstellt: ${sentAt}`);
  return lines.join("\n");
};
