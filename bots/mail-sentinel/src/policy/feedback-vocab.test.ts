import { describe, expect, it } from "vitest";
import type { FeedbackAction } from "../types.js";
import {
  FEEDBACK_ACTION_VOCABULARY,
  feedbackActionLabel,
  normalizeFeedbackPhrase,
} from "./feedback-vocab.js";

describe("policy/feedback-vocab FEEDBACK_ACTION_VOCABULARY", () => {
  it("lists every canonical action exactly once", () => {
    const actions = FEEDBACK_ACTION_VOCABULARY.map((entry) => entry.action);
    expect(new Set(actions).size).toBe(actions.length);
    expect(actions).toEqual([
      "always-like-this",
      "digest-only",
      "mute",
      "less-often",
      "not-important",
      "important",
      "remind-later",
      "reduce",
    ]);
  });

  it("gives every entry a non-empty label and at least one example", () => {
    for (const entry of FEEDBACK_ACTION_VOCABULARY) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.examples.length).toBeGreaterThan(0);
    }
  });
});

describe("policy/feedback-vocab feedbackActionLabel", () => {
  it("returns the plain-words label for a known action", () => {
    expect(feedbackActionLabel("mute")).toBe("hide these");
    expect(feedbackActionLabel("always-like-this")).toBe("always alert");
    expect(feedbackActionLabel("digest-only")).toBe("digest only");
  });

  it("falls back to the raw action when no entry exists", () => {
    expect(feedbackActionLabel("nonexistent" as FeedbackAction)).toBe("nonexistent");
  });
});

describe("policy/feedback-vocab normalizeFeedbackPhrase", () => {
  it("returns none for empty / whitespace input", () => {
    expect(normalizeFeedbackPhrase("").confidence).toBe("none");
    expect(normalizeFeedbackPhrase("   ").confidence).toBe("none");
    expect(normalizeFeedbackPhrase("   ").action).toBeUndefined();
  });

  // Golden table: equivalent phrasings of the same intent fold to the same id.
  const golden: ReadonlyArray<readonly [string, FeedbackAction]> = [
    ["important", "important"],
    ["This is IMPORTANT!", "important"],
    ["very important", "important"],
    ["this matters to me", "important"],
    ["not important", "not-important"],
    ["This isn't important.", "not-important"],
    ["doesn't matter", "not-important"],
    ["less of this", "less-often"],
    ["less often", "less-often"],
    ["show me fewer of these", "less-often"],
    ["reduce these", "reduce"],
    ["tone these down", "reduce"],
    ["digest only", "digest-only"],
    ["put these only in the digest", "digest-only"],
    ["just summarize these", "digest-only"],
    ["always alert me", "always-like-this"],
    ["always treat like this", "always-like-this"],
    ["remind me later", "remind-later"],
    ["snooze this", "remind-later"],
    ["hide these", "mute"],
    ["I don't want to see this anymore", "mute"],
    ["stop showing me these", "mute"],
  ];

  for (const [phrase, action] of golden) {
    it(`maps ${JSON.stringify(phrase)} -> ${action} (exact)`, () => {
      const result = normalizeFeedbackPhrase(phrase);
      expect(result.action).toBe(action);
      expect(result.confidence).toBe("exact");
      expect(result.matchedPhrase).toBeDefined();
    });
  }

  it("resolves a partial match embedded in a longer sentence", () => {
    const result = normalizeFeedbackPhrase("hmm yeah please hide these from now on");
    expect(result.action).toBe("mute");
    expect(result.confidence).toBe("partial");
    expect(result.matchedPhrase).toBeUndefined();
  });

  it("reports ambiguity when an utterance implies more than one action", () => {
    const result = normalizeFeedbackPhrase("this is important but digest only");
    expect(result.action).toBeUndefined();
    expect(result.confidence).toBe("none");
    expect(new Set(result.candidates)).toEqual(
      new Set<FeedbackAction>(["important", "digest-only"]),
    );
  });

  it("returns none with no candidates for an unknown utterance", () => {
    const result = normalizeFeedbackPhrase("the quick brown fox");
    expect(result.action).toBeUndefined();
    expect(result.confidence).toBe("none");
    expect(result.candidates).toBeUndefined();
  });

  it("normalizes punctuation and casing before matching", () => {
    expect(normalizeFeedbackPhrase("  DIGEST   ONLY!! ").action).toBe("digest-only");
  });
});
