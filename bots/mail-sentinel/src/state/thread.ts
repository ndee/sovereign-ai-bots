import { MAX_THREAD_CONTEXT_ENTRIES } from "../constants.js";
import type {
  MailSentinelState,
  ParsedMessage,
  StoredAlert,
  ThreadContextEntry,
} from "../types.js";

export const buildThreadContext = (
  state: MailSentinelState,
  message: Pick<ParsedMessage, "key" | "normalizedThreadSubject">,
): ThreadContextEntry[] =>
  Object.values(state.messages)
    .filter(
      (entry) =>
        entry.normalizedThreadSubject === message.normalizedThreadSubject &&
        entry.key !== message.key &&
        typeof entry.snippet === "string",
    )
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
    .slice(0, MAX_THREAD_CONTEXT_ENTRIES)
    .map((entry) => ({
      subject: entry.subject,
      from: entry.from,
      snippet: entry.snippet,
      ...(entry.date === undefined ? {} : { date: entry.date }),
    }));

export const queueAmberAlert = (state: MailSentinelState, alertId: string): void => {
  if (!state.digest.pendingAmber.includes(alertId)) {
    state.digest.pendingAmber.push(alertId);
  }
};

export const resolvePendingAmberAlerts = (state: MailSentinelState): StoredAlert[] => {
  const alertsById = new Map(state.alerts.map((alert) => [alert.alertId, alert] as const));
  return state.digest.pendingAmber
    .map((alertId) => alertsById.get(alertId))
    .filter((alert): alert is StoredAlert => alert !== undefined && alert.zone === "amber");
};
