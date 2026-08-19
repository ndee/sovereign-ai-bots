/**
 * Degradation state machine (F-01).
 *
 * Mail Sentinel used to degrade silently in the one way that matters most: when
 * the semantic reviewer (LLM) is unreachable, `classifyCandidate` is caught per
 * message, `llmResult` stays null, and the scan runs to completion. The zone
 * logic then caps every candidate at amber with an internal-only reason that is
 * deliberately filtered out of the user-facing `why`, and the success path
 * resets `consecutiveFailures` to 0 — so the outage was invisible to the Matrix
 * room (push) AND to `doctor` (pull) at the same time. Mail kept arriving and
 * nothing was ever escalated to red.
 *
 * These are pure functions with no I/O: the state is derived from counters the
 * scan already tracks, and the announce decision is a plain transition test.
 * Everything that touches the filesystem or Matrix lives in `./notice.ts`.
 */

/**
 * - `healthy` — mail is retrieved and classified.
 * - `classification-degraded` — mail is STILL being retrieved, but the semantic
 *   reviewer failed for at least one candidate this scan, so nothing can be
 *   escalated to red. This is the distinction the whole finding turns on: it is
 *   NOT a mailbox failure, and an operator must not read it as one.
 * - `scans-failing` — the scan itself is throwing, so mail is not being
 *   retrieved at all.
 * - `tool-unavailable` — the local sovereign-tool executable itself is missing
 *   or not executable (#324), so no IMAP command can even be attempted. Unlike
 *   `scans-failing` this is not a transient mailbox condition: it can never
 *   self-heal, so it must be reported on the FIRST failed scan, not after the
 *   scans-failing threshold.
 */
export type DegradationState =
  | "healthy"
  | "classification-degraded"
  | "scans-failing"
  | "tool-unavailable";

/** Consecutive scan failures at or above which the scan itself is considered broken. */
export const SCANS_FAILING_THRESHOLD = 3;

export interface DegradationInput {
  /** `state.consecutiveFailures` — scans that threw, not per-message errors. */
  consecutiveFailures: number;
  /** Candidates whose `classifyCandidate` call threw during the most recent scan. */
  lastScanLlmFailures: number;
  /**
   * Candidates that reached the semantic reviewer at all this scan. Zero means
   * the scan simply had no candidate mail, which is not degradation — without
   * this guard an idle mailbox would look identical to a broken reviewer.
   */
  lastScanCandidates: number;
  /**
   * The sovereign-tool executable was missing or not executable this scan
   * (#324). Defaults to false so existing call sites keep their behaviour.
   */
  toolUnavailable?: boolean;
  /**
   * The state recorded by the previous scan (`state.degradationState`). Used
   * for hysteresis on the reviewer (#151): a scan that evaluated no candidate
   * is not evidence that a degraded reviewer recovered — it is no evidence at
   * all — so it must not flip `classification-degraded` back to `healthy`.
   * Optional so callers without a previous observation keep today's behaviour.
   * Typed as the persisted string (the state file carries it untyped); only an
   * exact `classification-degraded` is acted on.
   */
  previousState?: string | undefined;
}

export const deriveDegradationState = (input: DegradationInput): DegradationState => {
  // Top priority: without the tool executable nothing else can even run, and
  // waiting for the scans-failing threshold would delay an install defect that
  // can never self-heal by ~three timer ticks — then misname it as a mailbox
  // problem. A missing tool degrades on the FIRST failed scan.
  if (input.toolUnavailable === true) {
    return "tool-unavailable";
  }
  // A failing scan subsumes a failing classifier: if mail is not being
  // retrieved, telling the operator that classification is degraded would point
  // them at the wrong subsystem.
  if (input.consecutiveFailures >= SCANS_FAILING_THRESHOLD) {
    return "scans-failing";
  }
  if (input.lastScanLlmFailures >= 1 && input.lastScanCandidates >= 1) {
    return "classification-degraded";
  }
  // The zero-candidate guard above keeps an idle mailbox from being *reported*
  // as degraded. Symmetrically, an idle scan cannot *clear* a degraded
  // reviewer: nothing was classified, so nothing is known. Without this, a
  // permanently broken reviewer (e.g. the lobster CLI missing, #150) produced
  // "classification degraded" / "back to normal" on alternating ticks — the
  // recovery notice firing on every quiet scan while every real candidate
  // still came back as "semantic reviewer unavailable". Recovery now needs a
  // scan that actually classified a candidate without failure.
  if (input.lastScanCandidates < 1 && input.previousState === "classification-degraded") {
    return "classification-degraded";
  }
  return "healthy";
};

/**
 * Announce only when the state actually changed — including the change back to
 * `healthy`, which is the recovery notice. Mail Sentinel is a oneshot on a
 * timer, so a per-scan announcement would repost the same warning every few
 * minutes until an operator muted the room and stopped reading it.
 */
export const shouldAnnounce = (
  previous: DegradationState | undefined,
  next: DegradationState,
): boolean => {
  // No recorded previous state: the first observation is a baseline, not a
  // transition. Announcing `healthy` on a fresh install would be noise, but a
  // node whose very first observed scan is already degraded still needs to say
  // so.
  if (previous === undefined) {
    return next !== "healthy";
  }
  return previous !== next;
};
