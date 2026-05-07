import { describe, expect, it } from "vitest";

import { addCheckin, averageScores, checkinsSince, latestCheckin } from "./checkins.js";
import { createDefaultState } from "./state.js";

describe("reality-alignment/checkins", () => {
  it("adds check-ins with optional note and linked wishes", () => {
    const state = createDefaultState();
    const checkin = addCheckin(state, {
      energy: 3,
      clarity: 4,
      congruence: 5,
      resistance: 2,
      note: " stuck ",
      linkedWishIds: ["w1"],
    });
    expect(checkin.note).toBe("stuck");
    expect(checkin.linkedWishIds).toEqual(["w1"]);
    expect(state.checkins).toHaveLength(1);
  });

  it("omits empty notes and defaults linked wishes to []", () => {
    const state = createDefaultState();
    const checkin = addCheckin(state, {
      energy: 1,
      clarity: 1,
      congruence: 1,
      resistance: 1,
      note: "   ",
    });
    expect(checkin.note).toBeUndefined();
    expect(checkin.linkedWishIds).toEqual([]);
    expect(checkin.level).toBeUndefined();
  });

  it("records and validates a level on add", () => {
    const state = createDefaultState();
    const checkin = addCheckin(state, {
      energy: 3,
      clarity: 3,
      congruence: 3,
      resistance: 3,
      level: 200,
    });
    expect(checkin.level).toBe(200);
    expect(() =>
      addCheckin(state, {
        energy: 3,
        clarity: 3,
        congruence: 3,
        resistance: 3,
        level: 1500,
      }),
    ).toThrow("Level must be between 0 and 1000");
  });

  it("returns the latest check-in or undefined when empty", () => {
    const state = createDefaultState();
    expect(latestCheckin(state)).toBeUndefined();
    addCheckin(state, { energy: 1, clarity: 1, congruence: 1, resistance: 1 });
    addCheckin(state, { energy: 5, clarity: 5, congruence: 5, resistance: 5 });
    const latest = state.checkins[1];
    expect(latestCheckin(state)).toBe(latest);
  });

  it("filters check-ins by ISO timestamp threshold", () => {
    const state = createDefaultState();
    state.checkins.push(
      {
        id: "old",
        date: "2026-04-20",
        energyScore: 3,
        clarityScore: 3,
        congruenceScore: 3,
        resistanceScore: 3,
        linkedWishIds: [],
        createdAt: "2026-04-20T10:00:00.000Z",
      },
      {
        id: "new",
        date: "2026-04-26",
        energyScore: 3,
        clarityScore: 3,
        congruenceScore: 3,
        resistanceScore: 3,
        linkedWishIds: [],
        createdAt: "2026-04-26T10:00:00.000Z",
      },
    );
    const recent = checkinsSince(state, "2026-04-25T00:00:00.000Z");
    expect(recent.map((entry) => entry.id)).toEqual(["new"]);
  });

  it("computes rounded averages and returns undefined for empty input", () => {
    expect(averageScores([])).toBeUndefined();
    const averages = averageScores([
      {
        id: "a",
        date: "2026-04-26",
        energyScore: 1,
        clarityScore: 2,
        congruenceScore: 3,
        resistanceScore: 4,
        linkedWishIds: [],
        createdAt: "2026-04-26T10:00:00.000Z",
      },
      {
        id: "b",
        date: "2026-04-26",
        energyScore: 2,
        clarityScore: 3,
        congruenceScore: 4,
        resistanceScore: 5,
        linkedWishIds: [],
        createdAt: "2026-04-26T11:00:00.000Z",
      },
    ]);
    expect(averages).toEqual({
      energy: 1.5,
      clarity: 2.5,
      congruence: 3.5,
      resistance: 4.5,
      count: 2,
    });
  });
});
