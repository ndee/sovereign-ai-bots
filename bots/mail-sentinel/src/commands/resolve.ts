import { alertShortRef } from "../alerts/format.js";
import { scoreSenderCandidate } from "../policy/sender.js";
import type { MailSentinelState, StoredAlert } from "../types.js";
import { compactText, normalizeThreadSubject } from "../util/normalize.js";
import { sortAlertsNewestFirst } from "../util/time.js";

/** A disambiguation candidate — the minimum a user needs to pick the right item. */
export interface AlertTargetCandidate {
  alertId: string;
  shortRef: string;
  subject: string;
  from: string;
}

export type ResolveAlertTargetResult =
  | { status: "ok"; alert: StoredAlert }
  | { status: "ambiguous"; candidates: AlertTargetCandidate[] }
  | { status: "none" };

const toCandidate = (alert: StoredAlert): AlertTargetCandidate => ({
  alertId: alert.alertId,
  shortRef: alertShortRef(alert),
  subject: alert.subject,
  from: alert.from,
});

// Strip the bracket handles users copy from messages (e.g. "[a1b2c3]") and the
// "#" some prepend to a position, then lowercase + collapse whitespace.
const normalizeRef = (ref: string): string =>
  ref
    .trim()
    .replace(/^\[(.*)\]$/u, "$1")
    .replace(/^#/u, "")
    .trim();

// Decide the outcome for a stage given the alerts it matched. Empty → null so
// the caller falls through to the next modality; one → ok; many → ambiguous
// (never silently pick the first).
const decide = (matches: readonly StoredAlert[]): ResolveAlertTargetResult | null => {
  if (matches.length === 0) {
    return null;
  }
  if (matches.length === 1) {
    return { status: "ok", alert: matches[0] as StoredAlert };
  }
  return { status: "ambiguous", candidates: matches.map(toCandidate) };
};

const matchByAlertId = (state: MailSentinelState, ref: string): StoredAlert[] =>
  state.alerts.filter((alert) => alert.alertId.toLowerCase() === ref.toLowerCase());

const matchByShortRef = (state: MailSentinelState, ref: string): StoredAlert[] => {
  const needle = ref.toLowerCase();
  return state.alerts.filter((alert) => alertShortRef(alert).toLowerCase().startsWith(needle));
};

const matchByPosition = (state: MailSentinelState, ref: string): StoredAlert[] => {
  if (!/^\d+$/u.test(ref)) {
    return [];
  }
  const ordered = state.digest.lastDigestAlertIds ?? [];
  const position = Number.parseInt(ref, 10);
  const alertId = ordered[position - 1];
  if (alertId === undefined) {
    return [];
  }
  return state.alerts.filter((alert) => alert.alertId === alertId);
};

const matchBySubject = (state: MailSentinelState, ref: string): StoredAlert[] => {
  const needle = normalizeThreadSubject(ref);
  if (needle.length === 0) {
    return [];
  }
  return state.alerts.filter((alert) => normalizeThreadSubject(alert.subject).includes(needle));
};

// Match by sender against the alerts themselves (not the message store) so an
// alert stays resolvable even after its source message is pruned. Reuses the
// same scoring seam as `findSenderCandidates`; any alert whose sender scores
// above zero for the query is a match. `ref` is always non-empty here (the
// caller resolves an empty ref to `none` before any stage runs).
const matchBySender = (state: MailSentinelState, ref: string): StoredAlert[] => {
  const query = compactText(ref).toLowerCase();
  return state.alerts.filter((alert) => {
    if (typeof alert.fromAddress !== "string") {
      return false;
    }
    return (
      scoreSenderCandidate(
        { from: alert.from, fromAddress: alert.fromAddress, domain: alert.domain },
        query,
      ) > 0
    );
  });
};

/**
 * Multi-modal "which alert did the user mean" resolver — the single targeting
 * seam reused by feedback and (later) explain/quick-action consumers.
 *
 * Resolution priority, highest first:
 *   1. full `alertId`
 *   2. unique `shortRef` prefix
 *   3. positional number, scoped to the most recently sent digest
 *   4. subject substring
 *   5. sender
 *
 * The first modality that matches at least one alert decides the outcome: a
 * single match resolves to `ok`; more than one returns `ambiguous` with the
 * candidate list so the caller can ask the user to disambiguate. A modality
 * that matches nothing falls through to the next. Nothing matches anywhere →
 * `none`. Ambiguity is never silently collapsed to a first-wins pick.
 */
export const resolveAlertTarget = (
  state: MailSentinelState,
  ref: string,
): ResolveAlertTargetResult => {
  const normalized = normalizeRef(ref);
  if (normalized.length === 0) {
    return { status: "none" };
  }
  const stages = [matchByAlertId, matchByShortRef, matchByPosition, matchBySubject, matchBySender];
  for (const stage of stages) {
    const outcome = decide(stage(state, normalized));
    if (outcome !== null) {
      return outcome;
    }
  }
  return { status: "none" };
};

/**
 * Resolve a value the caller passed as an alert id: the full `alertId` or a
 * unique `shortRef` prefix, nothing looser. Chat models copy the short handle
 * the room shows into the id field, so it must resolve there — but a value
 * meant as an id must never land on an alert by subject, sender or position.
 */
export const resolveAlertIdOrShortRef = (
  state: MailSentinelState,
  ref: string,
): ResolveAlertTargetResult => {
  const normalized = normalizeRef(ref);
  if (normalized.length === 0) {
    return { status: "none" };
  }
  return (
    decide(matchByAlertId(state, normalized)) ??
    decide(matchByShortRef(state, normalized)) ?? { status: "none" }
  );
};

export type SelectAlertResult =
  | { status: "ok"; alert: StoredAlert }
  | { status: "ambiguous"; ref: string; candidates: AlertTargetCandidate[] }
  | { status: "none" };

/**
 * The selector shared by the single-alert commands, in precedence order: an
 * `alertId` (full id or unique short ref), then `latest`, then a free-form
 * `ref` through the full {@link resolveAlertTarget} resolver. An ambiguous
 * match echoes the value the caller passed so it can re-prompt.
 */
export const selectAlert = (
  state: MailSentinelState,
  options: { alertId?: string | undefined; latest?: boolean | undefined; ref?: string | undefined },
): SelectAlertResult => {
  let asked: string;
  let resolution: ResolveAlertTargetResult;
  if (typeof options.alertId === "string") {
    asked = options.alertId;
    resolution = resolveAlertIdOrShortRef(state, asked);
  } else if (options.latest === true) {
    const newest = sortAlertsNewestFirst(state.alerts)[0];
    return newest === undefined ? { status: "none" } : { status: "ok", alert: newest };
  } else if (typeof options.ref === "string") {
    asked = options.ref;
    resolution = resolveAlertTarget(state, asked);
  } else {
    return { status: "none" };
  }
  return resolution.status === "ambiguous"
    ? { status: "ambiguous", ref: asked, candidates: resolution.candidates }
    : resolution;
};
