import { describe, expect, it } from "vitest";

import { addCheckin } from "./checkins.js";
import { upsertResistance } from "./resistance.js";
import { createDefaultState } from "./state.js";
import { completeStep, findStep, generateNextStep, openSteps } from "./steps.js";
import type { RealityAlignmentState } from "./types.js";
import { addWish, setWishStatus } from "./wishes.js";

const stateWithWish = (
  title = "Move toward Indonesia",
): { state: RealityAlignmentState; wishId: string } => {
  const state = createDefaultState();
  const wish = addWish(state, { title });
  return { state, wishId: wish.id };
};

describe("reality-alignment/steps", () => {
  it("returns no steps when state has none and finds steps by id and substring", () => {
    const { state, wishId } = stateWithWish();
    expect(findStep(state, "  ")).toBeUndefined();
    expect(findStep(state, "missing")).toBeUndefined();
    const step = generateNextStep(state, { wishQuery: wishId });
    expect(findStep(state, step.id)).toBe(step);
    expect(findStep(state, step.title.split(" ")[0] ?? step.title.slice(0, 5))).toBe(step);
  });

  it("requires an active wish and rejects unknown or non-active queries", () => {
    const { state, wishId } = stateWithWish();
    expect(() => generateNextStep(createDefaultState())).toThrow(
      "No active wishes. Add a wish first with `wish add`.",
    );
    expect(() => generateNextStep(state, { wishQuery: "unknown" })).toThrow(
      "No wish matched 'unknown'",
    );
    setWishStatus(state, wishId, "paused");
    expect(() => generateNextStep(state, { wishQuery: wishId })).toThrow(
      "is not active (status: paused)",
    );
  });

  it("falls back to most recently updated active wish when no query is given", async () => {
    const state = createDefaultState();
    const older = addWish(state, { title: "Older wish" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = addWish(state, { title: "Newer wish" });
    const step = generateNextStep(state);
    expect(step.linkedWishId).toBe(newer.id);
    expect(older).toBeDefined();
    // empty wishQuery acts like "no wish provided"
    const next = generateNextStep(state, { wishQuery: "   " });
    expect(next.linkedWishId).toBe(newer.id);
  });

  it("drafts a low-clarity step", () => {
    const { state, wishId } = stateWithWish();
    addCheckin(state, { energy: 3, clarity: 2, congruence: 3, resistance: 3 });
    const step = generateNextStep(state, { wishQuery: wishId });
    expect(step.title).toMatch(/clearest one-sentence/);
    expect(step.rationale).toMatch(/low clarity/);
  });

  it("drafts a high-resistance step using a linked recurring pattern", () => {
    const { state, wishId } = stateWithWish();
    addCheckin(state, { energy: 4, clarity: 4, congruence: 4, resistance: 5 });
    upsertResistance(state, { label: "fear", linkedWishIds: [wishId] });
    upsertResistance(state, { label: "fear", linkedWishIds: [wishId] });
    const step = generateNextStep(state, { wishQuery: wishId });
    expect(step.title).toMatch(/fear/);
    expect(step.rationale).toMatch(/Resistance is high/);
  });

  it("drafts a high-resistance step with a generic label when no recurrence is linked", () => {
    const { state, wishId } = stateWithWish();
    addCheckin(state, { energy: 4, clarity: 4, congruence: 4, resistance: 4 });
    const step = generateNextStep(state, { wishQuery: wishId });
    expect(step.title).toMatch(/the resistance you feel right now/);
  });

  it("drafts a low-energy step", () => {
    const { state, wishId } = stateWithWish();
    addCheckin(state, { energy: 1, clarity: 4, congruence: 4, resistance: 1 });
    const step = generateNextStep(state, { wishQuery: wishId });
    expect(step.title).toMatch(/smallest 10-minute action/);
  });

  it("drafts a low-congruence step", () => {
    const { state, wishId } = stateWithWish();
    addCheckin(state, { energy: 3, clarity: 4, congruence: 2, resistance: 1 });
    const step = generateNextStep(state, { wishQuery: wishId });
    expect(step.title).toMatch(/feels out of sync/);
  });

  it("drafts a recurring-resistance step when no check-in dimension dominates", () => {
    const { state, wishId } = stateWithWish();
    addCheckin(state, { energy: 4, clarity: 4, congruence: 4, resistance: 1 });
    upsertResistance(state, { label: "delay" });
    upsertResistance(state, { label: "delay" });
    const step = generateNextStep(state, { wishQuery: wishId });
    expect(step.title).toMatch(/Block 20 minutes to face "delay"/);
    expect(step.rationale).toMatch(/Recurring resistance: delay/);
  });

  it("drafts a generic 20-minute action when no signal is strong", () => {
    const { state, wishId } = stateWithWish();
    const step = generateNextStep(state, { wishQuery: wishId });
    expect(step.title).toMatch(/20-minute action/);
  });

  it("lists open steps and completes a step by id or substring", () => {
    const { state, wishId } = stateWithWish();
    const step = generateNextStep(state, { wishQuery: wishId });
    expect(openSteps(state)).toHaveLength(1);
    const completed = completeStep(state, step.id);
    expect(completed.status).toBe("done");
    expect(completed.completedAt).toBeDefined();
    expect(openSteps(state)).toHaveLength(0);
    expect(() => completeStep(state, "missing")).toThrow("No step matched 'missing'");
  });
});
