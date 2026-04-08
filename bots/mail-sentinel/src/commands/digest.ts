import { mapAlertToSummary } from "../alerts/format.js";
import { resolveToolRuntime } from "../config/runtime.js";
import { resolvePendingAmberAlerts } from "../state/thread.js";
import type { AlertSummary, CommandOptions } from "../types.js";
import { clampLimit, isSameLocalDay, sortAlertsNewestFirst } from "../util/time.js";

export interface DigestCommandResult {
  instanceId: string;
  count: number;
  alerts: AlertSummary[];
}

export const digest = async (
  options: Pick<CommandOptions, "instance" | "configPath" | "limit">,
): Promise<DigestCommandResult> => {
  if (options.instance === undefined) {
    throw new Error("Expected --instance <id>");
  }
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  const state = await runtime.readState();
  const limit = clampLimit(options.limit, 20);
  const queuedSource = resolvePendingAmberAlerts(state);
  const fallbackSource = sortAlertsNewestFirst(state.alerts).filter(
    (alert) => alert.zone === "amber" && isSameLocalDay(alert.sentAt, new Date()),
  );
  const queued = (queuedSource.length > 0 ? queuedSource : fallbackSource)
    .slice(0, limit)
    .map((alert) => mapAlertToSummary(alert, "digest"));
  return {
    instanceId: runtime.instanceId,
    count: queued.length,
    alerts: queued,
  };
};
