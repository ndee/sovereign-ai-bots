import { randomUUID } from "node:crypto";
import { cleanSubjectForDisplay } from "../alerts/format.js";
import { normalizePolicy } from "../state/schema.js";
import type {
  DerivedPolicy,
  FeedbackAction,
  FeedbackScope,
  FlattenedPolicyEntry,
  MailSentinelPolicy,
  PolicyEntryBase,
  PolicyScope,
  PolicyType,
  StoredAlert,
  Zone,
} from "../types.js";

export const flattenPolicies = (
  policy: MailSentinelPolicy | null | undefined,
): FlattenedPolicyEntry[] => {
  const normalized = normalizePolicy(policy);
  return [
    ...normalized.senderPolicies.map((entry) => ({ type: "sender" as const, ...entry })),
    ...normalized.domainPolicies.map((entry) => ({ type: "domain" as const, ...entry })),
    ...normalized.receiverPolicies.map((entry) => ({ type: "receiver" as const, ...entry })),
    ...normalized.categoryPolicies.map((entry) => ({ type: "category" as const, ...entry })),
    ...normalized.contentPolicies.map((entry) => ({ type: "content" as const, ...entry })),
    ...normalized.timePolicies.map((entry) => ({ type: "time" as const, ...entry })),
    ...normalized.mutePolicies.map((entry) => ({ type: "mute" as const, ...entry })),
  ];
};

export const addPolicyEntry = (
  policy: MailSentinelPolicy | null | undefined,
  type: string,
  entry: PolicyEntryBase,
): MailSentinelPolicy => {
  const normalized = normalizePolicy(policy);
  if (type === "sender") {
    normalized.senderPolicies.push(entry);
  } else if (type === "domain") {
    normalized.domainPolicies.push(entry);
  } else if (type === "receiver") {
    normalized.receiverPolicies.push(entry);
  } else if (type === "category") {
    normalized.categoryPolicies.push(entry);
  } else if (type === "content") {
    normalized.contentPolicies.push(entry);
  } else if (type === "time") {
    normalized.timePolicies.push(entry);
  } else if (type === "mute") {
    normalized.mutePolicies.push(entry);
  } else {
    throw new Error(`Unsupported policy type '${String(type)}'`);
  }
  return normalized;
};

/** Escape a literal string so it can be embedded safely in a `RegExp` source. */
export const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

// Tokens too generic to make a useful subject rule on their own. Kept small and
// deterministic — this is a first-cut heuristic, not a full stopword list.
const SUBJECT_STOPWORDS = new Set([
  "re",
  "fwd",
  "fw",
  "aw",
  "wg",
  "the",
  "and",
  "for",
  "your",
  "you",
  "der",
  "die",
  "das",
  "und",
  "ihre",
  "ihr",
]);

/**
 * Pick a deterministic subject token to anchor a `subject contains "…"` rule.
 * Cleans the display subject, then chooses the longest word that is not a short
 * filler/stopword. Falls back to the whole cleaned subject when nothing
 * qualifies, and returns an empty string when the subject is effectively empty —
 * the caller treats that as "not derivable". Operators can always override with
 * an explicit `--contains`.
 */
export const subjectToken = (subject: string): string => {
  const cleaned = cleanSubjectForDisplay(subject);
  if (cleaned.length === 0) {
    return "";
  }
  const words = cleaned
    .split(/\s+/u)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((word) => word.length > 2 && !SUBJECT_STOPWORDS.has(word.toLowerCase()));
  if (words.length === 0) {
    return cleaned;
  }
  return words.reduce((longest, word) => (word.length > longest.length ? word : longest), "");
};

// The zone fields and reason verb are driven by the action; the scope only
// decides what the rule matches against. `mute` is a policy action with no zone
// change — it routes onto the engine's mutePolicies path so future similar mail
// is hidden rather than re-zoned. Returning null means the action derives no
// policy (e.g. it is not a policy-deriving action).
interface ActionShape {
  minZone?: Zone;
  maxZone?: Zone;
  mute?: boolean;
  verb: string;
}

const actionShape = (action: FeedbackAction, zone: Zone): ActionShape | null => {
  if (action === "always-like-this") {
    return { minZone: zone === "red" ? "red" : "amber", verb: "feedback" };
  }
  if (action === "reduce") {
    return { maxZone: zone === "red" ? "amber" : "gray", verb: "reduce feedback" };
  }
  if (action === "digest-only") {
    return { maxZone: "amber", verb: "digest-only feedback" };
  }
  if (action === "mute") {
    return { mute: true, verb: "mute feedback" };
  }
  return null;
};

/**
 * Resolve a feedback action + explicit scope to the exact policy to write, or
 * null when nothing should be written. `item` always returns null (the caller
 * still records feedbackState + learning for that one alert). `sender`/`domain`
 * match the alert's address/domain; `subject`/`content` produce a `content`
 * policy keyed on a token — derived from the subject or supplied via `contains`.
 *
 * `mute` is special: the engine's mute matcher only globs the sender address,
 * sender name, and domain (never the subject or body), so a mute can only be
 * scoped to `sender` or `domain`. A `subject`/`content` mute would never match,
 * so it is rejected (null) rather than written as a dead rule.
 */
export const derivePolicyFromFeedback = (
  alert: Pick<StoredAlert, "fromAddress" | "domain" | "zone"> & { subject?: string | undefined },
  action: FeedbackAction,
  scope: FeedbackScope,
  opts: { contains?: string | undefined } = {},
): DerivedPolicy | null => {
  const shape = actionShape(action, alert.zone);
  if (shape === null || scope === "item") {
    return null;
  }
  const zoneFields = {
    ...(shape.minZone === undefined ? {} : { minZone: shape.minZone }),
    ...(shape.maxZone === undefined ? {} : { maxZone: shape.maxZone }),
    ...(shape.mute === true ? { action: "mute" as const } : {}),
  };
  // A mute writes onto the mutePolicies bucket; everything else stays in the
  // bucket named by its scope.
  const build = (type: PolicyType, extra: PolicyEntryBase, target: string): DerivedPolicy => ({
    id: randomUUID(),
    type: shape.mute === true ? "mute" : type,
    entry: {
      id: randomUUID(),
      ...extra,
      ...zoneFields,
      reason: `Derived from ${shape.verb} for ${target}`,
    },
  });

  if (scope === "sender") {
    if (typeof alert.fromAddress !== "string" || alert.fromAddress.length === 0) {
      return null;
    }
    return build("sender", { match: alert.fromAddress }, alert.fromAddress);
  }
  if (scope === "domain") {
    if (typeof alert.domain !== "string" || alert.domain.length === 0) {
      return null;
    }
    return build("domain", { match: alert.domain }, alert.domain);
  }
  // subject / content require matching message text, which the mute matcher
  // cannot do — so mute only supports sender/domain scopes.
  if (shape.mute === true) {
    return null;
  }
  // subject / content both produce a scoped content policy keyed on a regex.
  const policyScope: PolicyScope = scope === "subject" ? "subject" : "body";
  const token =
    typeof opts.contains === "string" && opts.contains.length > 0
      ? opts.contains
      : scope === "subject"
        ? subjectToken(alert.subject ?? "")
        : "";
  if (token.length === 0) {
    return null;
  }
  return build("content", { pattern: escapeRegExp(token), scope: policyScope }, `"${token}"`);
};

export const applyLearningAdjustment = (
  target: Record<string, number>,
  key: unknown,
  delta: number,
  floor?: number,
): void => {
  if (typeof key !== "string" || key.length === 0) {
    return;
  }
  let next = (target[key] ?? 0) + delta;
  if (typeof floor === "number" && next < floor) {
    next = floor;
  }
  if (next === 0) {
    delete target[key];
    return;
  }
  target[key] = next;
};
