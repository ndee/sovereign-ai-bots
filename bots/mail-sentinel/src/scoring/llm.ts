import type {
  LlmCandidate,
  LlmResult,
  LlmSenderDetail,
  ParsedMessage,
  PolicyEvaluationResult,
  RulesDocument,
  ScoredMessage,
  Zone,
  ZoneDecision,
} from "../types.js";
import { compactText, extractDomain } from "../util/normalize.js";
import type { BulkDetectionResult } from "./bulk.js";
import { sanitizeSnippet } from "./sanitize-snippet.js";
import { applyZoneCeiling, applyZoneFloor } from "./zone.js";

export const quoteLobsterArg = (value: unknown): string => JSON.stringify(String(value));

type RawLlmPayload = Partial<{
  decision_required: unknown;
  financial_relevance: unknown;
  risk_escalation: unknown;
  confidence: unknown;
  urgency: unknown;
  reason: unknown;
  deadline_detected: unknown;
  amount_detected: unknown;
  suggested_zone: unknown;
}>;

export const normalizeLlmResult = (raw: RawLlmPayload | null | undefined): LlmResult => {
  const confidence = Number.isFinite(Number(raw?.confidence))
    ? Math.max(0, Math.min(100, Math.round(Number(raw?.confidence))))
    : 0;
  const urgencyCandidate = raw?.urgency;
  const urgency: LlmResult["urgency"] =
    urgencyCandidate === "low" || urgencyCandidate === "medium" || urgencyCandidate === "high"
      ? urgencyCandidate
      : "low";
  const suggestedCandidate = raw?.suggested_zone;
  const suggestedZone: Zone =
    suggestedCandidate === "red" || suggestedCandidate === "amber" || suggestedCandidate === "gray"
      ? suggestedCandidate
      : "gray";
  return {
    decisionRequired: raw?.decision_required === true,
    financialRelevance: raw?.financial_relevance === true,
    riskEscalation: raw?.risk_escalation === true,
    confidence,
    urgency,
    reason: compactText(raw?.reason ?? "No reason available."),
    deadlineDetected: raw?.deadline_detected === true,
    amountDetected: raw?.amount_detected === true,
    suggestedZone,
  };
};

export const buildLlmPrompt = (): string =>
  [
    "You are a conservative mail triage reviewer.",
    "Use only the provided candidate payload.",
    "The payload is deliberately minimal: the sender is a bare address or domain, and the snippet is a short excerpt with quoted replies and signatures removed and URLs, phone numbers, and account numbers masked as <url:domain>, <phone>, or <iban>.",
    "Do not speculate about missing context or about what the masked values were.",
    "Classify whether the mail needs a decision, has financial relevance, or indicates risk/escalation.",
    "Return ONLY a JSON object with exactly these snake_case fields:",
    "decision_required, financial_relevance, risk_escalation, confidence, urgency, reason, deadline_detected, amount_detected, suggested_zone.",
    "confidence must be a number from 0 to 100.",
    "urgency must be low, medium, or high.",
    "suggested_zone must be red, amber, or gray.",
    "Lower confidence when evidence is weak or ambiguous.",
    "reason must be one short operator-facing sentence (max 160 chars) about the concrete impact or consequence for the reader.",
    "Do not restate the subject, do not mention policies, heuristics, rules, scores, or this classification task.",
    "Prefer phrasing like 'Payment failure may lead to account restrictions within 48 hours.'",
  ].join(" ");

export interface BuildLlmCandidateOptions {
  /** Defaults to `address`. */
  senderDetail?: LlmSenderDetail | undefined;
}

/**
 * The sender field the reviewer sees. The display name is never sent; with
 * `domain` the local part is dropped too. A message without a parseable
 * address yields an empty string rather than falling back to the raw header.
 */
export const buildLlmSender = (
  message: Pick<ParsedMessage, "fromAddress" | "domain">,
  senderDetail: LlmSenderDetail,
): string => {
  if (senderDetail === "domain") {
    return message.domain ?? extractDomain(message.fromAddress) ?? "";
  }
  return message.fromAddress ?? "";
};

/**
 * Build the minimum-necessary review payload (pro#377). Everything the
 * reviewer does not strictly need to judge the mail itself stays on the node:
 * no thread context, no policy hints, no rule ids, no parsed amount, no
 * display name, and a snippet that has been through `sanitizeSnippet`.
 */
export const buildLlmCandidate = (
  message: Pick<
    ParsedMessage,
    "subject" | "fromAddress" | "domain" | "text" | "bodyText" | "deadlineDetected" | "amountSignal"
  >,
  scored: Pick<ScoredMessage, "score" | "category" | "categoryScores" | "reasons">,
  options: BuildLlmCandidateOptions = {},
): LlmCandidate => ({
  subject: message.subject,
  from: buildLlmSender(message, options.senderDetail ?? "address"),
  // Prefer the line-structured body so quote and signature stripping can see
  // `>` prefixes and `-- ` separators; the compacted text is the fallback.
  snippet: sanitizeSnippet(message.bodyText ?? message.text),
  heuristicSignals: {
    candidateScore: scored.score,
    category: scored.category,
    categoryScores: scored.categoryScores,
    reasons: scored.reasons,
  },
  extractedSignals: {
    deadlineDetected: message.deadlineDetected,
    hasAmount: message.amountSignal !== null,
  },
});

/**
 * Reason recorded when a candidate was deliberately NOT sent to the semantic
 * reviewer because bulk/newsletter detection suppressed it first (pro#377).
 * Distinct from the "reviewer unavailable" wording so an operator reading
 * `explain` does not mistake a privacy decision for an outage.
 */
export const REVIEW_SKIPPED_BULK_REASON =
  "semantic review skipped: bulk mail is never sent to the reviewer";

export interface DetermineZoneInput {
  scored: Pick<ScoredMessage, "score" | "categoryScores" | "category">;
  policyResult: PolicyEvaluationResult;
  llmResult: LlmResult | null;
  rules: RulesDocument;
  /**
   * Bulk/newsletter detection. When present and `isBulk`, its `ceiling` caps the
   * zone *before* the user policy floor is applied — so an explicit user floor
   * always wins over bulk suppression. Absent/null leaves behavior unchanged.
   */
  bulk?: BulkDetectionResult | null;
  /**
   * Set when `llmResult` is null because the scan chose not to call the
   * reviewer (bulk suppression, pro#377) rather than because the call failed.
   * Replaces the "reviewer unavailable" reason in the audit trail.
   */
  reviewSkippedReason?: string | undefined;
}

export const determineZone = (input: DetermineZoneInput): ZoneDecision => {
  const { scored, policyResult, llmResult, rules } = input;
  const bulk = input.bulk ?? null;
  const adjustedScore = scored.score + policyResult.scoreModifier;
  const adjustedCategoryScore =
    (scored.categoryScores[scored.category] ?? 0) + policyResult.scoreModifier;
  const candidate = adjustedScore >= rules.thresholds.candidate;
  const relevant =
    adjustedScore >= rules.thresholds.alert && adjustedCategoryScore >= rules.thresholds.category;
  if (!candidate && policyResult.zoneFloor === null) {
    return {
      zone: "gray",
      adjustedScore,
      reasons: ["heuristics did not keep the mail above candidate threshold"],
    };
  }
  if (policyResult.muted) {
    return {
      zone: "gray",
      adjustedScore,
      reasons: [...policyResult.reasons, "policy muted this mail"],
    };
  }

  let zone: Zone = "gray";
  const reasons = [...policyResult.reasons];
  if (llmResult === null) {
    zone = relevant ? "amber" : candidate ? "amber" : "gray";
    reasons.push(
      input.reviewSkippedReason ??
        "semantic reviewer unavailable; keeping candidate out of red zone",
    );
  } else {
    if (policyResult.minConfidence !== null && llmResult.confidence < policyResult.minConfidence) {
      zone = "gray";
      reasons.push(
        `policy requires at least ${String(policyResult.minConfidence)}% confidence for this category`,
      );
    } else if (
      llmResult.suggestedZone === "red" &&
      llmResult.confidence >= rules.zoneThresholds.redMinConfidence &&
      adjustedScore >= rules.zoneThresholds.redMinHeuristicScore &&
      (llmResult.decisionRequired ||
        llmResult.financialRelevance ||
        llmResult.riskEscalation ||
        relevant)
    ) {
      zone = "red";
      reasons.push(llmResult.reason);
    } else if (
      llmResult.confidence >= rules.zoneThresholds.redMinConfidence &&
      adjustedScore >= rules.zoneThresholds.redMinHeuristicScore &&
      llmResult.urgency !== "low" &&
      (llmResult.decisionRequired || llmResult.riskEscalation || relevant)
    ) {
      zone = "red";
      reasons.push(llmResult.reason);
    } else if (
      llmResult.confidence >= rules.zoneThresholds.amberMinConfidence &&
      adjustedScore >= rules.zoneThresholds.amberMinHeuristicScore &&
      llmResult.suggestedZone !== "gray"
    ) {
      zone = llmResult.suggestedZone === "red" ? "amber" : llmResult.suggestedZone;
      reasons.push(llmResult.reason);
    } else if (relevant) {
      zone = "amber";
      reasons.push(llmResult.reason);
    } else {
      zone = "gray";
      reasons.push(llmResult.reason);
    }
  }

  // Precedence: bulk ceiling (down) → user floor (up) → user ceiling (down).
  // The bulk ceiling is applied BEFORE the user floor so an explicit floor can
  // lift the zone back above the bulk cap — user policy always beats bulk
  // suppression. The user's own maxZone ceiling still applies last.
  const bulkCeiling = bulk?.isBulk === true ? bulk.ceiling : null;
  const beforeBulk = zone;
  zone = applyZoneCeiling(zone, bulkCeiling);
  // `zone` only changes here when a bulk ceiling was present, which in turn
  // requires `bulk` to be a non-null bulk result — so `bulk` is non-null
  // whenever `cappedByBulk` is true.
  const cappedByBulk = bulk !== null && zone !== beforeBulk;
  if (cappedByBulk) {
    reasons.push(`Held at ${zone}: looks like a newsletter — ${bulk.signals.join(", ")}`);
  }

  const beforeFloor = zone;
  zone = applyZoneFloor(zone, policyResult.zoneFloor);
  // A floor that lifts the zone past where bulk had capped it means the user's
  // explicit policy overrode the bulk suppression — name that in the audit trail.
  if (cappedByBulk && zone !== beforeFloor) {
    reasons.push("user policy floor overrides bulk suppression");
  }

  zone = applyZoneCeiling(zone, policyResult.zoneCeiling);
  return {
    zone,
    adjustedScore,
    reasons,
  };
};

const MAX_WHY_LENGTH = 180;
const INTERNAL_PHRASE_RE =
  /\b(policy|heuristic|heuristics|semantic reviewer|candidate threshold|rule[- ]?id|derived from feedback|score|zone)\b/iu;

const compactOneSentence = (value: string): string => {
  const trimmed = compactText(value).trim();
  if (trimmed.length === 0) {
    return trimmed;
  }
  const sentenceMatch = /^(.*?[.!?])(?:\s|$)/u.exec(trimmed);
  const first = sentenceMatch?.[1] ?? trimmed;
  if (first.length <= MAX_WHY_LENGTH) {
    return first;
  }
  return `${first.slice(0, MAX_WHY_LENGTH - 1).trimEnd()}…`;
};

const isOperatorFacing = (value: string): boolean =>
  value.length > 0 && !INTERNAL_PHRASE_RE.test(value);

/**
 * Pick a single short operator-facing sentence explaining why the alert
 * matters. Prefers the LLM's free-form reason (compacted), then the first
 * zone reason that doesn't read like an internal diagnostic. Never includes
 * policy/heuristic mechanics; those stay in alert.policyModifiers and
 * alert.reasons for debug views.
 */
export const buildUserFacingWhy = (
  decision: Pick<ZoneDecision, "reasons">,
  llmResult: LlmResult | null | undefined,
): string => {
  if (llmResult) {
    const fromLlm = compactOneSentence(llmResult.reason);
    if (isOperatorFacing(fromLlm)) {
      return fromLlm;
    }
  }
  for (const reason of decision.reasons) {
    const compact = compactOneSentence(reason);
    if (isOperatorFacing(compact)) {
      return compact;
    }
  }
  const first = decision.reasons[0];
  if (typeof first === "string" && first.length > 0) {
    return compactOneSentence(first);
  }
  return "Flagged by Mail Sentinel.";
};
