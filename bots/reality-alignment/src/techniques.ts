// Dodson techniques exposed as structured exercise cards. The
// procedures and quoted lines are taken verbatim from the operator's
// extraction of "Parallel Universes of Infinite Self" and "Levels of
// Energy" so the bot delivers Dodson's actual phrasing rather than
// paraphrase.

import { latestCheckin } from "./checkins.js";
import { type DodsonLevel, nearestNamedLevel, nextHigherStep } from "./levels.js";
import type { RealityAlignmentState, Wish } from "./types.js";

export interface TechniqueExercise {
  // Stable identifier for this exercise type. Useful for linking
  // future ActionStep entries back to the technique that generated
  // them once we add that.
  technique: string;
  title: string;
  // Optional one-line context above the steps (e.g. the wish title or
  // current level). Rendered before the numbered steps.
  context?: string | undefined;
  steps: string[];
  // Optional Dodson quotes, surfaced after the steps so the operator
  // sees his own phrasing.
  quotes: string[];
  // Source citation (book + chapter/page) for the technique.
  source: string;
  // Optional guardrail line (Dodson's "do not / be careful with X").
  guardrail?: string | undefined;
}

export interface NextHigherStateExercise extends TechniqueExercise {
  technique: "practicing-the-next-higher-state";
  current: DodsonLevel;
  oneStep: DodsonLevel | undefined;
  twoSteps: DodsonLevel | undefined;
}

// "Practicing the next higher state" — Levels of Energy, ch. 2,
// PDF p. 36-37. Walks the operator one or two levels up from the
// state recorded on the most recent check-in. Falls back to a
// neutral starting point when no check-in exists or no level was
// recorded on it.
export const buildNextHigherStateExercise = (
  state: RealityAlignmentState,
  options: { level?: number | undefined } = {},
): NextHigherStateExercise => {
  const explicit = options.level;
  const fromCheckin = latestCheckin(state)?.level;
  const sourceLevel = explicit ?? fromCheckin;
  const baselineLevel = sourceLevel ?? 100; // fear, Dodson's example baseline
  const next = nextHigherStep(baselineLevel);
  const targetLine = (() => {
    if (next.oneStep === undefined) {
      return `Current state: ${next.current.label}. You are at the top of the named scale; the move from here is to rest there, not climb.`;
    }
    if (next.twoSteps === undefined) {
      return `Current state: ${next.current.label}. Aim one step higher: ${next.oneStep.label}.`;
    }
    return `Current state: ${next.current.label}. Aim one step higher: ${next.oneStep.label} (or two: ${next.twoSteps.label}).`;
  })();
  const contextLine = (() => {
    if (explicit !== undefined) {
      return `${targetLine} (Level ${explicit}.)`;
    }
    if (fromCheckin !== undefined) {
      return `${targetLine} (Level ${fromCheckin} from latest check-in.)`;
    }
    return `${targetLine} (No level recorded on the latest check-in; using fear as Dodson's example baseline.)`;
  })();
  return {
    technique: "practicing-the-next-higher-state",
    title: "Practicing the next higher state",
    context: contextLine,
    steps: [
      "Think of something you dread or fear.",
      "Welcome that feeling fully. Allow it.",
      "Ask: What thought or action causes that feeling?",
      "Ask: And what thought or action would I like to take instead?",
      "Then release your focus from those thoughts.",
      next.oneStep === undefined
        ? "Rest in the named state without trying to push higher."
        : `Focus on ${next.oneStep.label}. Either think of something that brings ${next.oneStep.label} up, or purposefully generate ${next.oneStep.label} at the thing that was causing fear.`,
      "Beat the drum of it by thinking about it or talking about it.",
    ],
    quotes: [
      '"Do not try getting on a carousel ride that is spinning too fast."',
      '"When aiming to uplift others neither take in too high of a state nor the same."',
    ],
    source: "Levels of Energy, ch. 2, PDF p. 36–37.",
    guardrail:
      'Dodson: "If you cant find anything, then disregard this. You don\'t have to descend just so you can do the exercise." Aim one or two steps higher only — do not jump far above your current state.',
    current: next.current,
    oneStep: next.oneStep,
    twoSteps: next.twoSteps,
  };
};

export interface MagicalActionExercise extends TechniqueExercise {
  technique: "magical-action";
  wish: Wish;
}

// "Magical Action" — Parallel Universes, ch. 12, p. 196-197. The
// 10-question act-as-if procedure. Scoped to a specific wish.
export const buildMagicalActionExercise = (wish: Wish): MagicalActionExercise => {
  const desiredLevelLine = (() => {
    if (wish.desiredLevel === undefined) {
      return `Wish: "${wish.title}".`;
    }
    const named = nearestNamedLevel(wish.desiredLevel);
    return `Wish: "${wish.title}". Desired level: ${wish.desiredLevel} (~${named.label}).`;
  })();
  return {
    technique: "magical-action",
    title: "Magical Action (act as if)",
    context: desiredLevelLine,
    steps: [
      `Take a piece of paper. The reality you are working with: "${wish.title}".`,
      "Answer each of the following with: If this reality were already true...",
      "1. What places would I be at?",
      "2. What type of people would I meet?",
      "3. How would I dress?",
      "4. What body movements would I be doing?",
      "5. What material objects and equipment would I be touching and handling?",
      "6. How and what would I be conversing and talking about?",
      "7. What interests would I have?",
      "8. What would I be doing?",
      "9. What other symbols and things correspond to this reality?",
      "Pick one answer above and act on it today, however small the act.",
    ],
    quotes: [
      '"This exercise corresponds with the type three action, the acting-as-if-something were already true."',
      '"Life reflects who you are."',
    ],
    source: "Parallel Universes of Infinite Self, ch. 12, p. 196–197.",
    guardrail:
      'Dodson: "Be courageous and demonstrate to yourself, others and the universe who you are."',
    wish,
  };
};

export interface FutureSelfExercise extends TechniqueExercise {
  technique: "future-into-present-2";
  wish: Wish;
}

// "Future into Present 2" — Parallel Universes, ch. 6, p. 80.
// Consults a wise future version of yourself for guidance on the
// chosen wish.
export const buildFutureSelfExercise = (wish: Wish): FutureSelfExercise => ({
  technique: "future-into-present-2",
  title: "Future-self consultation",
  context: `Wish: "${wish.title}".`,
  steps: [
    "Imagine a wise, more expanded, loving and powerful version of yourself in the future.",
    "Use 10, 50, 100, 1000 or more years.",
    `Ask this version-of-you a specific question about "${wish.title}" and let him/her answer you.`,
    "Or let this version-of-you provide guidance.",
    "Or identify with this version of you right now.",
  ],
  quotes: [
    '"Imagine a wise, more expanded, loving and powerful version of yourself in the future."',
    '"No need to wait a thousand years."',
  ],
  source: "Parallel Universes of Infinite Self, ch. 6, p. 80.",
  wish,
});

export interface AppreciationExercise extends TechniqueExercise {
  technique: "appreciation";
}

// "Appreciation" — Parallel Universes, ch. 8, p. 99-100. The walk
// + write procedure. Stateless; not scoped to a wish.
export const buildAppreciationExercise = (): AppreciationExercise => ({
  technique: "appreciation",
  title: "Appreciation",
  steps: [
    "Take a walk somewhere, and spot as many things as you can that you can say YES to.",
    "Ignore anything you would say NO to.",
    "Silently acknowledge, bless, admire and appreciate them.",
    "Write down things, people, places, cultures, events, memories, thoughts, fantasies, locations, books, movies, music, art, cities, objects that you appreciate.",
    "Write down a few people or things you don't like, then write the ASPECTS you DO or CAN appreciate about them.",
  ],
  quotes: [
    '"Feeling appreciation while having your attention on something equals channelling higher dimensional energy into physical reality."',
    '"Appreciation in this sense has nothing to do with the pretence of putting on a happy face."',
  ],
  source: "Parallel Universes of Infinite Self, ch. 8, p. 99–100.",
  guardrail:
    'Dodson: "Do not mention anything that you don\'t want." "The universe is inclusive not exclusive." Do not practice this for the sake of getting something or manifesting something.',
});

export interface TwentySecondLookExercise extends TechniqueExercise {
  technique: "twenty-second-look";
}

// "The 20 Second Look" — Parallel Universes, ch. 9, p. 155.
// Quickest state-shift in the set. Stateless.
export const buildTwentySecondLookExercise = (): TwentySecondLookExercise => ({
  technique: "twenty-second-look",
  title: "The 20-second look",
  steps: [
    "Look at something nice — out there or in here.",
    "Look at it for about 20 seconds.",
    "Then let go.",
    "Either focus the next nice thing for 20 seconds, and the next, until you get into a very positive flow — or take a break from focussing and enjoy your rapidly changed state.",
  ],
  quotes: [
    '"20 seconds is what is needed to start getting into vibratory synchrony with something and feeling it."',
    '"What you look at grows."',
  ],
  source: "Parallel Universes of Infinite Self, ch. 9, p. 155.",
  guardrail:
    'Dodson: "20 seconds is too short to let doubts and second-thoughts come up." You don\'t need a stop watch. Things that FORCE themselves into your view repeatedly would need some attention — that is a separate move from this one.',
});
