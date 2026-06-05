import { alertShortRef } from "../alerts/format.js";
import { resolveToolRuntime } from "../config/runtime.js";
import { RULE_ADJUSTMENT_FLOOR } from "../constants.js";
import {
  addPolicyEntry,
  applyLearningAdjustment,
  derivePolicyFromFeedback,
} from "../policy/actions.js";
import { feedbackActionLabel } from "../policy/feedback-vocab.js";
import { withLockedState } from "../state/io.js";
import type { CommandOptions, FeedbackAction, StoredAlert } from "../types.js";
import { nowIso, parseDurationMs, sortAlertsNewestFirst } from "../util/time.js";
import { type AlertTargetCandidate, resolveAlertTarget } from "./resolve.js";

export interface FeedbackCommandResult {
  instanceId: string;
  alertId: string;
  shortRef: string;
  subject: string;
  from: string;
  action: FeedbackAction;
  /**
   * The canonical action in plain words ("hide these", "digest only", …) so the
   * confirmation can echo *what the system understood* before/after applying —
   * never just the internal kebab-case id. Derived from the single vocabulary
   * source of truth in `feedback-vocab.ts`.
   */
  actionLabel: string;
  changed: boolean;
  note: string;
  nextReminderAt?: string;
  policyId?: string;
}

/**
 * Returned (instead of applying feedback) when a free-form `--ref` matches more
 * than one alert. No state is mutated — the caller must re-prompt the user with
 * the candidate list so they can disambiguate.
 */
export interface FeedbackAmbiguousResult {
  instanceId: string;
  status: "ambiguous";
  ref: string;
  changed: false;
  candidates: AlertTargetCandidate[];
}

export type ApplyFeedbackResult = FeedbackCommandResult | FeedbackAmbiguousResult;

export const isAmbiguousFeedback = (
  result: ApplyFeedbackResult,
): result is FeedbackAmbiguousResult => "status" in result && result.status === "ambiguous";

export const applyFeedback = async (
  options: Pick<
    CommandOptions,
    "instance" | "configPath" | "alertId" | "ref" | "latest" | "action" | "delay"
  >,
): Promise<ApplyFeedbackResult> => {
  if (options.instance === undefined) {
    throw new Error("Expected --instance <id>");
  }
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  return withLockedState(runtime.statePath, async () => {
    const state = await runtime.readState();
    // Selection precedence: an explicit alertId, then --latest, then a
    // free-form --ref routed through the central resolver. The resolver is the
    // single seam that can report ambiguity instead of silently picking one.
    let alert: StoredAlert | undefined;
    if (typeof options.alertId === "string") {
      alert = state.alerts.find((entry) => entry.alertId === options.alertId);
    } else if (options.latest === true) {
      alert = sortAlertsNewestFirst(state.alerts)[0];
    } else if (typeof options.ref === "string") {
      const resolution = resolveAlertTarget(state, options.ref);
      if (resolution.status === "ambiguous") {
        // Do not mutate state: hand the candidates back for disambiguation.
        return {
          instanceId: runtime.instanceId,
          status: "ambiguous" as const,
          ref: options.ref,
          changed: false as const,
          candidates: resolution.candidates,
        };
      }
      if (resolution.status === "ok") {
        alert = resolution.alert;
      }
    }
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
      note = "Feedback applied. Alert marked as important.";
    } else if (action === "not-important") {
      alert.feedbackState = "not-important";
      alert.feedbackAt = appliedAt;
      alert.reminderDueAt = undefined;
      applyLearningAdjustment(state.learning.senderWeights, alert.fromAddress, -2);
      applyLearningAdjustment(state.learning.domainWeights, alert.domain, -1);
      for (const ruleId of alert.matchedRuleIds ?? []) {
        applyLearningAdjustment(state.learning.ruleAdjustments, ruleId, -1, RULE_ADJUSTMENT_FLOOR);
      }
      note = "Feedback applied. Alert marked as not important.";
    } else if (action === "less-often") {
      alert.feedbackState = "less-often";
      alert.feedbackAt = appliedAt;
      alert.reminderDueAt = undefined;
      applyLearningAdjustment(state.learning.senderWeights, alert.fromAddress, -4);
      applyLearningAdjustment(state.learning.domainWeights, alert.domain, -2);
      for (const ruleId of alert.matchedRuleIds ?? []) {
        applyLearningAdjustment(state.learning.ruleAdjustments, ruleId, -1, RULE_ADJUSTMENT_FLOOR);
      }
      note = "Feedback applied. Sender weight reduced.";
    } else if (action === "remind-later") {
      const delay = options.delay ?? runtime.defaultReminderDelay;
      nextReminderAt = new Date(Date.now() + parseDurationMs(delay)).toISOString();
      alert.reminderDueAt = nextReminderAt;
      note = "Reminder scheduled.";
    } else if (
      action === "always-like-this" ||
      action === "reduce" ||
      action === "digest-only" ||
      action === "mute"
    ) {
      const policy = await runtime.readPolicy();
      const derived = derivePolicyFromFeedback(alert, action);
      if (derived === null) {
        throw new Error("This alert does not contain enough sender information to derive a policy");
      }
      policyId = derived.entry.id;
      await runtime.writePolicy(addPolicyEntry(policy, derived.type, derived.entry));
      if (action === "always-like-this") {
        note = "Policy updated locally. Sender routing pattern locked.";
      } else if (action === "digest-only") {
        note = "Policy updated locally. Similar signals routed to digest only.";
      } else if (action === "mute") {
        note = "Policy updated locally. Similar mail will be hidden.";
      } else {
        note = "Policy updated locally. Similar signals reduced.";
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
      // Echo the matched item so the confirmation names exactly which alert was
      // targeted — never just the ref the user typed.
      shortRef: alertShortRef(alert),
      subject: alert.subject,
      from: alert.from,
      action: action as FeedbackAction,
      actionLabel: feedbackActionLabel(action as FeedbackAction),
      changed: true,
      note,
      ...(nextReminderAt === undefined ? {} : { nextReminderAt }),
      ...(policyId === undefined ? {} : { policyId }),
    };
  });
};
