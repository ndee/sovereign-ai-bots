import { describe, expect, it } from "vitest";

import { type BuildInfo, UNKNOWN_BUILD_VALUE } from "../build-info.js";
import { formatVersionResult, version } from "./version.js";

const COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const NOW = new Date("2026-07-25T14:32:09.000Z");

const makeInfo = (overrides: Partial<BuildInfo> = {}): BuildInfo => ({
  component: "mail-sentinel",
  version: "2.0.4-test.1",
  commit: COMMIT,
  releaseId: "2.9.2-test",
  buildTimestamp: "2026-07-25T09:15:00.000Z",
  ...overrides,
});

describe("commands/version", () => {
  it("reports the running build identity, keeping the full commit in JSON", () => {
    expect(version(NOW, makeInfo())).toEqual({
      component: "mail-sentinel",
      version: "2.0.4-test.1",
      commit: COMMIT,
      releaseId: "2.9.2-test",
      buildTimestamp: "2026-07-25T09:15:00.000Z",
      reportedAt: "2026-07-25T14:32:09.000Z",
      identityComplete: true,
    });
  });

  it("flags incomplete identity instead of hiding missing metadata", () => {
    const result = version(NOW, makeInfo({ releaseId: UNKNOWN_BUILD_VALUE }));
    expect(result.identityComplete).toBe(false);
    expect(result.releaseId).toBe(UNKNOWN_BUILD_VALUE);
  });

  // The command must answer on a node with no configured instance — that is
  // precisely when an operator needs to know which code is live.
  it("needs no runtime, configuration, or instance to produce a result", () => {
    expect(() => version()).not.toThrow();
    expect(version().component).toBe("mail-sentinel");
  });

  it("never leaks configuration, paths, or credentials", () => {
    expect(Object.keys(version(NOW, makeInfo())).sort()).toEqual([
      "buildTimestamp",
      "commit",
      "component",
      "identityComplete",
      "releaseId",
      "reportedAt",
      "version",
    ]);
  });

  describe("formatVersionResult", () => {
    it("renders a calm report with a shortened commit and UTC timestamps", () => {
      expect(formatVersionResult(version(NOW, makeInfo()))).toBe(
        [
          "Mail Sentinel 2.0.4-test.1",
          "Release: 2.9.2-test",
          "Commit: a1b2c3d",
          "Built: 2026-07-25 09:15 UTC",
          "Reported: 2026-07-25 14:32 UTC",
        ].join("\n"),
      );
    });

    it("says so plainly when the build identity is incomplete", () => {
      const text = formatVersionResult(
        version(NOW, makeInfo({ commit: UNKNOWN_BUILD_VALUE, releaseId: UNKNOWN_BUILD_VALUE })),
      );
      expect(text).toContain("Commit: unknown");
      expect(text).toContain("Release: unknown");
      expect(text).toContain("Build identity is incomplete");
    });

    it("reports an unknown build timestamp without inventing one", () => {
      const text = formatVersionResult(
        version(NOW, makeInfo({ buildTimestamp: UNKNOWN_BUILD_VALUE })),
      );
      expect(text).toContain("Built: unknown");
    });

    it("degrades to unknown when a build timestamp is unparseable", () => {
      const text = formatVersionResult(version(NOW, makeInfo({ buildTimestamp: "not-a-date" })));
      expect(text).toContain("Built: unknown");
    });

    it("does not claim a process is 'running', which a oneshot cannot support", () => {
      expect(formatVersionResult(version(NOW, makeInfo()))).not.toContain("running");
    });
  });
});
