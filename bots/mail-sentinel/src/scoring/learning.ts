import {
  LEARNED_SENDER_WEIGHT_MAX,
  LEARNED_SENDER_WEIGHT_MIN,
  RULE_ADJUSTMENT_CEILING,
  RULE_ADJUSTMENT_FLOOR,
} from "../constants.js";
import { applyLearningAdjustment } from "../policy/actions.js";
import type {
  FeedbackState,
  LearnedContribution,
  LearnedFeedbackChange,
  LearnedSenderChange,
  LearningState,
  StoredAlert,
} from "../types.js";

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

// Clamped on read as well, so a weight stored by an earlier, unbounded version
// cannot exceed the limits before the next feedback rewrites it.
export const learnedSenderWeight = (learning: LearningState, address: string): number =>
  clamp(learning.senderWeights[address] ?? 0, LEARNED_SENDER_WEIGHT_MIN, LEARNED_SENDER_WEIGHT_MAX);

export const learnedRuleAdjustment = (learning: LearningState, ruleId: string): number =>
  clamp(learning.ruleAdjustments[ruleId] ?? 0, RULE_ADJUSTMENT_FLOOR, RULE_ADJUSTMENT_CEILING);

// The scorer names its own sender, domain and thread matches with these
// prefixes; they are not configured rules, so nothing reads an adjustment
// stored under them.
const SYNTHESIZED_RULE_ID = /^(?:sender|domain|thread):/u;

const isLearnableRuleId = (ruleId: string): boolean => !SYNTHESIZED_RULE_ID.test(ruleId);

const LEARNING_DELTAS: Partial<Record<FeedbackState, { sender: number; rule: number }>> = {
  important: { sender: 2, rule: 1 },
  "not-important": { sender: -2, rule: -1 },
  "less-often": { sender: -4, rule: -1 },
  reduce: { sender: -2, rule: 0 },
};

const nominalContribution = (
  alert: StoredAlert,
  feedbackState: FeedbackState | undefined,
): LearnedContribution => {
  const delta = feedbackState === undefined ? undefined : LEARNING_DELTAS[feedbackState];
  if (delta === undefined) {
    return { sender: 0, rules: {} };
  }
  const rules: Record<string, number> = {};
  if (delta.rule !== 0) {
    for (const ruleId of alert.matchedRuleIds ?? []) {
      if (isLearnableRuleId(ruleId)) {
        rules[ruleId] = delta.rule;
      }
    }
  }
  return { sender: delta.sender, rules };
};

// A hand-edited or truncated state file must not drive a reversal, so anything
// unreadable falls back to the nominal contribution of the stored feedback.
const storedContribution = (alert: StoredAlert): LearnedContribution | undefined => {
  const stored: unknown = alert.learnedContribution;
  if (stored === null || typeof stored !== "object") {
    return undefined;
  }
  const { sender, rules } = stored as { sender?: unknown; rules?: unknown };
  if (typeof sender !== "number" || rules === null || typeof rules !== "object") {
    return undefined;
  }
  return {
    sender,
    rules: Object.fromEntries(
      Object.entries(rules).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && isLearnableRuleId(entry[0]),
      ),
    ),
  };
};

const shiftWeight = (
  target: Record<string, number>,
  key: string,
  reverse: number,
  apply: number,
  min: number,
  max: number,
): { before: number; after: number; contribution: number } => {
  const before = target[key] ?? 0;
  applyLearningAdjustment(target, key, 0, min, max);
  const reversed = applyLearningAdjustment(target, key, -reverse, min, max) as number;
  const after = applyLearningAdjustment(target, key, apply, min, max) as number;
  return { before, after, contribution: after - reversed };
};

export interface LearningTransition {
  learned: LearnedFeedbackChange;
  /** What the new feedback added after the caps; store it on the alert. */
  contribution: LearnedContribution;
}

/**
 * Move `learning` from the alert's current feedback to `next`: the alert's
 * earlier contribution is taken back first, so the result reflects the new
 * feedback alone, never a stack of every click on the same alert.
 */
export const transitionLearning = (
  learning: LearningState,
  alert: StoredAlert,
  next: FeedbackState,
): LearningTransition => {
  const previous = storedContribution(alert) ?? nominalContribution(alert, alert.feedbackState);
  const target = nominalContribution(alert, next);
  const contribution: LearnedContribution = { sender: 0, rules: {} };

  let sender: LearnedSenderChange | undefined;
  const address = alert.fromAddress;
  if (
    typeof address === "string" &&
    address.length > 0 &&
    (previous.sender !== 0 || target.sender !== 0)
  ) {
    const step = shiftWeight(
      learning.senderWeights,
      address,
      previous.sender,
      target.sender,
      LEARNED_SENDER_WEIGHT_MIN,
      LEARNED_SENDER_WEIGHT_MAX,
    );
    contribution.sender = step.contribution;
    sender = {
      address,
      before: step.before,
      after: step.after,
      min: LEARNED_SENDER_WEIGHT_MIN,
      max: LEARNED_SENDER_WEIGHT_MAX,
    };
  }

  const ruleIds = [...new Set([...Object.keys(previous.rules), ...Object.keys(target.rules)])];
  const rules = ruleIds.map((ruleId) => {
    const step = shiftWeight(
      learning.ruleAdjustments,
      ruleId,
      previous.rules[ruleId] ?? 0,
      target.rules[ruleId] ?? 0,
      RULE_ADJUSTMENT_FLOOR,
      RULE_ADJUSTMENT_CEILING,
    );
    if (step.contribution !== 0) {
      contribution.rules[ruleId] = step.contribution;
    }
    return { ruleId, before: step.before, after: step.after };
  });

  const changed =
    (sender !== undefined && sender.before !== sender.after) ||
    rules.some((entry) => entry.before !== entry.after);
  return {
    learned: { changed, ...(sender === undefined ? {} : { sender }), rules },
    contribution,
  };
};
