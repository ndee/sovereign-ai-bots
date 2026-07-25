import { describe, expect, it } from "vitest";

import {
  type BuildInfo,
  buildIdentityKey,
  getBuildInfo,
  isBuildIdentityComplete,
  readDefine,
  shortCommit,
  UNKNOWN_BUILD_VALUE,
} from "./build-info.js";

const COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

const makeInfo = (overrides: Partial<BuildInfo> = {}): BuildInfo => ({
  component: "mail-sentinel",
  version: "2.0.4-test.1",
  commit: COMMIT,
  releaseId: "2.9.2-test",
  buildTimestamp: "2026-07-25T14:32:00.000Z",
  ...overrides,
});

describe("build-info", () => {
  describe("readDefine", () => {
    it("keeps a substituted build value", () => {
      expect(readDefine("2.0.4-test.1")).toBe("2.0.4-test.1");
    });

    it("trims surrounding whitespace", () => {
      expect(readDefine("  2.0.4-test.1  ")).toBe("2.0.4-test.1");
    });

    it.each([
      ["undefined", undefined],
      ["null", null],
      ["a number", 42],
      ["an object", { version: "2.0.4" }],
    ])("falls back to unknown for %s rather than coercing it", (_label, value) => {
      expect(readDefine(value)).toBe(UNKNOWN_BUILD_VALUE);
    });

    it("treats an empty or whitespace-only value as unknown", () => {
      expect(readDefine("")).toBe(UNKNOWN_BUILD_VALUE);
      expect(readDefine("   ")).toBe(UNKNOWN_BUILD_VALUE);
    });

    // A hostile or malformed define must not produce unbounded output that
    // could flood a Matrix room or an updater log.
    it("bounds an over-long value", () => {
      expect(readDefine("x".repeat(5000))).toHaveLength(200);
    });
  });

  describe("getBuildInfo", () => {
    // Under vitest the tsup `define` substitutions are absent, so this asserts
    // the honest-degradation path: unknown, never a guessed or stale value.
    it("reports unknown for every field when the build defines are absent", () => {
      const info = getBuildInfo();
      expect(info.component).toBe("mail-sentinel");
      expect(info.version).toBe(UNKNOWN_BUILD_VALUE);
      expect(info.commit).toBe(UNKNOWN_BUILD_VALUE);
      expect(info.releaseId).toBe(UNKNOWN_BUILD_VALUE);
      expect(info.buildTimestamp).toBe(UNKNOWN_BUILD_VALUE);
    });

    it("never exposes anything beyond the declared build fields", () => {
      expect(Object.keys(getBuildInfo()).sort()).toEqual([
        "buildTimestamp",
        "commit",
        "component",
        "releaseId",
        "version",
      ]);
    });
  });

  describe("shortCommit", () => {
    it("shortens a full commit to seven characters for chat output", () => {
      expect(shortCommit(COMMIT)).toBe("a1b2c3d");
    });

    it("passes unknown through rather than slicing it into nonsense", () => {
      expect(shortCommit(UNKNOWN_BUILD_VALUE)).toBe(UNKNOWN_BUILD_VALUE);
    });
  });

  describe("isBuildIdentityComplete", () => {
    it("is true when version, commit, and release id all resolved", () => {
      expect(isBuildIdentityComplete(makeInfo())).toBe(true);
    });

    it.each([
      ["version", { version: UNKNOWN_BUILD_VALUE }],
      ["commit", { commit: UNKNOWN_BUILD_VALUE }],
      ["releaseId", { releaseId: UNKNOWN_BUILD_VALUE }],
    ])("is false when %s is unknown", (_field, overrides) => {
      expect(isBuildIdentityComplete(makeInfo(overrides))).toBe(false);
    });

    it("ignores a missing build timestamp, which is optional metadata", () => {
      expect(isBuildIdentityComplete(makeInfo({ buildTimestamp: UNKNOWN_BUILD_VALUE }))).toBe(true);
    });
  });

  describe("buildIdentityKey", () => {
    it("combines version, commit, and release id", () => {
      expect(buildIdentityKey(makeInfo())).toBe(`2.0.4-test.1+${COMMIT}+2.9.2-test`);
    });

    // The announcement must fire for a rebuild at the same version — this is
    // why identity is stronger than the version string alone.
    it("differs when only the commit changed", () => {
      expect(buildIdentityKey(makeInfo())).not.toBe(
        buildIdentityKey(makeInfo({ commit: "f".repeat(40) })),
      );
    });

    it("differs when only the release id changed", () => {
      expect(buildIdentityKey(makeInfo())).not.toBe(
        buildIdentityKey(makeInfo({ releaseId: "2.9.3-test" })),
      );
    });
  });
});
