import { describe, expect, it } from "vitest";

import {
  getBuildInfo,
  isBuildIdentityComplete,
  readDefine,
  shortCommit,
  UNKNOWN_BUILD_VALUE,
} from "./build-info.js";

describe("readDefine", () => {
  it("returns unknown for non-strings", () => {
    expect(readDefine(undefined)).toBe(UNKNOWN_BUILD_VALUE);
    expect(readDefine(42)).toBe(UNKNOWN_BUILD_VALUE);
    expect(readDefine(null)).toBe(UNKNOWN_BUILD_VALUE);
  });

  it("returns unknown for empty and whitespace-only strings", () => {
    expect(readDefine("")).toBe(UNKNOWN_BUILD_VALUE);
    expect(readDefine("   ")).toBe(UNKNOWN_BUILD_VALUE);
  });

  it("trims and bounds oversized values", () => {
    expect(readDefine("  2.1.0  ")).toBe("2.1.0");
    expect(readDefine("x".repeat(500))).toHaveLength(200);
  });
});

describe("getBuildInfo", () => {
  it("reports the node-operator component with unknown fields when unbundled", () => {
    const info = getBuildInfo();
    expect(info.component).toBe("node-operator");
    // Under vitest the tsup defines are never substituted.
    expect(info.version).toBe(UNKNOWN_BUILD_VALUE);
    expect(info.commit).toBe(UNKNOWN_BUILD_VALUE);
    expect(info.releaseId).toBe(UNKNOWN_BUILD_VALUE);
    expect(info.buildTimestamp).toBe(UNKNOWN_BUILD_VALUE);
  });
});

describe("shortCommit", () => {
  it("shortens a real commit and passes unknown through", () => {
    expect(shortCommit("0123456789abcdef")).toBe("0123456");
    expect(shortCommit(UNKNOWN_BUILD_VALUE)).toBe(UNKNOWN_BUILD_VALUE);
  });
});

describe("isBuildIdentityComplete", () => {
  it("requires version, commit and releaseId", () => {
    const complete = {
      component: "node-operator" as const,
      version: "2.1.0",
      commit: "a".repeat(40),
      releaseId: "v2.8.0-linux-any",
      buildTimestamp: "2026-07-29T00:00:00.000Z",
    };
    expect(isBuildIdentityComplete(complete)).toBe(true);
    expect(isBuildIdentityComplete({ ...complete, version: UNKNOWN_BUILD_VALUE })).toBe(false);
    expect(isBuildIdentityComplete({ ...complete, commit: UNKNOWN_BUILD_VALUE })).toBe(false);
    expect(isBuildIdentityComplete({ ...complete, releaseId: UNKNOWN_BUILD_VALUE })).toBe(false);
  });
});
