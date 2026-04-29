import type {
  CheckinAddResult,
  CheckinLatestResult,
  CheckinListResult,
  ResistanceAddResult,
  ResistanceListResult,
  ResistanceResolveResult,
  ReviewWeeklyResult,
  StepCompleteResult,
  StepListResult,
  StepNextResult,
  WishAddResult,
  WishListResult,
  WishShowResult,
} from "./commands.js";
import type { CommandOptions } from "./types.js";

export const printOutput = <T>(
  value: T,
  options: Pick<CommandOptions, "json">,
  formatter: (value: T) => string,
): void => {
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...(value as object) }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatter(value)}\n`);
};

const labelStatus = (status: string): string => status.toUpperCase();

export const formatWishAdd = (value: WishAddResult): string =>
  `Wish added: "${value.wish.title}"\nStatus: ${value.wish.status}\nID: ${value.wish.id}`;

export const formatWishList = (value: WishListResult): string => {
  if (value.wishes.length === 0) {
    return "No wishes recorded yet. Try `add wish: <title>`.";
  }
  return value.wishes
    .map(
      (wish) =>
        `[${labelStatus(wish.status)}] ${wish.title}` +
        (wish.description !== undefined ? `\n  ${wish.description}` : ""),
    )
    .join("\n");
};

export const formatWishShow = (value: WishShowResult): string => {
  const wish = value.wish;
  const lines = [
    `Wish: ${wish.title}`,
    `Status: ${wish.status}`,
    `ID: ${wish.id}`,
    `Created: ${wish.createdAt}`,
    `Updated: ${wish.updatedAt}`,
  ];
  if (wish.description !== undefined) lines.push(`Description: ${wish.description}`);
  if (wish.emotionalCore !== undefined) lines.push(`Emotional core: ${wish.emotionalCore}`);
  if (wish.desiredState !== undefined) lines.push(`Desired state: ${wish.desiredState}`);
  if (wish.timeframe !== undefined) lines.push(`Timeframe: ${wish.timeframe}`);
  return lines.join("\n");
};

const formatCheckinLine = (checkin: {
  energyScore: number;
  clarityScore: number;
  congruenceScore: number;
  resistanceScore: number;
  createdAt: string;
  note?: string | undefined;
}): string =>
  `${checkin.createdAt} energy ${checkin.energyScore} clarity ${checkin.clarityScore} congruence ${checkin.congruenceScore} resistance ${checkin.resistanceScore}` +
  (checkin.note !== undefined ? `\n  note: ${checkin.note}` : "");

export const formatCheckinAdd = (value: CheckinAddResult): string =>
  `Check-in saved.\n${formatCheckinLine(value.checkin)}`;

export const formatCheckinList = (value: CheckinListResult): string => {
  if (value.checkins.length === 0) {
    return "No check-ins yet. Try `daily alignment`.";
  }
  return value.checkins.map(formatCheckinLine).join("\n");
};

export const formatCheckinLatest = (value: CheckinLatestResult): string => {
  if (value.checkin === undefined) {
    return "No check-ins yet.";
  }
  return formatCheckinLine(value.checkin);
};

export const formatResistanceAdd = (value: ResistanceAddResult): string => {
  const verb = value.created ? "added" : "incremented";
  return `Resistance ${verb}: ${value.pattern.label} (count ${value.pattern.recurrenceCount})`;
};

export const formatResistanceList = (value: ResistanceListResult): string => {
  if (value.resistance.length === 0) {
    return "No resistance patterns recorded yet.";
  }
  return value.resistance
    .map(
      (pattern) =>
        `[${labelStatus(pattern.status)}] ${pattern.label} x${pattern.recurrenceCount} (last ${pattern.lastSeenAt})`,
    )
    .join("\n");
};

export const formatResistanceResolve = (value: ResistanceResolveResult): string =>
  `Resistance marked reduced: ${value.pattern.label}`;

export const formatStepNext = (value: StepNextResult): string => {
  const lines = [`Next aligned step for "${value.wish.title}":`, value.step.title];
  if (value.step.rationale !== undefined) {
    lines.push(`Why: ${value.step.rationale}`);
  }
  lines.push(`ID: ${value.step.id}`);
  return lines.join("\n");
};

export const formatStepList = (value: StepListResult): string => {
  if (value.steps.length === 0) {
    return "No open steps. Try `next aligned step`.";
  }
  return value.steps.map((step) => `- ${step.title}\n  ID: ${step.id}`).join("\n");
};

export const formatStepComplete = (value: StepCompleteResult): string =>
  `Step completed: ${value.step.title}`;

export const formatReviewWeekly = (value: ReviewWeeklyResult): string => value.formatted;
