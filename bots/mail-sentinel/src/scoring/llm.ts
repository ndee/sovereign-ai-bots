import { buildThreadContext } from "../state/thread.js";
import type {
  LlmCandidate,
  LlmResult,
  MailSentinelState,
  ParsedMessage,
  PolicyEvaluationResult,
  RulesDocument,
  ScoredMessage,
  Zone,
  ZoneDecision,
} from "../types.js";
import { compactText } from "../util/normalize.js";
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

export const buildLlmSchema = () => ({
  type: "object",
  additionalProperties: false,
  properties: {
    decision_required: { type: "boolean" },
    financial_relevance: { type: "boolean" },
    risk_escalation: { type: "boolean" },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    urgency: { type: "string", enum: ["low", "medium", "high"] },
    reason: { type: "string" },
    deadline_detected: { type: "boolean" },
    amount_detected: { type: "boolean" },
    suggested_zone: { type: "string", enum: ["red", "amber", "gray"] },
  },
  required: [
    "decision_required",
    "financial_relevance",
    "risk_escalation",
    "confidence",
    "urgency",
    "reason",
    "deadline_detected",
    "amount_detected",
    "suggested_zone",
  ],
});

export const buildLlmPrompt = (): string =>
  [
    "You are a conservative mail triage reviewer.",
    "Use only the provided candidate payload.",
    "Do not speculate about missing context.",
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

export const buildLlmCandidate = (
  message: ParsedMessage,
  scored: Pick<
    ScoredMessage,
    "score" | "category" | "categoryScores" | "matchedRuleIds" | "reasons"
  >,
  policyResult: Pick<PolicyEvaluationResult, "reasons">,
  state: MailSentinelState,
): LlmCandidate => ({
  subject: message.subject,
  from: message.from,
  snippet: message.snippet,
  threadContext: buildThreadContext(state, message),
  heuristicSignals: {
    candidateScore: scored.score,
    category: scored.category,
    categoryScores: scored.categoryScores,
    matchedRules: scored.matchedRuleIds,
    reasons: scored.reasons,
  },
  policyHints: policyResult.reasons,
  extractedSignals: {
    deadlineDetected: message.deadlineDetected,
    amountDetected: message.amountSignal !== null,
    amount: message.amountSignal?.amount ?? null,
  },
});

export interface DetermineZoneInput {
  scored: Pick<ScoredMessage, "score" | "categoryScores" | "category">;
  policyResult: PolicyEvaluationResult;
  llmResult: LlmResult | null;
  rules: RulesDocument;
}

export const determineZone = (input: DetermineZoneInput): ZoneDecision => {
  const { scored, policyResult, llmResult, rules } = input;
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
    reasons.push("semantic reviewer unavailable; keeping candidate out of red zone");
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

  zone = applyZoneFloor(zone, policyResult.zoneFloor);
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
