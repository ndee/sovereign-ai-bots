import { randomUUID } from "node:crypto";

import type { AlignmentCheckin, RealityAlignmentState, Score } from "./types.js";
import { nowIso } from "./util.js";

export const addCheckin = (
  state: RealityAlignmentState,
  input: {
    energy: Score;
    clarity: Score;
    congruence: Score;
    resistance: Score;
    note?: string | undefined;
    linkedWishIds?: string[] | undefined;
  },
): AlignmentCheckin => {
  const at = nowIso();
  const checkin: AlignmentCheckin = {
    id: randomUUID(),
    date: at.slice(0, 10),
    energyScore: input.energy,
    clarityScore: input.clarity,
    congruenceScore: input.congruence,
    resistanceScore: input.resistance,
    ...(input.note !== undefined && input.note.trim().length > 0
      ? { note: input.note.trim() }
      : {}),
    linkedWishIds: input.linkedWishIds ?? [],
    createdAt: at,
  };
  state.checkins.push(checkin);
  return checkin;
};

export const latestCheckin = (state: RealityAlignmentState): AlignmentCheckin | undefined => {
  if (state.checkins.length === 0) {
    return undefined;
  }
  let latest = state.checkins[0] as AlignmentCheckin;
  for (let index = 1; index < state.checkins.length; index += 1) {
    const candidate = state.checkins[index] as AlignmentCheckin;
    if (candidate.createdAt >= latest.createdAt) {
      latest = candidate;
    }
  }
  return latest;
};

export const checkinsSince = (state: RealityAlignmentState, sinceIso: string): AlignmentCheckin[] =>
  state.checkins.filter((checkin) => checkin.createdAt >= sinceIso);

export interface CheckinAverage {
  energy: number;
  clarity: number;
  congruence: number;
  resistance: number;
  count: number;
}

export const averageScores = (
  checkins: readonly AlignmentCheckin[],
): CheckinAverage | undefined => {
  if (checkins.length === 0) {
    return undefined;
  }
  const sum = checkins.reduce(
    (acc, entry) => ({
      energy: acc.energy + entry.energyScore,
      clarity: acc.clarity + entry.clarityScore,
      congruence: acc.congruence + entry.congruenceScore,
      resistance: acc.resistance + entry.resistanceScore,
    }),
    { energy: 0, clarity: 0, congruence: 0, resistance: 0 },
  );
  const count = checkins.length;
  return {
    energy: round1(sum.energy / count),
    clarity: round1(sum.clarity / count),
    congruence: round1(sum.congruence / count),
    resistance: round1(sum.resistance / count),
    count,
  };
};

const round1 = (value: number): number => Math.round(value * 10) / 10;
