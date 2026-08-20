import { describe, expect, it } from "vitest";

import type { DegradationState } from "./degradation.js";
import { deriveDegradationState, SCANS_FAILING_THRESHOLD, shouldAnnounce } from "./degradation.js";

const derive = (overrides: Partial<Parameters<typeof deriveDegradationState>[0]> = {}) =>
  deriveDegradationState({
    consecutiveFailures: 0,
    lastScanLlmFailures: 0,
    lastScanCandidates: 0,
    ...overrides,
  });

describe("health/degradation > deriveDegradationState", () => {
  it("reports healthy for a clean scan", () => {
    expect(derive({ lastScanCandidates: 5 })).toBe("healthy");
  });

  it("reports healthy for a scan with no candidate mail at all", () => {
    // An idle mailbox must not look like a broken reviewer.
    expect(derive({ lastScanCandidates: 0, lastScanLlmFailures: 0 })).toBe("healthy");
  });

  it("reports classification-degraded on a single LLM failure", () => {
    expect(derive({ lastScanCandidates: 1, lastScanLlmFailures: 1 })).toBe(
      "classification-degraded",
    );
  });

  it("reports classification-degraded when only some candidates failed", () => {
    expect(derive({ lastScanCandidates: 4, lastScanLlmFailures: 2 })).toBe(
      "classification-degraded",
    );
  });

  // Guards the counter pair against drift: failures recorded without any
  // candidate having been evaluated is an impossible state, and must not be
  // reported as degradation.
  it("stays healthy when failures are recorded without any evaluated candidate", () => {
    expect(derive({ lastScanCandidates: 0, lastScanLlmFailures: 3 })).toBe("healthy");
  });

  // #151: a quiet scan is no evidence either way. With a permanently broken
  // reviewer this flapped "degraded" / "back to normal" on alternating ticks.
  describe("reviewer hysteresis", () => {
    it("keeps classification-degraded across a scan with no candidates", () => {
      expect(
        derive({
          previousState: "classification-degraded",
          lastScanCandidates: 0,
          lastScanLlmFailures: 0,
        }),
      ).toBe("classification-degraded");
    });

    it("recovers once a candidate was classified without failure", () => {
      expect(
        derive({
          previousState: "classification-degraded",
          lastScanCandidates: 1,
          lastScanLlmFailures: 0,
        }),
      ).toBe("healthy");
    });

    it("stays degraded when the next candidate fails again", () => {
      expect(
        derive({
          previousState: "classification-degraded",
          lastScanCandidates: 2,
          lastScanLlmFailures: 1,
        }),
      ).toBe("classification-degraded");
    });

    it("does not stick from any other previous state", () => {
      for (const previousState of ["healthy", "scans-failing", "tool-unavailable", undefined]) {
        expect(derive({ previousState, lastScanCandidates: 0 })).toBe("healthy");
      }
    });

    it("ignores an unknown persisted previous state", () => {
      expect(derive({ previousState: "something-else", lastScanCandidates: 0 })).toBe("healthy");
    });

    it("still yields to scans-failing and tool-unavailable", () => {
      expect(
        derive({
          previousState: "classification-degraded",
          consecutiveFailures: SCANS_FAILING_THRESHOLD,
        }),
      ).toBe("scans-failing");
      expect(derive({ previousState: "classification-degraded", toolUnavailable: true })).toBe(
        "tool-unavailable",
      );
    });
  });

  it("stays healthy below the scans-failing threshold with no LLM failures", () => {
    expect(derive({ consecutiveFailures: SCANS_FAILING_THRESHOLD - 1 })).toBe("healthy");
  });

  it("reports scans-failing at the threshold", () => {
    expect(derive({ consecutiveFailures: SCANS_FAILING_THRESHOLD })).toBe("scans-failing");
  });

  it("reports scans-failing above the threshold", () => {
    expect(derive({ consecutiveFailures: SCANS_FAILING_THRESHOLD + 10 })).toBe("scans-failing");
  });

  // If mail is not being retrieved, naming the classifier would send the
  // operator to the wrong subsystem.
  it("gives scans-failing precedence over classification-degraded", () => {
    expect(
      derive({
        consecutiveFailures: SCANS_FAILING_THRESHOLD,
        lastScanCandidates: 3,
        lastScanLlmFailures: 3,
      }),
    ).toBe("scans-failing");
  });

  // #324: a missing tool binary can never self-heal, so it must not wait for
  // the scans-failing threshold — it degrades on the FIRST failed scan.
  it("reports tool-unavailable immediately, with zero consecutive failures", () => {
    expect(derive({ toolUnavailable: true })).toBe("tool-unavailable");
  });

  it("gives tool-unavailable precedence over scans-failing", () => {
    expect(
      derive({ toolUnavailable: true, consecutiveFailures: SCANS_FAILING_THRESHOLD + 5 }),
    ).toBe("tool-unavailable");
  });

  it("gives tool-unavailable precedence over classification-degraded", () => {
    expect(derive({ toolUnavailable: true, lastScanCandidates: 2, lastScanLlmFailures: 2 })).toBe(
      "tool-unavailable",
    );
  });

  it("treats an omitted toolUnavailable flag as false", () => {
    expect(derive({ lastScanCandidates: 5 })).toBe("healthy");
    expect(derive({ toolUnavailable: false, lastScanCandidates: 5 })).toBe("healthy");
  });
});

describe("health/degradation > shouldAnnounce", () => {
  const states: DegradationState[] = [
    "healthy",
    "classification-degraded",
    "scans-failing",
    "tool-unavailable",
  ];

  it("stays silent on a first observation that is healthy", () => {
    // A fresh install is not a recovery; announcing here would greet every new
    // node with an "all clear" for a problem it never had.
    expect(shouldAnnounce(undefined, "healthy")).toBe(false);
  });

  it("announces a first observation that is already degraded", () => {
    expect(shouldAnnounce(undefined, "classification-degraded")).toBe(true);
    expect(shouldAnnounce(undefined, "scans-failing")).toBe(true);
  });

  it.each(states)("never re-announces while %s holds", (state) => {
    expect(shouldAnnounce(state, state)).toBe(false);
  });

  it("announces every transition in both directions", () => {
    for (const previous of states) {
      for (const next of states) {
        if (previous !== next) {
          expect(shouldAnnounce(previous, next)).toBe(true);
        }
      }
    }
  });

  it("announces recovery back to healthy from any failure state", () => {
    expect(shouldAnnounce("classification-degraded", "healthy")).toBe(true);
    expect(shouldAnnounce("scans-failing", "healthy")).toBe(true);
    expect(shouldAnnounce("tool-unavailable", "healthy")).toBe(true);
  });

  it("announces a first observation of tool-unavailable", () => {
    expect(shouldAnnounce(undefined, "tool-unavailable")).toBe(true);
  });

  it("announces an escalation from classification-degraded to scans-failing", () => {
    expect(shouldAnnounce("classification-degraded", "scans-failing")).toBe(true);
  });
});
