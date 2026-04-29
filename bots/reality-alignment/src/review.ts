import { averageScores, checkinsSince } from "./checkins.js";
import { WEEKLY_REVIEW_WINDOW_DAYS } from "./constants.js";
import { recurringResistance } from "./resistance.js";
import { openSteps } from "./steps.js";
import type {
  ActionStep,
  AlignmentCheckin,
  RealityAlignmentState,
  ResistancePattern,
  Wish,
} from "./types.js";
import { nowIso } from "./util.js";
import { activeWishes } from "./wishes.js";

export interface WeeklyReview {
  generatedAt: string;
  windowDays: number;
  activeWishes: Wish[];
  recentCheckins: AlignmentCheckin[];
  averages: ReturnType<typeof averageScores>;
  recurringResistance: ResistancePattern[];
  openSteps: ActionStep[];
  focus: string;
  recommendedNextStep: string;
}

const computeFocus = (
  wishes: readonly Wish[],
  averages: ReturnType<typeof averageScores>,
  resistance: readonly ResistancePattern[],
  steps: readonly ActionStep[],
): string => {
  if (wishes.length === 0) {
    return "Define one active wish in plain language to anchor the next week.";
  }
  if (averages !== undefined && averages.clarity <= 2.5) {
    return "Clarity is low. Restate each active wish in a single sentence and decide which one comes first.";
  }
  if (averages !== undefined && averages.resistance >= 3.5) {
    return "Resistance is high. Pick one recurring pattern and reduce it with a small visible action.";
  }
  if (resistance.length > 0) {
    const top = resistance[0];
    if (top !== undefined) {
      return `Move past "${top.label}" once this week with one concrete step rather than analysis.`;
    }
  }
  if (steps.length === 0) {
    return "Move one active wish from reflection into one concrete visible action this week.";
  }
  return "Complete one open step before adding more. Finish over plan.";
};

const computeRecommendedNextStep = (
  wishes: readonly Wish[],
  steps: readonly ActionStep[],
): string => {
  const next = steps[0];
  if (next !== undefined) {
    return next.title;
  }
  const wish = wishes[0];
  if (wish !== undefined) {
    return `Write the clearest one-sentence version of "${wish.title}" and define one action you can complete within 20 minutes.`;
  }
  return "Add one active wish to anchor this week.";
};

export const buildWeeklyReview = (state: RealityAlignmentState): WeeklyReview => {
  const wishes = activeWishes(state);
  const since = new Date(
    Date.now() - WEEKLY_REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const recent = checkinsSince(state, since);
  const averages = averageScores(recent);
  const resistance = recurringResistance(state);
  const steps = openSteps(state);
  return {
    generatedAt: nowIso(),
    windowDays: WEEKLY_REVIEW_WINDOW_DAYS,
    activeWishes: wishes,
    recentCheckins: recent,
    averages,
    recurringResistance: resistance,
    openSteps: steps,
    focus: computeFocus(wishes, averages, resistance, steps),
    recommendedNextStep: computeRecommendedNextStep(wishes, steps),
  };
};

export const formatWeeklyReview = (review: WeeklyReview): string => {
  const lines: string[] = [];
  lines.push("Reality Alignment - Weekly Review");
  lines.push("");
  lines.push(`Active wishes: ${review.activeWishes.length}`);
  if (review.averages !== undefined) {
    lines.push(
      `Recent check-ins: ${review.averages.count} ` +
        `(energy ${review.averages.energy}, clarity ${review.averages.clarity}, ` +
        `congruence ${review.averages.congruence}, resistance ${review.averages.resistance})`,
    );
  } else {
    lines.push("Recent check-ins: 0");
  }
  if (review.recurringResistance.length === 0) {
    lines.push("Recurring resistance: none");
  } else {
    const summary = review.recurringResistance
      .slice(0, 5)
      .map((pattern) => `${pattern.label} (${pattern.recurrenceCount})`)
      .join(", ");
    lines.push(`Recurring resistance: ${summary}`);
  }
  lines.push(`Open aligned steps: ${review.openSteps.length}`);
  lines.push("");
  lines.push("Current focus:");
  lines.push(review.focus);
  lines.push("");
  lines.push("Recommended next step:");
  lines.push(review.recommendedNextStep);
  return lines.join("\n");
};
