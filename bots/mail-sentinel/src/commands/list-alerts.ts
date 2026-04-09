import { mapAlertToSummary } from "../alerts/format.js";
import { resolveToolRuntime } from "../config/runtime.js";
import type { AlertSummary, CommandOptions } from "../types.js";
import { clampLimit, isSameLocalDay, sortAlertsNewestFirst } from "../util/time.js";

export interface ListAlertsCommandResult {
  instanceId: string;
  view: "today" | "recent" | string;
  count: number;
  alerts: AlertSummary[];
}

export const listAlerts = async (
  options: Pick<CommandOptions, "instance" | "configPath" | "view" | "limit">,
): Promise<ListAlertsCommandResult> => {
  if (options.instance === undefined) {
    throw new Error("Expected --instance <id>");
  }
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  const state = await runtime.readState();
  const limit = clampLimit(options.limit, 20);
  const alerts = sortAlertsNewestFirst(state.alerts)
    .filter((alert) => alert.zone !== "gray")
    .filter((alert) => options.view === "recent" || isSameLocalDay(alert.sentAt, new Date()))
    .slice(0, limit)
    .map((alert) => mapAlertToSummary(alert));
  return {
    instanceId: runtime.instanceId,
    view: options.view ?? "today",
    count: alerts.length,
    alerts,
  };
};
