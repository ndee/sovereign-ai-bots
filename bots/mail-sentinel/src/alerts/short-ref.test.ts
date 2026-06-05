import { describe, expect, it } from "vitest";
import { SHORT_REF_START_LENGTH } from "../constants.js";
import { deriveShortRef, mintShortRef } from "./short-ref.js";

const UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

describe("alerts/short-ref", () => {
  describe("deriveShortRef", () => {
    it("returns the 6-char lowercase, dash-stripped prefix by default", () => {
      expect(deriveShortRef(UUID)).toBe("a1b2c3");
    });

    it("honors an explicit length", () => {
      expect(deriveShortRef(UUID, 8)).toBe("a1b2c3d4");
    });

    it("lowercases an upper-case alertId", () => {
      expect(deriveShortRef(UUID.toUpperCase())).toBe("a1b2c3");
    });

    it("falls back to the raw value when stripping dashes empties the pool", () => {
      expect(deriveShortRef("----", 2)).toBe("--");
    });

    it("clamps a zero/negative length to at least one char", () => {
      expect(deriveShortRef(UUID, 0)).toBe("a");
      expect(deriveShortRef(UUID, -5)).toBe("a");
    });

    it("returns the whole pool when length exceeds it", () => {
      expect(deriveShortRef("ab", 6)).toBe("ab");
    });
  });

  describe("mintShortRef", () => {
    it("mints the start-length prefix when no collision exists", () => {
      expect(mintShortRef(UUID, [])).toBe("a1b2c3");
      expect("a1b2c3").toHaveLength(SHORT_REF_START_LENGTH);
    });

    it("lengthens by one char on a collision", () => {
      expect(mintShortRef(UUID, ["a1b2c3"])).toBe("a1b2c3d");
    });

    it("lengthens repeatedly until the prefix is unique", () => {
      expect(mintShortRef(UUID, ["a1b2c3", "a1b2c3d", "a1b2c3d4"])).toBe("a1b2c3d4e");
    });

    it("compares case-insensitively against existing refs", () => {
      expect(mintShortRef(UUID, ["A1B2C3"])).toBe("a1b2c3d");
    });

    it("honors a custom start length", () => {
      expect(mintShortRef(UUID, [], 4)).toBe("a1b2");
    });

    it("returns the full pool when every prefix is already taken", () => {
      const pool = UUID.replace(/-/g, "").toLowerCase();
      const allPrefixes = Array.from({ length: pool.length }, (_, index) =>
        pool.slice(0, index + 1),
      );
      expect(mintShortRef(UUID, allPrefixes)).toBe(pool);
    });
  });
});
