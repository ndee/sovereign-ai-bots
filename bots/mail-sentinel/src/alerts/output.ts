import type { ExplainCommandResult, ExplainResult } from "../commands/explain.js";
import { isAmbiguousExplain } from "../commands/explain.js";
import {
  describeEffect,
  describeRoute,
  groupByType,
  type MergedPolicyGroup,
  mergeDuplicatePolicies,
  resolveEffectiveRouting,
} from "../policy/summary.js";
import type {
  AlertSummary,
  CommandOptions,
  FeedbackScope,
  FlattenedPolicyEntry,
  PolicyType,
} from "../types.js";
import { formatConfidenceLabel } from "../util/time.js";
import { formatSignalChip } from "./evidence.js";
import { formatAlertLine } from "./format.js";

export interface ScanResult {
  configured: boolean;
  note?: string;
  newMessages: number;
  redAlertsSent: number;
  amberQueued: number;
  digestsSent: number;
  remindersSent: number;
  alerts: readonly AlertSummary[];
}

export const formatScanResult = (result: Partial<ScanResult>): string => {
  if (!result.configured) {
    return result.note ?? "IMAP is not configured yet.";
  }
  const lines = [
    `Mail Sentinel scan: ${String(result.newMessages ?? 0)} new message(s), ${String(
      result.redAlertsSent ?? 0,
    )} red alert(s), ${String(result.amberQueued ?? 0)} amber candidate(s), ${String(
      result.digestsSent ?? 0,
    )} digest(s), ${String(result.remindersSent ?? 0)} reminder(s).`,
  ];
  const alerts = result.alerts ?? [];
  if (alerts.length > 0) {
    lines.push(...alerts.map((alert) => formatAlertLine(alert)));
  }
  return lines.join("\n");
};

export interface FeedbackResultCandidate {
  shortRef: string;
  subject: string;
  from: string;
}

export interface FeedbackResult {
  note?: string;
  alertId?: string;
  shortRef?: string;
  subject?: string;
  from?: string;
  scope?: FeedbackScope;
  ruleSummary?: string;
  dryRun?: boolean;
  nextReminderAt?: string;
  policyId?: string;
  status?: "ambiguous";
  ref?: string;
  candidates?: readonly FeedbackResultCandidate[];
}

// Plain-language label for each scope, so the confirmation reads the way the
// scope menu offers it ("this sender", "this subject pattern", …) rather than
// echoing the bare enum id.
const SCOPE_LABELS: Record<FeedbackScope, string> = {
  item: "this item only",
  sender: "this sender",
  domain: "this domain",
  subject: "this subject pattern",
  content: "this content pattern",
};

// Name the exact item a confirmation applies to: "[shortRef] 'subject' from
// sender". Falls back to the bare alertId when the enriched fields are absent,
// so output is never empty.
const describeTarget = (result: FeedbackResult): string => {
  if (typeof result.shortRef === "string" && typeof result.subject === "string") {
    const sender = typeof result.from === "string" ? ` from ${result.from}` : "";
    return `[${result.shortRef}] '${result.subject}'${sender}`;
  }
  return `Alert ${String(result.alertId)}`;
};

// "Scope: this sender. Created rule: …" — the explicit-scope half of the
// confirmation. Item scope writes no rule, so it stops after the scope label.
const describeScope = (result: FeedbackResult): string => {
  if (result.scope === undefined) {
    return "";
  }
  const scopeLine = ` Scope: ${SCOPE_LABELS[result.scope]}.`;
  if (result.scope === "item" || result.ruleSummary === undefined) {
    return scopeLine;
  }
  return `${scopeLine} Created rule: ${result.ruleSummary}.`;
};

export const formatFeedbackResult = (result: FeedbackResult): string => {
  // Ambiguous: lead with the status word, then list the candidates with their
  // short refs so the user can reply with an unambiguous one. No change applied.
  if (result.status === "ambiguous") {
    const candidates = result.candidates ?? [];
    return [
      `Ambiguous: '${result.ref ?? ""}' matches ${String(candidates.length)} items. Reply with one of:`,
      ...candidates.map(
        (candidate) => `- [${candidate.shortRef}] '${candidate.subject}' from ${candidate.from}`,
      ),
    ].join("\n");
  }
  const target = describeTarget(result);
  // Dry run: nothing was written. State the scope and exact rule that *would*
  // be created so the control plane can show the preview before committing.
  if (result.dryRun === true) {
    const rulePart =
      result.scope === "item" || result.ruleSummary === undefined
        ? ""
        : ` Rule: ${result.ruleSummary}.`;
    const scopeLabel = result.scope === undefined ? "" : ` Scope: ${SCOPE_LABELS[result.scope]}.`;
    return `Dry run — would apply to: ${target}.${scopeLabel}${rulePart} (nothing written)`;
  }
  const scopePart = describeScope(result);
  if (result.policyId !== undefined) {
    return `${result.note} Applied to: ${target}.${scopePart} Policy ${result.policyId} created.`;
  }
  return result.nextReminderAt === undefined
    ? `${result.note} Applied to: ${target}.${scopePart}`
    : `${result.note} Applied to: ${target}.${scopePart} Will be revisited at ${result.nextReminderAt}.`;
};

export interface ListAlertsResult {
  view: "today" | "recent" | string;
  alerts: readonly AlertSummary[];
}

export const formatListAlertsResult = (result: ListAlertsResult): string => {
  if (result.alerts.length === 0) {
    return result.view === "today"
      ? "No important Mail Sentinel alerts today."
      : "No Mail Sentinel alerts have been recorded yet.";
  }
  return [
    result.view === "today" ? "Important today:" : "Recent alerts:",
    ...result.alerts.map((alert) => formatAlertLine(alert)),
  ].join("\n");
};

export interface DigestResult {
  alerts: readonly AlertSummary[];
}

export const formatDigestResult = (result: DigestResult): string => {
  if (result.alerts.length === 0) {
    return "No amber digest entries are currently queued.";
  }
  return [
    `Amber digest queue (${String(result.alerts.length)} item(s)):`,
    ...result.alerts.map((alert) => formatAlertLine(alert)),
  ].join("\n");
};

export interface PolicyListResult {
  policies: readonly FlattenedPolicyEntry[];
}

const describePolicyEntry = (entry: FlattenedPolicyEntry): string => {
  // Content rules carry a regex (and optional subject/body scope); every other
  // policy type is described by its match/category/schedule. `pattern` is handled
  // here only via the content branch, so it is not part of the fallback chain.
  if (entry.type === "content" && typeof entry.pattern === "string") {
    const scope = entry.scope ?? "any";
    return `${scope}:/${entry.pattern}/`;
  }
  return String(entry.match ?? entry.category ?? entry.schedule);
};

// Title-cased section headers, keyed by policy type.
const SECTION_TITLES: Record<PolicyType, string> = {
  sender: "Sender",
  domain: "Domain",
  receiver: "Receiver",
  category: "Category",
  content: "Content",
  time: "Time",
  mute: "Mute",
};

// Render one merged group as a list line: id list, target, optional collapse
// marker, and the group's own routing effect.
const formatPolicyGroupLine = (group: MergedPolicyGroup): string => {
  const ids = `[${group.ids.join(",")}]`;
  const collapse = group.count > 1 ? ` (x${String(group.count)}, collapsed)` : "";
  const effect = describeEffect(group.entry);
  const suffix = effect.length > 0 ? `  ${effect}` : "";
  return `- ${ids} ${describePolicyEntry(group.entry)}${collapse}${suffix}`;
};

export const formatPolicyResult = (result: PolicyListResult): string => {
  if (result.policies.length === 0) {
    return "No Mail Sentinel policies are configured.";
  }
  const merged = mergeDuplicatePolicies(result.policies);
  const sections = groupByType(merged);
  const routes = resolveEffectiveRouting(result.policies);
  const ruleCount = `${String(result.policies.length)} rule${result.policies.length === 1 ? "" : "s"}`;
  const routeCount =
    routes.length > 0
      ? `, ${String(routes.length)} effective route${routes.length === 1 ? "" : "s"}`
      : "";
  const lines = [`Mail Sentinel policies (${ruleCount}${routeCount}):`];
  if (routes.length > 0) {
    lines.push("", "Effective routing (mute > ceiling > floor > boost):");
    for (const route of routes) {
      lines.push(`  ${route.target} -> ${describeRoute(route)}`);
    }
  }
  for (const section of sections) {
    lines.push(
      "",
      `${SECTION_TITLES[section.type]} (${String(section.groups.length)}):`,
      ...section.groups.map((group) => `  ${formatPolicyGroupLine(group)}`),
    );
  }
  return lines.join("\n");
};

export interface PolicyActionResult {
  note: string;
  matches?: readonly {
    from: string;
    fromAddress: string;
    messageCount: number;
    lastSeenAt: string;
  }[];
}

export const formatPolicyActionResult = (result: PolicyActionResult): string => {
  const lines = [result.note];
  if (Array.isArray(result.matches) && result.matches.length > 0) {
    lines.push(
      ...result.matches.map(
        (match) =>
          `- ${match.from} | ${match.fromAddress} | ${String(match.messageCount)} message(s) | last seen ${match.lastSeenAt}`,
      ),
    );
  }
  return lines.join("\n");
};

// Render one labelled section as "Heading:" plus indented "- item" lines, or a
// single "Heading: <empty>" line when there is nothing to list. Keeps the three
// explanation sections visually parallel.
const renderSection = (heading: string, lines: readonly string[]): string[] =>
  lines.length === 0
    ? [`${heading}: (none)`]
    : [`${heading}:`, ...lines.map((line) => `  - ${line}`)];

// The policy/heuristic half: the matched scoring rules, the signal chip built
// from the same `reasons` the alert shows, the policy modifiers that fired, and
// the score path. This is the deterministic side of the decision — kept wholly
// separate from the semantic reviewer's verdict below.
const renderPolicySection = (policy: ExplainCommandResult["policy"]): string[] => {
  const lines: string[] = [];
  const chip = formatSignalChip(policy.signals);
  if (chip !== undefined) {
    lines.push(`Signals: ${chip}`);
  }
  if (policy.matchedRuleIds.length > 0) {
    lines.push(`Matched rules: ${policy.matchedRuleIds.join(", ")}`);
  }
  for (const modifier of policy.policyModifiers) {
    lines.push(`Policy: ${modifier}`);
  }
  const scoreParts: string[] = [];
  if (typeof policy.score === "number") {
    scoreParts.push(`base ${String(policy.score)}`);
  }
  if (typeof policy.adjustedScore === "number") {
    scoreParts.push(`adjusted ${String(policy.adjustedScore)}`);
  }
  if (scoreParts.length > 0) {
    lines.push(`Score: ${scoreParts.join(" → ")}`);
  }
  return renderSection("Policy & heuristics", lines);
};

// The semantic half: the reviewer's verdict verbatim, or an explicit
// "unavailable" line when no LLM result was recorded for this alert. Never
// mixes in policy mechanics.
const renderSemanticSection = (semantic: ExplainCommandResult["semantic"]): string[] => {
  if (!semantic.available || semantic.result === undefined) {
    return renderSection("Semantic review", ["unavailable — no reviewer verdict recorded"]);
  }
  const result = semantic.result;
  const flags = [
    result.decisionRequired ? "decision-required" : null,
    result.financialRelevance ? "financial-relevance" : null,
    result.riskEscalation ? "risk-escalation" : null,
  ].filter((flag): flag is string => flag !== null);
  return renderSection("Semantic review", [
    `Verdict: ${result.reason}`,
    `Classified: ${flags.length === 0 ? "none" : flags.join(", ")}`,
    `Urgency: ${result.urgency}`,
    `Suggested zone: ${result.suggestedZone}`,
    `Confidence: ${formatConfidenceLabel(result.confidence)}`,
    `Extracted signals: deadline=${String(result.deadlineDetected)}, amount=${String(
      result.amountDetected,
    )}`,
  ]);
};

// The outcome: zone, category, confidence, and the operator-facing one-liner.
const renderDecisionSection = (decision: ExplainCommandResult["decision"]): string[] =>
  renderSection("Zone decision", [
    `Zone: ${decision.zone.toUpperCase()}`,
    `Category: ${decision.category}`,
    `Confidence: ${formatConfidenceLabel(decision.confidence)}`,
    `Why it matters: ${decision.why}`,
  ]);

export const formatExplainResult = (result: ExplainResult): string => {
  // Ambiguous: same shape as feedback — name the candidates with their short
  // refs so the user can re-ask unambiguously. Nothing was explained.
  if (isAmbiguousExplain(result)) {
    return [
      `Ambiguous: '${result.ref}' matches ${String(result.candidates.length)} items. Reply with one of:`,
      ...result.candidates.map(
        (candidate) => `- [${candidate.shortRef}] '${candidate.subject}' from ${candidate.from}`,
      ),
    ].join("\n");
  }
  return [
    `Explanation for [${result.shortRef}] '${result.subject}' from ${result.from}`,
    "",
    ...renderPolicySection(result.policy),
    "",
    ...renderSemanticSection(result.semantic),
    "",
    ...renderDecisionSection(result.decision),
  ].join("\n");
};

export const printOutput = <T>(
  result: T,
  options: Pick<CommandOptions, "json">,
  formatter: (value: T) => string,
): void => {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatter(result)}\n`);
};
