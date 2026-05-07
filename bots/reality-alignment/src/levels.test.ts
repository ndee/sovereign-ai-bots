import { describe, expect, it } from "vitest";

import {
  DODSON_LEVELS,
  MAX_LEVEL,
  MIN_LEVEL,
  nearestNamedLevel,
  nextHigherStep,
  validateLevel,
} from "./levels.js";

describe("reality-alignment/levels", () => {
  it("validates and rounds finite numbers within the scale range", () => {
    expect(validateLevel(0)).toBe(MIN_LEVEL);
    expect(validateLevel(1000)).toBe(MAX_LEVEL);
    expect(validateLevel(199.6)).toBe(200);
    expect(() => validateLevel(Number.NaN)).toThrow("finite number");
    expect(() => validateLevel(Number.POSITIVE_INFINITY)).toThrow("finite number");
    expect(() => validateLevel(-1)).toThrow(`between ${MIN_LEVEL} and ${MAX_LEVEL}`);
    expect(() => validateLevel(1001)).toThrow(`between ${MIN_LEVEL} and ${MAX_LEVEL}`);
  });

  it("snaps any level to the nearest named anchor", () => {
    expect(nearestNamedLevel(100).label).toBe("fear");
    expect(nearestNamedLevel(110).label).toBe("fear");
    expect(nearestNamedLevel(140).label).toBe("anger");
    expect(nearestNamedLevel(0).label).toBe("shame");
    expect(nearestNamedLevel(1000).label).toBe("enlightenment");
  });

  it("returns the named anchor at-or-below current and the next two above", () => {
    const fromFear = nextHigherStep(100);
    expect(fromFear.current.label).toBe("fear");
    expect(fromFear.oneStep?.label).toBe("desire");
    expect(fromFear.twoSteps?.label).toBe("anger");

    const fromCourage = nextHigherStep(200);
    expect(fromCourage.current.label).toBe("courage");
    expect(fromCourage.oneStep?.label).toBe("neutrality");
    expect(fromCourage.twoSteps?.label).toBe("willingness");

    const belowFirst = nextHigherStep(10);
    expect(belowFirst.current.label).toBe("shame");
    expect(belowFirst.oneStep?.label).toBe("guilt");

    const atTop = nextHigherStep(1000);
    expect(atTop.current.label).toBe("enlightenment");
    expect(atTop.oneStep).toBeUndefined();
    expect(atTop.twoSteps).toBeUndefined();
  });

  it("exposes a non-empty ordered scale", () => {
    expect(DODSON_LEVELS.length).toBeGreaterThan(0);
    for (let index = 1; index < DODSON_LEVELS.length; index += 1) {
      const previous = DODSON_LEVELS[index - 1];
      const current = DODSON_LEVELS[index];
      expect(previous?.value).toBeLessThan(current?.value ?? Number.NaN);
    }
  });
});
