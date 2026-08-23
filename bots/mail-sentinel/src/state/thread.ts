import type { MailSentinelState, StoredAlert } from "../types.js";

// `buildThreadContext` used to live here. It was removed with pro#377: the
// semantic reviewer no longer receives snippets of other mails in the same
// thread, so nothing builds thread context any more.

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
