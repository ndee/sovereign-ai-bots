import { describe, expect, it } from "vitest";

import { addCheckin } from "./checkins.js";
import { createDefaultState } from "./state.js";
import {
  buildAppreciationExercise,
  buildFutureSelfExercise,
  buildMagicalActionExercise,
  buildNextHigherStateExercise,
  buildTwentySecondLookExercise,
} from "./techniques.js";
import { addWish } from "./wishes.js";

describe("reality-alignment/techniques", () => {
  it("builds the next-higher-state exercise from the explicit level option", () => {
    const state = createDefaultState();
    const exercise = buildNextHigherStateExercise(state, { level: 100 });
    expect(exercise.technique).toBe("practicing-the-next-higher-state");
    expect(exercise.current.label).toBe("fear");
    expect(exercise.oneStep?.label).toBe("desire");
    expect(exercise.context).toMatch(/Aim one step higher: desire/);
    expect(exercise.context).toMatch(/Level 100/);
    expect(exercise.steps[0]).toBe("Think of something you dread or fear.");
    expect(exercise.source).toMatch(/Levels of Energy/);
    expect(exercise.guardrail).toMatch(/one or two steps higher only/);
  });

  it("falls back to the latest check-in level when no option is given", () => {
    const state = createDefaultState();
    addCheckin(state, { energy: 3, clarity: 3, congruence: 3, resistance: 3, level: 200 });
    const exercise = buildNextHigherStateExercise(state);
    expect(exercise.current.label).toBe("courage");
    expect(exercise.context).toMatch(/Level 200 from latest check-in/);
  });

  it("falls back to fear when no check-in level is recorded", () => {
    const state = createDefaultState();
    const exercise = buildNextHigherStateExercise(state);
    expect(exercise.current.label).toBe("fear");
    expect(exercise.context).toMatch(/example baseline/);
  });

  it("special-cases the top of the scale and aims one step only at the second-to-top", () => {
    const state = createDefaultState();
    const top = buildNextHigherStateExercise(state, { level: 1000 });
    expect(top.oneStep).toBeUndefined();
    expect(top.twoSteps).toBeUndefined();
    expect(top.context).toMatch(/top of the named scale/);
    const peace = buildNextHigherStateExercise(state, { level: 600 });
    expect(peace.oneStep?.label).toBe("enlightenment");
    expect(peace.twoSteps).toBeUndefined();
    expect(peace.context).toMatch(/Aim one step higher: enlightenment\./);
  });

  it("builds the magical-action exercise scoped to a wish, surfacing the desired level when set", () => {
    const state = createDefaultState();
    const wish = addWish(state, { title: "Live in joy", desiredLevel: 540 });
    const exercise = buildMagicalActionExercise(wish);
    expect(exercise.technique).toBe("magical-action");
    expect(exercise.context).toMatch(/Live in joy/);
    expect(exercise.context).toMatch(/Desired level: 540 \(~joy\)/);
    expect(exercise.steps).toContain(
      "9. What other symbols and things correspond to this reality?",
    );
    expect(exercise.source).toMatch(/Parallel Universes/);
  });

  it("omits the desired-level line when the wish has no level set", () => {
    const state = createDefaultState();
    const wish = addWish(state, { title: "Ship the thing" });
    const exercise = buildMagicalActionExercise(wish);
    expect(exercise.context).toBe('Wish: "Ship the thing".');
  });

  it("builds the future-self exercise scoped to a wish", () => {
    const state = createDefaultState();
    const wish = addWish(state, { title: "Build calm" });
    const exercise = buildFutureSelfExercise(wish);
    expect(exercise.technique).toBe("future-into-present-2");
    expect(exercise.context).toMatch(/Build calm/);
    expect(exercise.steps[0]).toMatch(/wise, more expanded, loving and powerful/);
  });

  it("builds the appreciation exercise without scoping", () => {
    const exercise = buildAppreciationExercise();
    expect(exercise.technique).toBe("appreciation");
    expect(exercise.context).toBeUndefined();
    expect(exercise.guardrail).toMatch(/Do not practice this for the sake of getting something/);
  });

  it("builds the 20-second-look exercise without scoping", () => {
    const exercise = buildTwentySecondLookExercise();
    expect(exercise.technique).toBe("twenty-second-look");
    expect(exercise.steps).toContain("Look at it for about 20 seconds.");
    expect(exercise.guardrail).toMatch(/short to let doubts/);
  });
});
