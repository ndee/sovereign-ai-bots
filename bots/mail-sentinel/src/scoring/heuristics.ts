import type {
  Category,
  MailSentinelState,
  ParsedMessage,
  RuleMatch,
  RulesDocument,
  ScoredMessage,
} from "../types.js";
import { createRegex, normalizeThreadSubject } from "../util/normalize.js";

export const summarizeReasons = (matches: readonly RuleMatch[]): string[] => {
  const unique = new Set<string>();
  return matches
    .filter((entry) => entry.weight > 0)
    .sort((left, right) => Math.abs(right.weight) - Math.abs(left.weight))
    .flatMap((entry) => {
      if (unique.has(entry.reason)) {
        return [];
      }
      unique.add(entry.reason);
      return [entry.reason];
    })
    .slice(0, 3);
};

export const buildRuleMatches = (
  message: ParsedMessage,
  state: MailSentinelState,
  rules: RulesDocument,
): RuleMatch[] => {
  const matches: RuleMatch[] = [];
  const senderAdjustment =
    (rules.senderWeights[message.fromAddress ?? ""] ?? 0) +
    (state.learning.senderWeights[message.fromAddress ?? ""] ?? 0);
  if (senderAdjustment !== 0 && message.fromAddress !== undefined) {
    matches.push({
      ruleId: `sender:${message.fromAddress}`,
      reason:
        senderAdjustment > 0
          ? "sender has been rated as important before"
          : "sender has been down-weighted by feedback",
      weight: senderAdjustment,
      categories: [],
    });
  }

  const domainAdjustment =
    (rules.domainWeights[message.domain ?? ""] ?? 0) +
    (state.learning.domainWeights[message.domain ?? ""] ?? 0);
  if (domainAdjustment !== 0 && message.domain !== undefined) {
    matches.push({
      ruleId: `domain:${message.domain}`,
      reason:
        domainAdjustment > 0
          ? "sender domain has been rated as important before"
          : "sender domain has been down-weighted by feedback",
      weight: domainAdjustment,
      categories: [],
    });
  }

  for (const rule of rules.rules) {
    const regex = createRegex(rule);
    const candidate =
      rule.field === "subject"
        ? message.subject
        : rule.field === "text"
          ? message.text
          : rule.field === "from"
            ? message.from
            : rule.field === "domain"
              ? (message.domain ?? "")
              : rule.field === "header"
                ? (message.headers[String(rule.headerName ?? "").toLowerCase()] ?? "")
                : "";
    if (candidate.length === 0 || !regex.test(candidate)) {
      continue;
    }
    matches.push({
      ruleId: rule.id,
      reason: rule.reason,
      weight: rule.weight + (state.learning.ruleAdjustments[rule.id] ?? 0),
      categories: Array.isArray(rule.categories) ? rule.categories : [],
    });
  }

  const priorAlert = state.alerts
    .slice()
    .reverse()
    .find(
      (alert) =>
        normalizeThreadSubject(alert.subject) === normalizeThreadSubject(message.subject) &&
        (alert.fromAddress === message.fromAddress || alert.domain === message.domain),
    );
  if (priorAlert !== undefined) {
    matches.push({
      ruleId: "thread:prior-subject-match",
      reason: "continues a subject thread that already mattered before",
      weight: 2,
      categories: [priorAlert.category],
    });
  }

  return matches;
};

export const pickPrimaryCategory = (scores: Record<string, number>): Category => {
  const sorted = Object.entries(scores).sort((left, right) => {
    if (right[1] !== left[1]) {
      return right[1] - left[1];
    }
    return left[0].localeCompare(right[0]);
  });
  return (sorted[0]?.[0] ?? "decision-required") as Category;
};

export const scoreMessage = (
  message: ParsedMessage,
  state: MailSentinelState,
  rules: RulesDocument,
): ScoredMessage => {
  const matches = buildRuleMatches(message, state, rules);
  const categoryScores: Record<string, number> = {
    "decision-required": 0,
    "financial-relevance": 0,
    "risk-escalation": 0,
  };
  let score = 0;
  for (const match of matches) {
    score += match.weight;
    for (const category of match.categories) {
      if (categoryScores[category] !== undefined) {
        categoryScores[category] += match.weight;
      }
    }
  }
  const category = pickPrimaryCategory(categoryScores);
  const candidate = score >= rules.thresholds.candidate;
  const relevant =
    score >= rules.thresholds.alert && (categoryScores[category] ?? 0) >= rules.thresholds.category;
  return {
    candidate,
    relevant,
    score,
    category,
    categoryScores,
    reasons: summarizeReasons(matches),
    matchedRuleIds: matches.map((entry) => entry.ruleId),
  };
};
