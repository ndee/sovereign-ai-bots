import { randomUUID } from "node:crypto";

import { FEEDBACK_HINT, LANE_LABELS } from "./constants.js";
import type { CommandOptions, DeliveredSignal, SourceDefinition } from "./types.js";
import { formatConfidenceLabel } from "./util.js";

export const formatSignalLine = (
  signal: Pick<DeliveredSignal, "signalId" | "route" | "lane" | "sourceName" | "title">,
): string =>
  `- [${signal.signalId}] ${signal.route.toUpperCase()} | ${LANE_LABELS[signal.lane]} | ${signal.sourceName} | ${signal.title}`;

export const buildRedAlertMessage = (signal: DeliveredSignal): string =>
  [
    `Project Sentinel Alert [${signal.signalId}]`,
    `Zone: ${signal.route.toUpperCase()}`,
    `Lane: ${LANE_LABELS[signal.lane]}`,
    `Source: ${signal.sourceName}`,
    `Title: ${signal.title}`,
    `Why it matters: ${signal.why}`,
    `Confidence: ${formatConfidenceLabel(signal.confidence)}`,
    `Link: ${signal.url}`,
    `Feedback: ${FEEDBACK_HINT}`,
  ].join("\n");

export const buildDigestMessage = (
  signals: readonly DeliveredSignal[],
  interval: string,
  generatedAt: string,
): string => {
  const lines = [
    `Project Sentinel Digest [${randomUUID()}]`,
    `Window: last ${interval}`,
    `Amber signals: ${String(signals.length)}`,
    "",
  ];
  for (const [index, signal] of signals.slice(0, 10).entries()) {
    lines.push(
      `${String(index + 1)}. ${signal.title}`,
      `   Source: ${signal.sourceName}`,
      `   Lane: ${LANE_LABELS[signal.lane]}`,
      `   Why it matters: ${signal.why}`,
      `   Signal ID: ${signal.signalId}`,
      `   Link: ${signal.url}`,
    );
  }
  if (signals.length > 10) {
    lines.push(`... and ${String(signals.length - 10)} more.`);
  }
  lines.push(
    "",
    `${FEEDBACK_HINT} Reference the item number or Signal ID.`,
    "",
    `Generated: ${generatedAt}`,
  );
  return lines.join("\n");
};

export interface ScanResult {
  configured: boolean;
  note?: string;
  processedSources: number;
  processedSignals: number;
  newSignals: number;
  redAlertsSent: number;
  amberQueued: number;
  digestsSent: number;
  alerts: readonly DeliveredSignal[];
}

export const formatScanResult = (result: ScanResult): string => {
  if (!result.configured) {
    return result.note ?? "Project Sentinel is not configured yet.";
  }
  const lines = [
    `Project Sentinel scan: ${String(result.processedSources)} source(s), ${String(result.processedSignals)} fetched signal(s), ${String(result.newSignals)} new or updated signal(s), ${String(result.redAlertsSent)} red alert(s), ${String(result.amberQueued)} amber signal(s), ${String(result.digestsSent)} digest(s).`,
  ];
  if (result.note !== undefined) {
    lines.push(`Note: ${result.note}`);
  }
  if (result.alerts.length > 0) {
    lines.push(...result.alerts.map((alert) => formatSignalLine(alert)));
  }
  return lines.join("\n");
};

export interface DigestResult {
  alerts: readonly DeliveredSignal[];
}

export const formatDigestResult = (result: DigestResult): string => {
  if (result.alerts.length === 0) {
    return "No amber Project Sentinel signals are currently queued.";
  }
  return [
    `Project Sentinel digest queue (${String(result.alerts.length)} item(s)):`,
    ...result.alerts.map((alert) => formatSignalLine(alert)),
  ].join("\n");
};

export interface FeedbackResult {
  note: string;
  signalId: string;
}

export const formatFeedbackResult = (result: FeedbackResult): string =>
  `${result.note} Signal ${result.signalId}.`;

export interface StatusResult {
  configured: boolean;
  activeProfiles: number;
  enabledSources: number;
  trackedSignals: number;
  pendingAmber: number;
  lastScanAt?: string;
  lastAlertAt?: string;
  lastError?: string;
}

export const formatStatusResult = (result: StatusResult): string => {
  const lines = [
    `Project Sentinel status: ${String(result.enabledSources)} enabled source(s), ${String(result.activeProfiles)} active profile(s), ${String(result.trackedSignals)} tracked signal(s), ${String(result.pendingAmber)} amber queued.`,
  ];
  if (!result.configured) {
    lines.push("Project Sentinel has no active profiles or enabled sources.");
  }
  if (result.lastScanAt !== undefined) {
    lines.push(`Last scan: ${result.lastScanAt}`);
  }
  if (result.lastAlertAt !== undefined) {
    lines.push(`Last alert: ${result.lastAlertAt}`);
  }
  if (result.lastError !== undefined) {
    lines.push(`Last error: ${result.lastError}`);
  }
  return lines.join("\n");
};

export interface SourcesResult {
  note?: string;
  sources: readonly SourceDefinition[];
}

export const formatSourcesResult = (result: SourcesResult): string => {
  const lines = [result.note ?? "Project Sentinel sources:"];
  if (result.sources.length === 0) {
    lines.push("- none");
    return lines.join("\n");
  }
  lines.push(
    ...result.sources.map(
      (source) =>
        `- [${source.id}] ${source.enabled ? "enabled" : "disabled"} | ${source.type} | ${source.trustTier} | ${source.lanes.join(", ")}`,
    ),
  );
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
