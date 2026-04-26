import { randomUUID } from "node:crypto";

import { latestCheckin } from "./checkins.js";
import { recurringResistance } from "./resistance.js";
import type { ActionStep, RealityAlignmentState, Wish } from "./types.js";
import { compactText, nowIso } from "./util.js";
import { activeWishes, findWish } from "./wishes.js";

export const findStep = (state: RealityAlignmentState, query: string): ActionStep | undefined => {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  const byId = state.steps.find((step) => step.id === trimmed);
  if (byId !== undefined) {
    return byId;
  }
  return state.steps.find((step) => step.title.toLowerCase().includes(lower));
};

export const openSteps = (state: RealityAlignmentState): ActionStep[] =>
  state.steps.filter((step) => step.status === "open");

export const completeStep = (state: RealityAlignmentState, query: string): ActionStep => {
  const step = findStep(state, query);
  if (step === undefined) {
    throw new Error(`No step matched '${query}'`);
  }
  step.status = "done";
  step.completedAt = nowIso();
  return step;
};

interface NextStepDraft {
  title: string;
  rationale: string;
}

const draftStep = (wish: Wish, state: RealityAlignmentState): NextStepDraft => {
  const checkin = latestCheckin(state);
  const resistance = recurringResistance(state).find(
    (pattern) => pattern.linkedWishIds.length === 0 || pattern.linkedWishIds.includes(wish.id),
  );

  if (checkin !== undefined && checkin.clarityScore <= 2) {
    return {
      title: `Write the clearest one-sentence version of "${wish.title}".`,
      rationale:
        "Latest check-in shows low clarity. A single sentence forces the wish into sharp focus.",
    };
  }
  if (checkin !== undefined && checkin.resistanceScore >= 4) {
    const label = resistance?.label ?? "the resistance you feel right now";
    return {
      title: `Write down one fear or hesitation linked to ${label}.`,
      rationale: "Resistance is high in the latest check-in. Naming the friction reduces its grip.",
    };
  }
  if (checkin !== undefined && checkin.energyScore <= 2) {
    return {
      title: `Pick the smallest 10-minute action toward "${wish.title}" you can do today.`,
      rationale: "Energy is low. A small, time-boxed step keeps momentum without overspending.",
    };
  }
  if (checkin !== undefined && checkin.congruenceScore <= 2) {
    return {
      title: `List one thing in your day that feels out of sync with "${wish.title}".`,
      rationale: "Congruence is low. Spotting a single misalignment is a concrete starting point.",
    };
  }
  if (resistance !== undefined) {
    return {
      title: `Block 20 minutes to face "${resistance.label}" directly toward "${wish.title}".`,
      rationale: `Recurring resistance: ${resistance.label} (${resistance.recurrenceCount}x).`,
    };
  }
  return {
    title: `Define one concrete 20-minute action you can complete today for "${wish.title}".`,
    rationale:
      "No blocking signal in the latest check-in. Convert the wish into one visible action.",
  };
};

export const generateNextStep = (
  state: RealityAlignmentState,
  options: { wishQuery?: string | undefined } = {},
): ActionStep => {
  let wish: Wish | undefined;
  if (options.wishQuery !== undefined && options.wishQuery.trim().length > 0) {
    wish = findWish(state, options.wishQuery);
    if (wish === undefined) {
      throw new Error(`No wish matched '${options.wishQuery}'`);
    }
    if (wish.status !== "active") {
      throw new Error(`Wish '${wish.title}' is not active (status: ${wish.status})`);
    }
  } else {
    const candidates = activeWishes(state);
    if (candidates.length === 0) {
      throw new Error("No active wishes. Add a wish first with `wish add`.");
    }
    wish = candidates
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  /* v8 ignore next 3 -- defensive narrowing for the wish reference */
  if (wish === undefined) {
    throw new Error("No active wish available");
  }

  const draft = draftStep(wish, state);
  const at = nowIso();
  const step: ActionStep = {
    id: randomUUID(),
    title: compactText(draft.title),
    linkedWishId: wish.id,
    rationale: compactText(draft.rationale),
    status: "open",
    createdAt: at,
  };
  state.steps.push(step);
  return step;
};
