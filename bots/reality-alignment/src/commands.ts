import { addCheckin, latestCheckin } from "./checkins.js";
import { resolveToolRuntime } from "./config/runtime.js";
import { resolveResistance, upsertResistance } from "./resistance.js";
import { buildWeeklyReview, formatWeeklyReview, type WeeklyReview } from "./review.js";
import { pruneState } from "./state.js";
import {
  completeStep as completeStepEntity,
  generateNextStep,
  openSteps as openStepsEntity,
} from "./steps.js";
import {
  type AppreciationExercise,
  buildAppreciationExercise,
  buildFutureSelfExercise,
  buildMagicalActionExercise,
  buildNextHigherStateExercise,
  buildTwentySecondLookExercise,
  type FutureSelfExercise,
  type MagicalActionExercise,
  type NextHigherStateExercise,
  type TwentySecondLookExercise,
} from "./techniques.js";
import type {
  ActionStep,
  AlignmentCheckin,
  CommandOptions,
  RealityAlignmentState,
  ResistancePattern,
  Wish,
} from "./types.js";
import { clampScore, ensureNonEmptyString } from "./util.js";
import { addWish, findWish, setWishStatus } from "./wishes.js";

export interface InstanceContext {
  instanceId: string;
}

const requireInstance = (options: Pick<CommandOptions, "instance">): { instance: string } => {
  if (typeof options.instance !== "string" || options.instance.length === 0) {
    throw new Error("Expected --instance <id>");
  }
  return { instance: options.instance };
};

const mutateState = async <T>(
  options: Pick<CommandOptions, "instance" | "configPath">,
  apply: (state: RealityAlignmentState) => T,
): Promise<{ result: T; instanceId: string }> => {
  const { instance } = requireInstance(options);
  const runtime = await resolveToolRuntime(instance, options.configPath);
  const state = await runtime.readState();
  const result = apply(state);
  pruneState(state);
  await runtime.writeState(state);
  return { result, instanceId: runtime.instanceId };
};

const readState = async (
  options: Pick<CommandOptions, "instance" | "configPath">,
): Promise<{ state: RealityAlignmentState; instanceId: string }> => {
  const { instance } = requireInstance(options);
  const runtime = await resolveToolRuntime(instance, options.configPath);
  return { state: await runtime.readState(), instanceId: runtime.instanceId };
};

export interface WishAddResult extends InstanceContext {
  wish: Wish;
}
export const wishAdd = async (options: CommandOptions): Promise<WishAddResult> => {
  const title = ensureNonEmptyString(options.title, "--title");
  const { result, instanceId } = await mutateState(options, (state) =>
    addWish(state, {
      title,
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.desiredLevel !== undefined ? { desiredLevel: options.desiredLevel } : {}),
    }),
  );
  return { instanceId, wish: result };
};

export interface WishListResult extends InstanceContext {
  wishes: Wish[];
}
export const wishList = async (options: CommandOptions): Promise<WishListResult> => {
  const { state, instanceId } = await readState(options);
  return { instanceId, wishes: state.wishes.slice() };
};

export interface WishShowResult extends InstanceContext {
  wish: Wish;
}
export const wishShow = async (options: CommandOptions): Promise<WishShowResult> => {
  const query = ensureNonEmptyString(options.query, "--query");
  const { state, instanceId } = await readState(options);
  const wish = findWish(state, query);
  if (wish === undefined) {
    throw new Error(`No wish matched '${query}'`);
  }
  return { instanceId, wish };
};

export const wishArchive = async (options: CommandOptions): Promise<WishShowResult> => {
  const query = ensureNonEmptyString(options.query, "--query");
  const { result, instanceId } = await mutateState(options, (state) =>
    setWishStatus(state, query, "archived"),
  );
  return { instanceId, wish: result };
};

export const wishComplete = async (options: CommandOptions): Promise<WishShowResult> => {
  const query = ensureNonEmptyString(options.query, "--query");
  const { result, instanceId } = await mutateState(options, (state) =>
    setWishStatus(state, query, "completed"),
  );
  return { instanceId, wish: result };
};

export const wishPause = async (options: CommandOptions): Promise<WishShowResult> => {
  const query = ensureNonEmptyString(options.query, "--query");
  const { result, instanceId } = await mutateState(options, (state) =>
    setWishStatus(state, query, "paused"),
  );
  return { instanceId, wish: result };
};

export interface CheckinAddResult extends InstanceContext {
  checkin: AlignmentCheckin;
}
export const checkinAdd = async (options: CommandOptions): Promise<CheckinAddResult> => {
  const energy = clampScore(options.energy);
  const clarity = clampScore(options.clarity);
  const congruence = clampScore(options.congruence);
  const resistance = clampScore(options.resistance);
  const linkedWishIds: string[] = [];
  const { result, instanceId } = await mutateState(options, (state) => {
    if (options.wish !== undefined && options.wish.trim().length > 0) {
      const wish = findWish(state, options.wish);
      if (wish !== undefined) {
        linkedWishIds.push(wish.id);
      }
    }
    return addCheckin(state, {
      energy,
      clarity,
      congruence,
      resistance,
      ...(options.level !== undefined ? { level: options.level } : {}),
      ...(options.note !== undefined ? { note: options.note } : {}),
      linkedWishIds,
    });
  });
  return { instanceId, checkin: result };
};

export interface CheckinListResult extends InstanceContext {
  checkins: AlignmentCheckin[];
}
export const checkinList = async (options: CommandOptions): Promise<CheckinListResult> => {
  const { state, instanceId } = await readState(options);
  const checkins = state.checkins
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { instanceId, checkins };
};

export interface CheckinLatestResult extends InstanceContext {
  checkin: AlignmentCheckin | undefined;
}
export const checkinLatest = async (options: CommandOptions): Promise<CheckinLatestResult> => {
  const { state, instanceId } = await readState(options);
  return { instanceId, checkin: latestCheckin(state) };
};

export interface ResistanceAddResult extends InstanceContext {
  pattern: ResistancePattern;
  created: boolean;
}
export const resistanceAdd = async (options: CommandOptions): Promise<ResistanceAddResult> => {
  const label = ensureNonEmptyString(options.label, "--label");
  const { result, instanceId } = await mutateState(options, (state) =>
    upsertResistance(state, {
      label,
      ...(options.description !== undefined ? { description: options.description } : {}),
    }),
  );
  return { instanceId, pattern: result.pattern, created: result.created };
};

export interface ResistanceListResult extends InstanceContext {
  resistance: ResistancePattern[];
}
export const resistanceList = async (options: CommandOptions): Promise<ResistanceListResult> => {
  const { state, instanceId } = await readState(options);
  const resistance = state.resistance
    .slice()
    .sort((left, right) => right.recurrenceCount - left.recurrenceCount);
  return { instanceId, resistance };
};

export interface ResistanceResolveResult extends InstanceContext {
  pattern: ResistancePattern;
}
export const resistanceResolve = async (
  options: CommandOptions,
): Promise<ResistanceResolveResult> => {
  const query = ensureNonEmptyString(options.query, "--query");
  const { result, instanceId } = await mutateState(options, (state) =>
    resolveResistance(state, query),
  );
  return { instanceId, pattern: result };
};

export interface StepNextResult extends InstanceContext {
  step: ActionStep;
  wish: Wish;
}
export const stepNext = async (options: CommandOptions): Promise<StepNextResult> => {
  const { result, instanceId } = await mutateState(options, (state) => {
    const step = generateNextStep(state, {
      ...(options.wish !== undefined ? { wishQuery: options.wish } : {}),
    });
    const wish = state.wishes.find((entry) => entry.id === step.linkedWishId);
    /* v8 ignore next 3 -- generateNextStep guarantees a linked wish */
    if (wish === undefined) {
      throw new Error("Linked wish missing for generated step");
    }
    return { step, wish };
  });
  return { instanceId, step: result.step, wish: result.wish };
};

export interface StepListResult extends InstanceContext {
  steps: ActionStep[];
}
export const stepList = async (options: CommandOptions): Promise<StepListResult> => {
  const { state, instanceId } = await readState(options);
  return { instanceId, steps: openStepsEntity(state) };
};

export interface StepCompleteResult extends InstanceContext {
  step: ActionStep;
}
export const stepComplete = async (options: CommandOptions): Promise<StepCompleteResult> => {
  const query = ensureNonEmptyString(options.query, "--query");
  const { result, instanceId } = await mutateState(options, (state) =>
    completeStepEntity(state, query),
  );
  return { instanceId, step: result };
};

export interface ReviewWeeklyResult extends InstanceContext {
  review: WeeklyReview;
  formatted: string;
}
export const reviewWeekly = async (options: CommandOptions): Promise<ReviewWeeklyResult> => {
  const { state, instanceId } = await readState(options);
  const review = buildWeeklyReview(state);
  return { instanceId, review, formatted: formatWeeklyReview(review) };
};

export interface LevelNextResult extends InstanceContext {
  exercise: NextHigherStateExercise;
}
export const levelNext = async (options: CommandOptions): Promise<LevelNextResult> => {
  const { state, instanceId } = await readState(options);
  const exercise = buildNextHigherStateExercise(state, {
    ...(options.level !== undefined ? { level: options.level } : {}),
  });
  return { instanceId, exercise };
};

const requireActiveWish = (state: RealityAlignmentState, query: string): Wish => {
  const wish = findWish(state, query);
  if (wish === undefined) {
    throw new Error(`No wish matched '${query}'`);
  }
  if (wish.status !== "active") {
    throw new Error(`Wish '${wish.title}' is not active (status: ${wish.status})`);
  }
  return wish;
};

export interface ActAsIfResult extends InstanceContext {
  exercise: MagicalActionExercise;
}
export const actAsIf = async (options: CommandOptions): Promise<ActAsIfResult> => {
  const query = ensureNonEmptyString(options.query, "--query");
  const { state, instanceId } = await readState(options);
  const wish = requireActiveWish(state, query);
  return { instanceId, exercise: buildMagicalActionExercise(wish) };
};

export interface FutureSelfResult extends InstanceContext {
  exercise: FutureSelfExercise;
}
export const futureSelf = async (options: CommandOptions): Promise<FutureSelfResult> => {
  const query = ensureNonEmptyString(options.query, "--query");
  const { state, instanceId } = await readState(options);
  const wish = requireActiveWish(state, query);
  return { instanceId, exercise: buildFutureSelfExercise(wish) };
};

export interface AppreciationResult extends InstanceContext {
  exercise: AppreciationExercise;
}
export const appreciation = async (options: CommandOptions): Promise<AppreciationResult> => {
  const { instanceId } = await readState(options);
  return { instanceId, exercise: buildAppreciationExercise() };
};

export interface Look20sResult extends InstanceContext {
  exercise: TwentySecondLookExercise;
}
export const look20s = async (options: CommandOptions): Promise<Look20sResult> => {
  const { instanceId } = await readState(options);
  return { instanceId, exercise: buildTwentySecondLookExercise() };
};
