// Dodson's level/state scale, used by check-ins, wishes, and the
// "next higher state" technique. Numbers and labels follow how Dodson
// teaches the scale across his work; the constants are anchor points
// rather than an exhaustive enumeration. Operators are free to record
// any integer in [0, 1000] on a check-in or a wish; the helpers in
// this file map an arbitrary level to its nearest named anchor and
// suggest one and two steps higher per Dodson's "do not aim much
// higher than where you currently are" guardrail.

export interface DodsonLevel {
  value: number;
  label: string;
}

export const DODSON_LEVELS: readonly DodsonLevel[] = [
  { value: 20, label: "shame" },
  { value: 30, label: "guilt" },
  { value: 50, label: "apathy" },
  { value: 75, label: "grief" },
  { value: 100, label: "fear" },
  { value: 125, label: "desire" },
  { value: 150, label: "anger" },
  { value: 175, label: "pride" },
  { value: 200, label: "courage" },
  { value: 250, label: "neutrality" },
  { value: 310, label: "willingness" },
  { value: 350, label: "acceptance" },
  { value: 400, label: "reason" },
  { value: 500, label: "love" },
  { value: 540, label: "joy" },
  { value: 600, label: "peace" },
  { value: 700, label: "enlightenment" },
];

export const MIN_LEVEL = 0;
export const MAX_LEVEL = 1000;

export const validateLevel = (value: number): number => {
  if (!Number.isFinite(value)) {
    throw new Error("Level must be a finite number");
  }
  const rounded = Math.round(value);
  if (rounded < MIN_LEVEL || rounded > MAX_LEVEL) {
    throw new Error(`Level must be between ${MIN_LEVEL} and ${MAX_LEVEL}`);
  }
  return rounded;
};

export const nearestNamedLevel = (level: number): DodsonLevel => {
  const validated = validateLevel(level);
  let best: DodsonLevel = DODSON_LEVELS[0] as DodsonLevel;
  let bestDistance = Math.abs(validated - best.value);
  for (let index = 1; index < DODSON_LEVELS.length; index += 1) {
    const candidate = DODSON_LEVELS[index] as DodsonLevel;
    const distance = Math.abs(validated - candidate.value);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
};

export interface NextHigherStep {
  current: DodsonLevel;
  oneStep: DodsonLevel | undefined;
  twoSteps: DodsonLevel | undefined;
}

// Returns the named anchor at or below the given level (the operator's
// current named state) and the one and two anchors above it. Dodson's
// guidance is to aim one or two steps higher than current, never far
// above; consumers should prefer oneStep, falling back to twoSteps.
export const nextHigherStep = (level: number): NextHigherStep => {
  const validated = validateLevel(level);
  let currentIndex = 0;
  for (let index = 0; index < DODSON_LEVELS.length; index += 1) {
    const candidate = DODSON_LEVELS[index] as DodsonLevel;
    if (candidate.value <= validated) {
      currentIndex = index;
    } else {
      break;
    }
  }
  return {
    current: DODSON_LEVELS[currentIndex] as DodsonLevel,
    oneStep: DODSON_LEVELS[currentIndex + 1],
    twoSteps: DODSON_LEVELS[currentIndex + 2],
  };
};
