import { describe, expect, it } from "vitest";

import {
  REVIEW_MAX_ATTEMPTS,
  REVIEW_RECOVERIES_PER_SCAN,
  REVIEW_RECOVERY_HORIZON_MS,
  REVIEW_RETRIES_PER_SCAN,
  REVIEW_RETRY_GAPS_MS,
  REVIEW_RETRY_SLACK_MS,
  REVIEW_RETRY_WINDOW_MS,
} from "../constants.js";
import type { LlmCandidate, ReviewRetryState, StoredAlert } from "../types.js";
import {
  hasOperatorFeedback,
  isReviewRetryDue,
  isReviewRetryOver,
  selectReviewRecoveries,
  selectReviewRetries,
} from "./retry.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FIRST = new Date("2026-04-08T12:00:00.000Z");
const at = (offsetMs: number): Date => new Date(FIRST.getTime() + offsetMs);

const candidate: LlmCandidate = {
  subject: "Invoice #10",
  from: "alice@example.com",
  snippet: "Please pay $500 for invoice.",
  heuristicSignals: {
    candidateScore: 5,
    category: "financial-relevance",
    categoryScores: {},
    reasons: [],
  },
  extractedSignals: { deadlineDetected: false, hasAmount: true },
};

const review = (overrides: Partial<ReviewRetryState> = {}): ReviewRetryState => ({
  status: "retrying",
  attempts: 1,
  firstFailedAt: FIRST.toISOString(),
  lastAttemptAt: FIRST.toISOString(),
  ledgerKey: "imap:-:10",
  candidate,
  ...overrides,
});

const alert = (id: string, overrides: Partial<ReviewRetryState> = {}): StoredAlert => ({
  alertId: id,
  zone: "amber",
  category: "financial-relevance",
  subject: `Invoice ${id}`,
  from: "Alice <alice@example.com>",
  why: "x",
  sentAt: FIRST.toISOString(),
  feedbackState: "pending",
  confidence: null,
  llmResult: null,
  review: review(overrides),
});

describe("review/retry > bounds", () => {
  it("pins the plan's numbers", () => {
    expect(REVIEW_MAX_ATTEMPTS).toBe(6);
    expect(REVIEW_RETRY_WINDOW_MS).toBe(12 * HOUR);
    expect(REVIEW_RETRY_GAPS_MS).toEqual([0, HOUR, 2 * HOUR, 4 * HOUR, 4 * HOUR]);
    expect(REVIEW_RETRY_SLACK_MS).toBe(5 * MINUTE);
    expect(REVIEW_RETRIES_PER_SCAN).toBe(5);
    expect(REVIEW_RECOVERIES_PER_SCAN).toBe(5);
    expect(REVIEW_RECOVERY_HORIZON_MS).toBe(7 * DAY);
  });

  it("makes a postponed review (no attempt yet) due on the next scan", () => {
    expect(isReviewRetryDue(review({ attempts: 0, lastAttemptAt: undefined }), at(0))).toBe(true);
  });

  it("makes the second attempt due on the next scan", () => {
    expect(isReviewRetryDue(review({ attempts: 1 }), at(MINUTE))).toBe(true);
  });

  it.each([
    [2, HOUR],
    [3, 2 * HOUR],
    [4, 4 * HOUR],
    [5, 4 * HOUR],
  ])("waits after attempt %i for its gap, less 5 minutes of slack", (attempts, gap) => {
    const state = review({ attempts });
    expect(isReviewRetryDue(state, at(gap - REVIEW_RETRY_SLACK_MS - 1))).toBe(false);
    expect(isReviewRetryDue(state, at(gap - REVIEW_RETRY_SLACK_MS))).toBe(true);
  });

  it("never makes a seventh attempt, and only retries a retrying review", () => {
    expect(isReviewRetryDue(review({ attempts: 6 }), at(DAY))).toBe(false);
    expect(isReviewRetryDue(review({ status: "exhausted" }), at(DAY))).toBe(false);
    expect(isReviewRetryDue(review({ status: "reviewed" }), at(DAY))).toBe(false);
  });

  it("is over after 6 attempts or once 12 h have passed since the first failure", () => {
    expect(isReviewRetryOver(review({ attempts: 6 }), at(MINUTE))).toBe(true);
    expect(isReviewRetryOver(review({ attempts: 5 }), at(12 * HOUR))).toBe(false);
    expect(isReviewRetryOver(review({ attempts: 1 }), at(12 * HOUR + 1))).toBe(true);
  });

  it("follows the schedule 0, 0.5, 1.5, 3.5, 7.5 and 11.5 h on a 30-minute timer", () => {
    const state = review({ attempts: 1 });
    const attemptsAt = [0];
    for (let tick = 1; tick <= 26; tick += 1) {
      const now = at(tick * 30 * MINUTE);
      if (isReviewRetryOver(state, now)) {
        break;
      }
      if (isReviewRetryDue(state, now)) {
        state.attempts += 1;
        state.lastAttemptAt = now.toISOString();
        attemptsAt.push(tick / 2);
      }
    }
    expect(attemptsAt).toEqual([0, 0.5, 1.5, 3.5, 7.5, 11.5]);
    expect(state.attempts).toBe(REVIEW_MAX_ATTEMPTS);
  });

  it("treats only a recorded feedback as the operator having looked at the alert", () => {
    expect(hasOperatorFeedback({ feedbackState: undefined })).toBe(false);
    expect(hasOperatorFeedback({ feedbackState: "pending" })).toBe(false);
    expect(hasOperatorFeedback({ feedbackState: "important" })).toBe(true);
  });
});

describe("review/retry > selection", () => {
  it("picks the due re-reviews oldest first, at most 5, and skips the excluded ones", () => {
    const alerts = [
      alert("a", { firstFailedAt: at(-6 * HOUR).toISOString(), attempts: 1 }),
      alert("b", { firstFailedAt: at(-7 * HOUR).toISOString(), attempts: 1 }),
      alert("c", { attempts: 0, lastAttemptAt: undefined }),
      alert("d", { attempts: 1 }),
      alert("e", { attempts: 1 }),
      alert("f", { attempts: 1 }),
      alert("g", { attempts: 1 }),
      alert("skipped", { firstFailedAt: at(-8 * HOUR).toISOString() }),
      alert("not-due", { attempts: 2, lastAttemptAt: at(0).toISOString() }),
      alert("done", { status: "reviewed" }),
      alert("no-payload", { candidate: undefined }),
      { ...alert("feedback"), feedbackState: "important" as const },
      { ...alert("legacy"), review: undefined },
    ];
    const selected = selectReviewRetries(alerts, at(MINUTE), new Set(["skipped"]));
    expect(selected.map((entry) => entry.alertId)).toEqual(["b", "a", "c", "d", "e"]);
  });

  it("picks exhausted mail for its one recovery attempt, up to 7 days old, oldest first", () => {
    const now = at(8 * DAY);
    const exhausted = (id: string, ageMs: number, extra: Partial<ReviewRetryState> = {}) =>
      alert(id, {
        status: "exhausted",
        attempts: 6,
        firstFailedAt: new Date(now.getTime() - ageMs).toISOString(),
        ...extra,
      });
    const alerts = [
      exhausted("young", DAY),
      exhausted("edge", 7 * DAY),
      exhausted("too-old", 7 * DAY + 1),
      exhausted("spent", 2 * DAY, { recoveryAttempted: true }),
      exhausted("no-payload", 2 * DAY, { candidate: undefined }),
      { ...exhausted("feedback", 2 * DAY), feedbackState: "not-important" as const },
      alert("retrying"),
      exhausted("b", 3 * DAY),
      exhausted("c", 4 * DAY),
      exhausted("d", 5 * DAY),
      exhausted("e", 6 * DAY),
    ];
    expect(selectReviewRecoveries(alerts, now).map((entry) => entry.alertId)).toEqual([
      "edge",
      "e",
      "d",
      "c",
      "b",
    ]);
  });
});
