import { alertShortRef } from "../alerts/format.js";
import { resolveToolRuntime } from "../config/runtime.js";
import type { CommandOptions, LlmResult, StoredAlert, Zone } from "../types.js";
import { sortAlertsNewestFirst } from "../util/time.js";
import { type AlertTargetCandidate, resolveAlertTarget } from "./resolve.js";

/**
 * The heuristic + policy half of the explanation: everything the deterministic
 * engine contributed before the semantic reviewer was consulted. Mirrors the
 * fields the scanner persists onto the alert (`reasons`, `matchedRuleIds`,
 * `policyModifiers`, `score`/`adjustedScore`) so an operator can audit exactly
 * which rules and policies fired without re-running a scan.
 */
export interface PolicyExplanation {
  /** Heuristic match reasons (`scored.reasons`) — why the mail was a candidate. */
  signals: readonly string[];
  /** IDs of the scoring rules that fired (`scored.matchedRuleIds`). */
  matchedRuleIds: readonly string[];
  /** Policy match reasons (`policyResult.reasons`) — sender/domain/content/etc. */
  policyModifiers: readonly string[];
  /** Raw heuristic score before policy/zone adjustment. */
  score?: number | undefined;
  /** Score after policy modifiers were applied (the value the zone gate saw). */
  adjustedScore?: number | undefined;
  /** Per-category heuristic scores, for debugging category tie-breaks. */
  categoryScores?: Record<string, number> | undefined;
}

/**
 * The semantic-reviewer half of the explanation. `available` is false when the
 * scanner recorded no LLM result for the alert (reviewer was down, or the alert
 * predates semantic review); `result` then carries the verbatim reviewer
 * verdict so policy and semantic reasons never blur together.
 */
export interface SemanticExplanation {
  available: boolean;
  result?: LlmResult | undefined;
}

/** The final routing outcome the operator sees: zone, category, confidence. */
export interface ZoneDecisionExplanation {
  zone: Zone;
  category: string;
  confidence?: number | undefined;
  /** The user-facing one-liner shown on the alert itself (`alert.why`). */
  why: string;
}

export interface ExplainCommandResult {
  instanceId: string;
  alertId: string;
  shortRef: string;
  subject: string;
  from: string;
  policy: PolicyExplanation;
  semantic: SemanticExplanation;
  decision: ZoneDecisionExplanation;
}

/**
 * Returned (instead of an explanation) when a free-form `--ref` matches more
 * than one alert. Explain is read-only, so nothing is mutated either way — the
 * caller re-prompts with the candidate list so the user can disambiguate.
 */
export interface ExplainAmbiguousResult {
  instanceId: string;
  status: "ambiguous";
  ref: string;
  candidates: AlertTargetCandidate[];
}

export type ExplainResult = ExplainCommandResult | ExplainAmbiguousResult;

export const isAmbiguousExplain = (result: ExplainResult): result is ExplainAmbiguousResult =>
  "status" in result && result.status === "ambiguous";

const explainAlertEntry = (instanceId: string, alert: StoredAlert): ExplainCommandResult => ({
  instanceId,
  alertId: alert.alertId,
  shortRef: alertShortRef(alert),
  subject: alert.subject,
  from: alert.from,
  policy: {
    signals: alert.reasons ?? [],
    matchedRuleIds: alert.matchedRuleIds ?? [],
    policyModifiers: alert.policyModifiers ?? [],
    ...(typeof alert.score === "number" ? { score: alert.score } : {}),
    ...(typeof alert.adjustedScore === "number" ? { adjustedScore: alert.adjustedScore } : {}),
    ...(alert.categoryScores === undefined ? {} : { categoryScores: alert.categoryScores }),
  },
  semantic: {
    // A null/undefined llmResult means the semantic reviewer never produced a
    // verdict for this alert; surface that explicitly rather than fabricating one.
    available: alert.llmResult !== null && alert.llmResult !== undefined,
    ...(alert.llmResult === null || alert.llmResult === undefined
      ? {}
      : { result: alert.llmResult }),
  },
  decision: {
    zone: alert.zone,
    category: alert.category,
    ...(typeof alert.confidence === "number" ? { confidence: alert.confidence } : {}),
    why: alert.why,
  },
});

/**
 * Explain how an alert reached its zone: the matched rules and policy
 * modifiers, the semantic reviewer's verdict, and the final routing decision.
 * Read-only — never mutates state.
 *
 * Selection precedence mirrors {@link applyFeedback}: an explicit `--alert-id`,
 * then `--latest`, then a free-form `--ref` routed through the central
 * {@link resolveAlertTarget} resolver. The resolver is the single seam that can
 * report ambiguity (and the one that also lets a digest item be addressed by
 * its position), so explain works for both alerts and digest entries.
 */
export const explainAlert = async (
  options: Pick<CommandOptions, "instance" | "configPath" | "alertId" | "ref" | "latest">,
): Promise<ExplainResult> => {
  if (options.instance === undefined) {
    throw new Error("Expected --instance <id>");
  }
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  const state = await runtime.readState();
  let alert: StoredAlert | undefined;
  if (typeof options.alertId === "string") {
    alert = state.alerts.find((entry) => entry.alertId === options.alertId);
  } else if (options.latest === true) {
    alert = sortAlertsNewestFirst(state.alerts)[0];
  } else if (typeof options.ref === "string") {
    const resolution = resolveAlertTarget(state, options.ref);
    if (resolution.status === "ambiguous") {
      return {
        instanceId: runtime.instanceId,
        status: "ambiguous" as const,
        ref: options.ref,
        candidates: resolution.candidates,
      };
    }
    if (resolution.status === "ok") {
      alert = resolution.alert;
    }
  }
  if (alert === undefined) {
    throw new Error("No matching Mail Sentinel alert was found");
  }
  return explainAlertEntry(runtime.instanceId, alert);
};
