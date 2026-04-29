import { describe, expect, it } from "vitest";

import {
  findResistance,
  recurringResistance,
  resolveResistance,
  upsertResistance,
} from "./resistance.js";
import { createDefaultState } from "./state.js";

describe("reality-alignment/resistance", () => {
  it("creates new patterns and rejects empty labels", () => {
    const state = createDefaultState();
    const result = upsertResistance(state, {
      label: " overthinking ",
      description: "loops",
      linkedWishIds: ["w1"],
    });
    expect(result.created).toBe(true);
    expect(result.pattern.label).toBe("overthinking");
    expect(result.pattern.description).toBe("loops");
    expect(result.pattern.recurrenceCount).toBe(1);
    expect(() => upsertResistance(state, { label: "  " })).toThrow(
      "Expected a non-empty value for label",
    );
  });

  it("increments recurrence on repeat and reactivates archived/reduced patterns", () => {
    const state = createDefaultState();
    upsertResistance(state, { label: "delay" });
    const initial = state.resistance[0];
    if (initial === undefined) throw new Error("expected initial pattern");
    initial.status = "archived";
    const second = upsertResistance(state, {
      label: "delay",
      description: "still delaying",
      linkedWishIds: ["w1"],
    });
    expect(second.created).toBe(false);
    expect(second.pattern.status).toBe("active");
    expect(second.pattern.recurrenceCount).toBe(2);
    expect(second.pattern.description).toBe("still delaying");
    expect(second.pattern.linkedWishIds).toEqual(["w1"]);

    const third = upsertResistance(state, {
      label: "delay",
      description: "   ",
      linkedWishIds: ["w1", "w2"],
    });
    expect(third.pattern.linkedWishIds).toEqual(["w1", "w2"]);
    expect(third.pattern.description).toBe("still delaying");
  });

  it("finds patterns by id and label, returns undefined for empty queries", () => {
    const state = createDefaultState();
    expect(findResistance(state, "  ")).toBeUndefined();
    upsertResistance(state, { label: "fear" });
    const target = state.resistance[0];
    if (target === undefined) throw new Error("expected pattern");
    expect(findResistance(state, target.id)).toBe(target);
    expect(findResistance(state, "FEAR")).toBe(target);
    expect(findResistance(state, "missing")).toBeUndefined();
  });

  it("resolves patterns to reduced status", () => {
    const state = createDefaultState();
    upsertResistance(state, { label: "doubt" });
    const resolved = resolveResistance(state, "doubt");
    expect(resolved.status).toBe("reduced");
    expect(() => resolveResistance(state, "unknown")).toThrow(
      "No resistance pattern matched 'unknown'",
    );
  });

  it("returns recurring active patterns sorted by count", () => {
    const state = createDefaultState();
    upsertResistance(state, { label: "a" });
    upsertResistance(state, { label: "a" });
    upsertResistance(state, { label: "a" });
    upsertResistance(state, { label: "b" });
    upsertResistance(state, { label: "b" });
    upsertResistance(state, { label: "c" });
    const recurring = recurringResistance(state);
    expect(recurring.map((entry) => entry.label)).toEqual(["a", "b"]);
  });
});
