import { resolveToolRuntime } from "../config/runtime.js";
import { RULE_ADJUSTMENT_FLOOR } from "../constants.js";
import {
  addPolicyEntry,
  applyLearningAdjustment,
  derivePolicyFromFeedback,
} from "../policy/actions.js";
import { withLockedState } from "../state/io.js";
import type { CommandOptions, FeedbackAction, StoredAlert } from "../types.js";
import { nowIso, parseDurationMs, sortAlertsNewestFirst } from "../util/time.js";

export interface FeedbackCommandResult {
  instanceId: string;
  alertId: string;
  action: FeedbackAction;
  changed: boolean;
  note: string;
  nextReminderAt?: string;
  policyId?: string;
}

export const applyFeedback = async (
  options: Pick<
    CommandOptions,
    "instance" | "configPath" | "alertId" | "latest" | "action" | "delay"
  >,
): Promise<FeedbackCommandResult> => {
  if (options.instance === undefined) {
    throw new Error("Expected --instance <id>");
  }
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  return withLockedState(runtime.statePath, async () => {
    const state = await runtime.readState();
    const alert: StoredAlert | undefined =
      typeof options.alertId === "string"
        ? state.alerts.find((entry) => entry.alertId === options.alertId)
        : options.latest === true
          ? sortAlertsNewestFirst(state.alerts)[0]
          : undefined;
    if (alert === undefined) {
      throw new Error("No matching Mail Sentinel alert was found");
    }

    const appliedAt = nowIso();
    let note = "Feedback recorded.";
    let nextReminderAt: string | undefined;
    let policyId: string | undefined;
    const action = options.action;
    if (action === "important") {
      alert.feedbackState = "important";
      alert.feedbackAt = appliedAt;
      alert.reminderDueAt = undefined;
      applyLearningAdjustment(state.learning.senderWeights, alert.fromAddress, 2);
      applyLearningAdjustment(state.learning.domainWeights, alert.domain, 1);
      for (const ruleId of alert.matchedRuleIds ?? []) {
        applyLearningAdjustment(state.learning.ruleAdjustments, ruleId, 1);
      }
      note = "Alert marked as important.";
    } else if (action === "not-important") {
      alert.feedbackState = "not-important";
      alert.feedbackAt = appliedAt;
      alert.reminderDueAt = undefined;
      applyLearningAdjustment(state.learning.senderWeights, alert.fromAddress, -2);
      applyLearningAdjustment(state.learning.domainWeights, alert.domain, -1);
      for (const ruleId of alert.matchedRuleIds ?? []) {
        applyLearningAdjustment(state.learning.ruleAdjustments, ruleId, -1, RULE_ADJUSTMENT_FLOOR);
      }
      note = "Alert marked as not important.";
    } else if (action === "less-often") {
      alert.feedbackState = "less-often";
      alert.feedbackAt = appliedAt;
      alert.reminderDueAt = undefined;
      applyLearningAdjustment(state.learning.senderWeights, alert.fromAddress, -4);
      applyLearningAdjustment(state.learning.domainWeights, alert.domain, -2);
      for (const ruleId of alert.matchedRuleIds ?? []) {
        applyLearningAdjustment(state.learning.ruleAdjustments, ruleId, -1, RULE_ADJUSTMENT_FLOOR);
      }
      note = "Future alerts from this sender will be down-weighted.";
    } else if (action === "remind-later") {
      const delay = options.delay ?? runtime.defaultReminderDelay;
      nextReminderAt = new Date(Date.now() + parseDurationMs(delay)).toISOString();
      alert.reminderDueAt = nextReminderAt;
      note = "Reminder scheduled.";
    } else if (action === "always-like-this" || action === "reduce" || action === "digest-only") {
      const policy = await runtime.readPolicy();
      const derived = derivePolicyFromFeedback(alert, action);
      if (derived === null) {
        throw new Error("This alert does not contain enough sender information to derive a policy");
      }
      policyId = derived.entry.id;
      await runtime.writePolicy(addPolicyEntry(policy, derived.type, derived.entry));
      if (action === "always-like-this") {
        note = "Sender policy created to keep this handling pattern.";
      } else if (action === "digest-only") {
        note = "Sender policy created to route similar future signals to the digest only.";
      } else {
        note = "Sender policy created to reduce similar future signals.";
      }
      if (action === "reduce") {
        applyLearningAdjustment(state.learning.senderWeights, alert.fromAddress, -2);
        applyLearningAdjustment(state.learning.domainWeights, alert.domain, -1);
      }
      alert.feedbackState = action;
      alert.feedbackAt = appliedAt;
    } else {
      throw new Error(`Unsupported action '${String(action)}'`);
    }

    state.feedback.push({
      alertId: alert.alertId,
      action: action as FeedbackAction,
      at: appliedAt,
      ...(nextReminderAt === undefined
        ? {}
        : { delay: options.delay ?? runtime.defaultReminderDelay }),
      ...(policyId === undefined ? {} : { policyId }),
    });
    await runtime.writeState(state);
    return {
      instanceId: runtime.instanceId,
      alertId: alert.alertId,
      action: action as FeedbackAction,
      changed: true,
      note,
      ...(nextReminderAt === undefined ? {} : { nextReminderAt }),
      ...(policyId === undefined ? {} : { policyId }),
    };
  });
};
