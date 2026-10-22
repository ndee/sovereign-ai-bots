/**
 * Bounds and schedule for reviewing a mail again on later scans after its
 * semantic review gave no verdict. Pure functions over the review state an
 * alert carries; the scan decides what to call and records the outcome.
 */
import {
  REVIEW_MAX_ATTEMPTS,
  REVIEW_RECOVERIES_PER_SCAN,
  REVIEW_RECOVERY_HORIZON_MS,
  REVIEW_RETRIES_PER_SCAN,
  REVIEW_RETRY_GAPS_MS,
  REVIEW_RETRY_SLACK_MS,
  REVIEW_RETRY_WINDOW_MS,
} from "../constants.js";
import type { ReviewRetryState, StoredAlert } from "../types.js";

const ageMs = (review: ReviewRetryState, now: Date): number =>
  now.getTime() - new Date(review.firstFailedAt).getTime();

/** Exhausted mail this old gets no recovery attempt any more. */
export const isPastRecoveryHorizon = (review: ReviewRetryState, now: Date): boolean =>
  ageMs(review, now) > REVIEW_RECOVERY_HORIZON_MS;

/** True when no further re-review may follow: all attempts made, or the window has passed. */
export const isReviewRetryOver = (review: ReviewRetryState, now: Date): boolean =>
  review.attempts >= REVIEW_MAX_ATTEMPTS || ageMs(review, now) > REVIEW_RETRY_WINDOW_MS;

/** True when the next attempt of a retrying review may be made at `now`. */
export const isReviewRetryDue = (review: ReviewRetryState, now: Date): boolean => {
  if (review.status !== "retrying" || review.attempts >= REVIEW_MAX_ATTEMPTS) {
    return false;
  }
  // A postponed review was never sent, so it is due on the next scan.
  if (review.lastAttemptAt === undefined) {
    return true;
  }
  const gap = REVIEW_RETRY_GAPS_MS[review.attempts - 1] as number;
  return now.getTime() - new Date(review.lastAttemptAt).getTime() >= gap - REVIEW_RETRY_SLACK_MS;
};

/**
 * Feedback means the operator has already looked at the alert, so the
 * reviewer is not asked about it any more. A pending reminder is not feedback.
 */
export const hasOperatorFeedback = (alert: Pick<StoredAlert, "feedbackState">): boolean =>
  alert.feedbackState !== undefined && alert.feedbackState !== "pending";

const byFirstFailure = (left: StoredAlert, right: StoredAlert): number =>
  (left.review as ReviewRetryState).firstFailedAt.localeCompare(
    (right.review as ReviewRetryState).firstFailedAt,
  );

/** The re-reviews this scan may make, oldest first; `skip` holds alerts created by this scan. */
export const selectReviewRetries = (
  alerts: readonly StoredAlert[],
  now: Date,
  skip: ReadonlySet<string>,
): StoredAlert[] =>
  alerts
    .filter(
      (alert) =>
        alert.review?.candidate !== undefined &&
        !skip.has(alert.alertId) &&
        !hasOperatorFeedback(alert) &&
        isReviewRetryDue(alert.review, now),
    )
    .sort(byFirstFailure)
    .slice(0, REVIEW_RETRIES_PER_SCAN);

/** Exhausted mail that may still get its one recovery attempt, oldest first. */
export const selectReviewRecoveries = (alerts: readonly StoredAlert[], now: Date): StoredAlert[] =>
  alerts
    .filter(
      (alert) =>
        alert.review?.status === "exhausted" &&
        alert.review.recoveryAttempted !== true &&
        alert.review.candidate !== undefined &&
        !hasOperatorFeedback(alert) &&
        !isPastRecoveryHorizon(alert.review, now),
    )
    .sort(byFirstFailure)
    .slice(0, REVIEW_RECOVERIES_PER_SCAN);
