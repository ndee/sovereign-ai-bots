import { describe, expect, it } from "vitest";

import type { BuildInfo } from "../build-info.js";
import { formatVersionResult, version } from "./version.js";

const completeInfo: BuildInfo = {
  component: "node-operator",
  version: "2.1.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  releaseId: "v2.8.0-linux-any",
  buildTimestamp: "2026-07-25T14:32:11.000Z",
};

const NOW = new Date("2026-07-29T12:00:00.000Z");

describe("version", () => {
  it("reports the build identity and completeness", () => {
    const result = version(NOW, completeInfo);
    expect(result).toEqual({
      component: "node-operator",
      version: "2.1.0",
      commit: "0123456789abcdef0123456789abcdef01234567",
      releaseId: "v2.8.0-linux-any",
      buildTimestamp: "2026-07-25T14:32:11.000Z",
      reportedAt: "2026-07-29T12:00:00.000Z",
      identityComplete: true,
    });
  });

  it("uses live defaults without throwing", () => {
    const result = version();
    expect(result.component).toBe("node-operator");
    expect(result.identityComplete).toBe(false);
  });
});

describe("formatVersionResult", () => {
  it("renders the calm chat form with a short commit", () => {
    const text = formatVersionResult(version(NOW, completeInfo));
    expect(text).toBe(
      [
        "Node Operator 2.1.0",
        "Release: v2.8.0-linux-any",
        "Commit: 0123456",
        "Built: 2026-07-25 14:32 UTC",
        "Reported: 2026-07-29 12:00 UTC",
      ].join("\n"),
    );
  });

  it("flags incomplete identity and renders unknown timestamps honestly", () => {
    const text = formatVersionResult(
      version(NOW, {
        ...completeInfo,
        commit: "unknown",
        buildTimestamp: "unknown",
      }),
    );
    expect(text).toContain("Commit: unknown");
    expect(text).toContain("Built: unknown");
    expect(text).toContain("Build identity is incomplete");
  });

  it("treats an unparseable timestamp as unknown", () => {
    const text = formatVersionResult(version(NOW, { ...completeInfo, buildTimestamp: "garbage" }));
    expect(text).toContain("Built: unknown");
  });
});
