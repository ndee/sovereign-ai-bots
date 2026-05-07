import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatActAsIf,
  formatAppreciation,
  formatCheckinAdd,
  formatCheckinLatest,
  formatCheckinList,
  formatFutureSelf,
  formatLevelNext,
  formatLook20s,
  formatResistanceAdd,
  formatResistanceList,
  formatResistanceResolve,
  formatReviewWeekly,
  formatStepComplete,
  formatStepList,
  formatStepNext,
  formatWishAdd,
  formatWishList,
  formatWishShow,
  printOutput,
} from "./format.js";

const wish = {
  id: "w1",
  title: "Ship",
  status: "active" as const,
  description: "details",
  emotionalCore: "calm",
  desiredState: "moved",
  timeframe: "2026",
  createdAt: "2026-04-26T10:00:00.000Z",
  updatedAt: "2026-04-26T10:00:00.000Z",
};

const checkin = {
  id: "c1",
  date: "2026-04-26",
  energyScore: 3 as const,
  clarityScore: 3 as const,
  congruenceScore: 3 as const,
  resistanceScore: 3 as const,
  linkedWishIds: [],
  note: "noted",
  createdAt: "2026-04-26T10:00:00.000Z",
};

const pattern = {
  id: "r1",
  label: "delay",
  linkedWishIds: [],
  recurrenceCount: 2,
  lastSeenAt: "2026-04-26T10:00:00.000Z",
  status: "active" as const,
};

const step = {
  id: "s1",
  title: "Write the clearest one-sentence version",
  linkedWishId: "w1",
  rationale: "Clarity is low",
  status: "open" as const,
  createdAt: "2026-04-26T10:00:00.000Z",
};

describe("reality-alignment/format", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints JSON when requested and otherwise the formatter output", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printOutput({ instanceId: "core", value: 1 }, { json: true }, () => "ignored");
    printOutput({ instanceId: "core", value: 2 }, { json: false }, () => "plain");
    expect(writeSpy).toHaveBeenCalledTimes(2);
    expect(writeSpy.mock.calls[0]?.[0]).toContain('"ok": true');
    expect(writeSpy.mock.calls[1]?.[0]).toBe("plain\n");
  });

  it("formats wish add, list, and show including optional fields", () => {
    expect(formatWishAdd({ instanceId: "core", wish })).toMatch(/Wish added/);
    expect(formatWishList({ instanceId: "core", wishes: [] })).toMatch(/No wishes/);
    expect(
      formatWishList({ instanceId: "core", wishes: [wish, { ...wish, description: undefined }] }),
    ).toMatch(/\[ACTIVE\] Ship/);
    expect(formatWishShow({ instanceId: "core", wish })).toMatch(/Emotional core: calm/);
    const minimal = {
      ...wish,
      description: undefined,
      emotionalCore: undefined,
      desiredState: undefined,
      timeframe: undefined,
    };
    expect(formatWishShow({ instanceId: "core", wish: minimal })).not.toMatch(/Emotional core/);
    const withLevel = { ...wish, desiredLevel: 540 };
    expect(formatWishShow({ instanceId: "core", wish: withLevel })).toMatch(
      /Desired level: 540 \(~joy\)/,
    );
  });

  it("formats check-in add, list, and latest", () => {
    expect(formatCheckinAdd({ instanceId: "core", checkin })).toMatch(/Check-in saved/);
    expect(formatCheckinList({ instanceId: "core", checkins: [] })).toMatch(/No check-ins yet/);
    expect(
      formatCheckinList({
        instanceId: "core",
        checkins: [checkin, { ...checkin, note: undefined }],
      }),
    ).toMatch(/energy 3/);
    expect(formatCheckinLatest({ instanceId: "core", checkin: undefined })).toMatch(/No check-ins/);
    expect(formatCheckinLatest({ instanceId: "core", checkin })).toMatch(/note: noted/);
    const withLevel = { ...checkin, level: 200 };
    expect(formatCheckinLatest({ instanceId: "core", checkin: withLevel })).toMatch(
      /level 200 \(~courage\)/,
    );
  });

  it("formats resistance add, list, and resolve", () => {
    expect(formatResistanceAdd({ instanceId: "core", pattern, created: true })).toMatch(
      /Resistance added/,
    );
    expect(formatResistanceAdd({ instanceId: "core", pattern, created: false })).toMatch(
      /Resistance incremented/,
    );
    expect(formatResistanceList({ instanceId: "core", resistance: [] })).toMatch(/No resistance/);
    expect(formatResistanceList({ instanceId: "core", resistance: [pattern] })).toMatch(
      /\[ACTIVE\] delay x2/,
    );
    expect(formatResistanceResolve({ instanceId: "core", pattern })).toMatch(/marked reduced/);
  });

  it("formats step next, list, and complete", () => {
    expect(formatStepNext({ instanceId: "core", step, wish })).toMatch(/Why: Clarity is low/);
    const stepNoRationale = { ...step, rationale: undefined };
    expect(formatStepNext({ instanceId: "core", step: stepNoRationale, wish })).not.toMatch(/Why:/);
    expect(formatStepList({ instanceId: "core", steps: [] })).toMatch(/No open steps/);
    expect(formatStepList({ instanceId: "core", steps: [step] })).toMatch(/- Write the clearest/);
    expect(formatStepComplete({ instanceId: "core", step })).toMatch(/Step completed/);
  });

  it("formats the weekly review by passing through pre-built text", () => {
    expect(
      formatReviewWeekly({
        instanceId: "core",
        review: {
          generatedAt: "2026-04-26T10:00:00.000Z",
          windowDays: 7,
          activeWishes: [],
          recentCheckins: [],
          averages: undefined,
          recurringResistance: [],
          openSteps: [],
          focus: "f",
          recommendedNextStep: "n",
        },
        formatted: "RAW",
      }),
    ).toBe("RAW");
  });

  it("formats Dodson technique exercises with title, steps, quotes, guardrail, source", () => {
    const baseExercise = {
      technique: "x",
      title: "Title",
      context: "Context line",
      steps: ["step one", "step two"],
      quotes: ['"a quote"'],
      source: "Book, ch.",
      guardrail: "Be careful with X.",
    };
    const formatted = formatLevelNext({
      instanceId: "core",
      exercise: {
        ...baseExercise,
        technique: "practicing-the-next-higher-state",
        current: { value: 100, label: "fear" },
        oneStep: { value: 125, label: "desire" },
        twoSteps: { value: 150, label: "anger" },
      },
    });
    expect(formatted).toMatch(/Title/);
    expect(formatted).toMatch(/Context line/);
    expect(formatted).toMatch(/- step one/);
    expect(formatted).toMatch(/"a quote"/);
    expect(formatted).toMatch(/Be careful with X/);
    expect(formatted).toMatch(/Source: Book, ch\./);
  });

  it("omits the context, quotes, and guardrail sections when absent", () => {
    const minimalLook = formatLook20s({
      instanceId: "core",
      exercise: {
        technique: "twenty-second-look",
        title: "Look",
        steps: ["look"],
        quotes: [],
        source: "src",
      },
    });
    expect(minimalLook).not.toMatch(/Context/);
    expect(minimalLook).toMatch(/Source: src/);
  });

  it("renders act-as-if, future-self, and appreciation through the same exercise formatter", () => {
    const wishLocal = {
      id: "w1",
      title: "Live in joy",
      status: "active" as const,
      createdAt: "2026-04-26T10:00:00.000Z",
      updatedAt: "2026-04-26T10:00:00.000Z",
    };
    const exerciseBase = {
      title: "T",
      steps: ["s"],
      quotes: [],
      source: "src",
    };
    expect(
      formatActAsIf({
        instanceId: "core",
        exercise: { ...exerciseBase, technique: "magical-action", wish: wishLocal },
      }),
    ).toMatch(/T/);
    expect(
      formatFutureSelf({
        instanceId: "core",
        exercise: { ...exerciseBase, technique: "future-into-present-2", wish: wishLocal },
      }),
    ).toMatch(/T/);
    expect(
      formatAppreciation({
        instanceId: "core",
        exercise: { ...exerciseBase, technique: "appreciation" },
      }),
    ).toMatch(/T/);
  });
});
