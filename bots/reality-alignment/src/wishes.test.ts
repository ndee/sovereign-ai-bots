import { describe, expect, it } from "vitest";

import { createDefaultState } from "./state.js";
import type { RealityAlignmentState } from "./types.js";
import { activeWishes, addWish, findWish, setWishDesiredLevel, setWishStatus } from "./wishes.js";

const baseState = (): RealityAlignmentState => createDefaultState();

describe("reality-alignment/wishes", () => {
  it("adds wishes with default active status", () => {
    const state = baseState();
    const wish = addWish(state, { title: " Move to Indonesia ", description: "calm path" });
    expect(wish.title).toBe("Move to Indonesia");
    expect(wish.description).toBe("calm path");
    expect(wish.status).toBe("active");
    expect(wish.createdAt).toBe(wish.updatedAt);
    expect(state.wishes).toHaveLength(1);
  });

  it("rejects empty wish titles", () => {
    expect(() => addWish(baseState(), { title: "   " })).toThrow(
      "Expected a non-empty value for title",
    );
  });

  it("finds wishes by id, exact title, and substring; returns undefined for empty queries", () => {
    const state = baseState();
    addWish(state, { title: "Build a calm path" });
    addWish(state, { title: "Other thing entirely" });
    expect(findWish(state, "")).toBeUndefined();
    expect(findWish(state, "missing")).toBeUndefined();
    const target = state.wishes[0];
    expect(target).toBeDefined();
    expect(findWish(state, target?.id ?? "")).toBe(target);
    expect(findWish(state, "build a calm path")).toBe(target);
    expect(findWish(state, "calm")).toBe(target);
  });

  it("changes wish status and timestamps", async () => {
    const state = baseState();
    const wish = addWish(state, { title: "Ship MVP" });
    const created = wish.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = setWishStatus(state, wish.id, "completed");
    expect(updated.status).toBe("completed");
    expect(updated.updatedAt > created).toBe(true);
  });

  it("throws when status target cannot be matched", () => {
    expect(() => setWishStatus(baseState(), "nope", "archived")).toThrow("No wish matched 'nope'");
  });

  it("filters active wishes", () => {
    const state = baseState();
    addWish(state, { title: "Wish one" });
    addWish(state, { title: "Wish two" });
    setWishStatus(state, "Wish one", "archived");
    expect(activeWishes(state).map((wish) => wish.title)).toEqual(["Wish two"]);
  });

  it("accepts and validates a desired level on add", () => {
    const state = baseState();
    const wish = addWish(state, { title: "Live in joy", desiredLevel: 540 });
    expect(wish.desiredLevel).toBe(540);
    expect(() => addWish(state, { title: "Out of range", desiredLevel: 2000 })).toThrow(
      "Level must be between 0 and 1000",
    );
  });

  it("updates the desired level after creation", async () => {
    const state = baseState();
    const wish = addWish(state, { title: "Live in joy" });
    const before = wish.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = setWishDesiredLevel(state, wish.id, 500);
    expect(updated.desiredLevel).toBe(500);
    expect(updated.updatedAt > before).toBe(true);
    expect(() => setWishDesiredLevel(state, "missing", 500)).toThrow("No wish matched 'missing'");
  });
});
