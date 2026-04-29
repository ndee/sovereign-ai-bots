import { describe, expect, it } from "vitest";

import { addCheckin } from "./checkins.js";
import { upsertResistance } from "./resistance.js";
import { buildWeeklyReview, formatWeeklyReview } from "./review.js";
import { createDefaultState } from "./state.js";
import { generateNextStep } from "./steps.js";
import { addWish } from "./wishes.js";

describe("reality-alignment/review", () => {
  it("recommends defining a wish when none are active", () => {
    const review = buildWeeklyReview(createDefaultState());
    expect(review.activeWishes).toHaveLength(0);
    expect(review.focus).toMatch(/Define one active wish/);
    expect(review.recommendedNextStep).toMatch(/Add one active wish/);
    const formatted = formatWeeklyReview(review);
    expect(formatted).toMatch(/Recent check-ins: 0/);
    expect(formatted).toMatch(/Recurring resistance: none/);
  });

  it("targets clarity when averages drop below 2.5", () => {
    const state = createDefaultState();
    addWish(state, { title: "First" });
    addCheckin(state, { energy: 2, clarity: 2, congruence: 2, resistance: 2 });
    const review = buildWeeklyReview(state);
    expect(review.focus).toMatch(/Clarity is low/);
    expect(review.recommendedNextStep).toMatch(/Write the clearest one-sentence version/);
  });

  it("targets resistance when averages climb above 3.5", () => {
    const state = createDefaultState();
    addWish(state, { title: "First" });
    addCheckin(state, { energy: 4, clarity: 4, congruence: 4, resistance: 4 });
    const review = buildWeeklyReview(state);
    expect(review.focus).toMatch(/Resistance is high/);
  });

  it("surfaces the top recurring pattern when averages are unremarkable", () => {
    const state = createDefaultState();
    addWish(state, { title: "First" });
    addCheckin(state, { energy: 3, clarity: 3, congruence: 3, resistance: 3 });
    upsertResistance(state, { label: "delay" });
    upsertResistance(state, { label: "delay" });
    const review = buildWeeklyReview(state);
    expect(review.focus).toMatch(/Move past "delay"/);
    const formatted = formatWeeklyReview(review);
    expect(formatted).toMatch(/Recurring resistance: delay \(2\)/);
  });

  it("recommends moving from reflection to action when no steps are open", () => {
    const state = createDefaultState();
    addWish(state, { title: "First" });
    addCheckin(state, { energy: 3, clarity: 3, congruence: 3, resistance: 3 });
    const review = buildWeeklyReview(state);
    expect(review.focus).toMatch(/Move one active wish from reflection/);
  });

  it("surfaces an open step and the finish-over-plan focus when steps exist", () => {
    const state = createDefaultState();
    const wish = addWish(state, { title: "Ship" });
    addCheckin(state, { energy: 3, clarity: 3, congruence: 3, resistance: 3 });
    generateNextStep(state, { wishQuery: wish.id });
    const review = buildWeeklyReview(state);
    expect(review.focus).toMatch(/Finish over plan/);
    expect(review.recommendedNextStep).toBe(review.openSteps[0]?.title);
  });
});
