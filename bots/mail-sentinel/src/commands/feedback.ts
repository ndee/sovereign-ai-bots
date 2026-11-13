import { alertShortRef } from "../alerts/format.js";
import { resolveToolRuntime } from "../config/runtime.js";
import { addPolicyEntry, derivePolicyFromFeedback } from "../policy/actions.js";
import { feedbackActionLabel } from "../policy/feedback-vocab.js";
import { type LearningTransition, transitionLearning } from "../scoring/learning.js";
import { withLockedState } from "../state/io.js";
import type {
  CommandOptions,
  DerivedFeedbackRule,
  DerivedPolicy,
  FeedbackAction,
  FeedbackScope,
  FeedbackState,
  LearnedFeedbackChange,
} from "../types.js";
import { nowIso, parseDurationMs } from "../util/time.js";
import { type AlertTargetCandidate, selectAlert } from "./resolve.js";

const FEEDBACK_SCOPES: readonly FeedbackScope[] = [
  "item",
  "sender",
  "domain",
  "subject",
  "content",
];

// Actions that can derive a broad policy; for any other action the scope is
// forced to `item` since the action only ever touches the one alert (+learning).
const POLICY_ACTIONS = new Set<FeedbackAction>([
  "always-like-this",
  "reduce",
  "digest-only",
  "mute",
]);

/**
 * Resolve and validate the explicit feedback scope. Defaults to the narrowest
 * (`item`) when omitted so an unscoped action can never write a broad rule, and
 * is forced to `item` for non-policy actions. Throws on an unknown value so a
 * typo never silently widens the scope.
 */
export const resolveFeedbackScope = (
  action: FeedbackAction | undefined,
  raw: string | undefined,
): FeedbackScope => {
  if (raw === undefined) {
    return "item";
  }
  if (!FEEDBACK_SCOPES.includes(raw as FeedbackScope)) {
    throw new Error(`Unknown --scope '${raw}'. Use one of: ${FEEDBACK_SCOPES.join(", ")}`);
  }
  const scope = raw as FeedbackScope;
  return action !== undefined && POLICY_ACTIONS.has(action) ? scope : "item";
};

/** Project a derived policy (or its absence) onto the confirmation contract. */
export const toDerivedRule = (
  scope: FeedbackScope,
  derived: DerivedPolicy | null,
  learnedChanged = false,
): DerivedFeedbackRule => {
  if (derived === null) {
    return {
      type: "none",
      scope,
      reason: learnedChanged
        ? "Applies to this item; learned weights changed (see learned)."
        : "Applies to this item only; no rule created.",
    };
  }
  const { match, pattern, scope: policyScope, minZone, maxZone, reason } = derived.entry;
  return {
    type: derived.type,
    scope,
    ...(match === undefined ? {} : { match }),
    ...(pattern === undefined ? {} : { pattern }),
    ...(policyScope === undefined ? {} : { policyScope }),
    ...(minZone === undefined ? {} : { minZone }),
    ...(maxZone === undefined ? {} : { maxZone }),
    reason: reason ?? "",
  };
};

// Human-readable one-liner for the confirmation, e.g.
// `subject contains "freigegeben" -> max-zone amber`. The control plane echoes
// this verbatim; keep it terminal-friendly (no markup).
export const summarizeDerivedRule = (rule: DerivedFeedbackRule): string => {
  if (rule.type === "none") {
    return "this item only";
  }
  const zone =
    rule.minZone !== undefined
      ? `min-zone ${rule.minZone}`
      : rule.maxZone !== undefined
        ? `max-zone ${rule.maxZone}`
        : "no zone change";
  if (rule.type === "content") {
    const field = rule.policyScope === "body" ? "body" : "subject";
    return `${field} contains /${rule.pattern ?? ""}/ -> ${zone}`;
  }
  return `${rule.type} ${rule.match ?? ""} -> ${zone}`;
};

const signed = (value: number): string => (value > 0 ? `+${String(value)}` : String(value));

/** One line naming every learned weight a feedback changed, for the confirmation. */
export const summarizeLearned = (learned: LearnedFeedbackChange): string => {
  const parts: string[] = [];
  if (learned.sender !== undefined) {
    const { address, before, after, min, max } = learned.sender;
    parts.push(
      `future mail from ${address} weighs ${signed(before)} -> ${signed(after)} (limit ${signed(min)}..${signed(max)})`,
    );
  }
  for (const rule of learned.rules) {
    parts.push(`rule ${rule.ruleId} ${signed(rule.before)} -> ${signed(rule.after)}`);
  }
  return parts.length === 0 ? "No learned weight changed." : `Learned: ${parts.join("; ")}.`;
};

// These end a pending reminder, so repeating one while a reminder is due is
// still a change.
const CLEARS_REMINDER = new Set<FeedbackState>(["important", "not-important", "less-often"]);

const NOTHING_LEARNED: LearnedFeedbackChange = { changed: false, rules: [] };

export interface FeedbackCommandResult {
  instanceId: string;
  alertId: string;
  shortRef: string;
  subject: string;
  from: string;
  action: FeedbackAction;
  /**
   * The canonical action in plain words ("hide these", "digest only", …) so the
   * confirmation can echo *what the system understood* before/after applying —
   * never just the internal kebab-case id. Derived from the single vocabulary
   * source of truth in `feedback-vocab.ts`.
   */
  actionLabel: string;
  scope: FeedbackScope;
  changed: boolean;
  note: string;
  derivedRule: DerivedFeedbackRule;
  ruleSummary: string;
  /** Every learned weight this feedback changed (or would change, in a dry run). */
  learned: LearnedFeedbackChange;
  learnedSummary: string;
  dryRun?: boolean;
  nextReminderAt?: string;
  policyId?: string;
}

/**
 * Returned (instead of applying feedback) when a free-form `--ref` matches more
 * than one alert. No state is mutated — the caller must re-prompt the user with
 * the candidate list so they can disambiguate.
 */
export interface FeedbackAmbiguousResult {
  instanceId: string;
  status: "ambiguous";
  ref: string;
  changed: false;
  candidates: AlertTargetCandidate[];
}

export type ApplyFeedbackResult = FeedbackCommandResult | FeedbackAmbiguousResult;

export const isAmbiguousFeedback = (
  result: ApplyFeedbackResult,
): result is FeedbackAmbiguousResult => "status" in result && result.status === "ambiguous";

export const applyFeedback = async (
  options: Pick<
    CommandOptions,
    | "instance"
    | "configPath"
    | "alertId"
    | "ref"
    | "latest"
    | "action"
    | "delay"
    | "scope"
    | "contains"
    | "dryRun"
  >,
): Promise<ApplyFeedbackResult> => {
  if (options.instance === undefined) {
    throw new Error("Expected --instance <id>");
  }
  const scope = resolveFeedbackScope(
    options.action,
    typeof options.scope === "string" ? options.scope : undefined,
  );
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  return withLockedState(runtime.statePath, async () => {
    const state = await runtime.readState();
    const selection = selectAlert(state, options);
    if (selection.status === "ambiguous") {
      // Do not mutate state: hand the candidates back for disambiguation.
      return {
        instanceId: runtime.instanceId,
        status: "ambiguous" as const,
        ref: selection.ref,
        changed: false as const,
        candidates: selection.candidates,
      };
    }
    if (selection.status === "none") {
      throw new Error("No matching Mail Sentinel alert was found");
    }
    const alert = selection.alert;

    const action = options.action;
    // Derive the policy (if any) before mutating anything so a `--dry-run`
    // preview and the eventual write share one source of truth, and a
    // non-derivable scope fails fast — even in dry-run.
    let derived: DerivedPolicy | null = null;
    if (action !== undefined && POLICY_ACTIONS.has(action)) {
      derived = derivePolicyFromFeedback(alert, action, scope, { contains: options.contains });
      if (derived === null && scope !== "item") {
        throw new Error(`This alert does not contain enough information to derive a ${scope} rule`);
      }
    }
    const ruleSummary = summarizeDerivedRule(toDerivedRule(scope, derived));

    // Same feedback on the same alert again: nothing to learn twice. A scoped
    // policy action still runs, since it writes a rule the user asked for.
    const nextFeedbackState =
      action === undefined || action === "remind-later" ? undefined : (action as FeedbackState);
    const repeated =
      nextFeedbackState !== undefined &&
      alert.feedbackState === nextFeedbackState &&
      derived === null &&
      !(alert.reminderDueAt !== undefined && CLEARS_REMINDER.has(nextFeedbackState));
    // Computed on a copy so a dry run can preview it without writing anything.
    const nextLearning = structuredClone(state.learning);
    const transition: LearningTransition | undefined =
      nextFeedbackState === undefined || repeated
        ? undefined
        : transitionLearning(nextLearning, alert, nextFeedbackState);
    const learned = transition?.learned ?? NOTHING_LEARNED;
    const learnedSummary = summarizeLearned(learned);
    const derivedRule = toDerivedRule(scope, derived, learned.changed);

    // Dry run: report exactly what would happen and write nothing (no state,
    // no policy). The control plane uses this to show the confirmation preview.
    if (options.dryRun === true) {
      return {
        instanceId: runtime.instanceId,
        alertId: alert.alertId,
        shortRef: alertShortRef(alert),
        subject: alert.subject,
        from: alert.from,
        action: action as FeedbackAction,
        actionLabel: feedbackActionLabel(action as FeedbackAction),
        scope,
        changed: false,
        note: "Dry run — no changes written.",
        derivedRule,
        ruleSummary,
        learned,
        learnedSummary,
        dryRun: true,
      };
    }

    if (repeated) {
      return {
        instanceId: runtime.instanceId,
        alertId: alert.alertId,
        shortRef: alertShortRef(alert),
        subject: alert.subject,
        from: alert.from,
        action: action as FeedbackAction,
        actionLabel: feedbackActionLabel(action as FeedbackAction),
        scope,
        changed: false,
        note: `Already recorded as "${feedbackActionLabel(action as FeedbackAction)}" for this alert. Nothing changed.`,
        derivedRule,
        ruleSummary,
        learned,
        learnedSummary,
      };
    }

    const appliedAt = nowIso();
    let note = "Feedback recorded.";
    let nextReminderAt: string | undefined;
    let policyId: string | undefined;
    if (action === "important") {
      alert.feedbackState = "important";
      alert.feedbackAt = appliedAt;
      alert.reminderDueAt = undefined;
      note = "Feedback applied. Alert marked as important.";
    } else if (action === "not-important") {
      alert.feedbackState = "not-important";
      alert.feedbackAt = appliedAt;
      alert.reminderDueAt = undefined;
      note = "Feedback applied. Alert marked as not important.";
    } else if (action === "less-often") {
      alert.feedbackState = "less-often";
      alert.feedbackAt = appliedAt;
      alert.reminderDueAt = undefined;
      note = "Feedback applied. Sender weight reduced.";
    } else if (action === "remind-later") {
      const delay = options.delay ?? runtime.defaultReminderDelay;
      nextReminderAt = new Date(Date.now() + parseDurationMs(delay)).toISOString();
      alert.reminderDueAt = nextReminderAt;
      note = "Reminder scheduled.";
    } else if (
      action === "always-like-this" ||
      action === "reduce" ||
      action === "digest-only" ||
      action === "mute"
    ) {
      // `item` scope writes no policy — only the alert's feedbackState and (for
      // reduce) the learned sender weight change. Any other scope persists the
      // derived rule computed above.
      if (derived !== null) {
        const policy = await runtime.readPolicy();
        policyId = derived.entry.id;
        await runtime.writePolicy(addPolicyEntry(policy, derived.type, derived.entry));
        if (action === "always-like-this") {
          note = "Policy updated locally. Sender routing pattern locked.";
        } else if (action === "digest-only") {
          note = "Policy updated locally. Similar signals routed to digest only.";
        } else if (action === "mute") {
          note = "Policy updated locally. Similar mail will be hidden.";
        } else {
          note = "Policy updated locally. Similar signals reduced.";
        }
      } else {
        note = "Feedback applied to this item only.";
      }
      alert.feedbackState = action;
      alert.feedbackAt = appliedAt;
    } else {
      throw new Error(`Unsupported action '${String(action)}'`);
    }
    if (transition !== undefined) {
      state.learning = nextLearning;
      alert.learnedContribution = transition.contribution;
    }

    state.feedback.push({
      alertId: alert.alertId,
      action: action as FeedbackAction,
      at: appliedAt,
      ...(nextReminderAt === undefined
        ? {}
        : { delay: options.delay ?? runtime.defaultReminderDelay }),
      ...(policyId === undefined ? {} : { policyId }),
    });
    await runtime.writeState(state);
    return {
      instanceId: runtime.instanceId,
      alertId: alert.alertId,
      // Echo the matched item so the confirmation names exactly which alert was
      // targeted — never just the ref the user typed.
      shortRef: alertShortRef(alert),
      subject: alert.subject,
      from: alert.from,
      action: action as FeedbackAction,
      actionLabel: feedbackActionLabel(action as FeedbackAction),
      scope,
      changed: true,
      note,
      derivedRule,
      ruleSummary,
      learned,
      learnedSummary,
      ...(nextReminderAt === undefined ? {} : { nextReminderAt }),
      ...(policyId === undefined ? {} : { policyId }),
    };
  });
};
