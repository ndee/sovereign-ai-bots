import { ZONE_ORDER } from "../constants.js";
import { parseHighestAmount } from "../imap/parse.js";
import { zoneMax, zoneMin } from "../scoring/zone.js";
import { normalizePolicy } from "../state/schema.js";
import type {
  MailSentinelPolicy,
  ParsedMessage,
  PolicyEntryBase,
  PolicyEvaluationResult,
  PolicyScope,
  ScoredMessage,
  Zone,
} from "../types.js";
import { matchGlob } from "../util/normalize.js";

export const matchesPolicyEntry = (message: ParsedMessage, entry: PolicyEntryBase): boolean => {
  const candidate = entry.match ?? entry.pattern;
  if (typeof candidate !== "string" || candidate.length === 0) {
    return false;
  }
  return [message.fromAddress, message.from, message.domain]
    .filter((value): value is string => typeof value === "string")
    .some((value) => matchGlob(value, candidate));
};

export const isTimeInSchedule = (date: Date, schedule: unknown): boolean => {
  if (typeof schedule !== "string") {
    return false;
  }
  const match = schedule.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (match === null) {
    return false;
  }
  const startMinutes =
    Number.parseInt(match[1] as string, 10) * 60 + Number.parseInt(match[2] as string, 10);
  const endMinutes =
    Number.parseInt(match[3] as string, 10) * 60 + Number.parseInt(match[4] as string, 10);
  const currentMinutes = date.getHours() * 60 + date.getMinutes();
  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
};

export const contentHaystack = (
  message: Pick<ParsedMessage, "subject" | "text">,
  scope: PolicyScope | undefined,
): string => {
  if (scope === "subject") {
    return message.subject;
  }
  if (scope === "body") {
    return message.text;
  }
  return `${message.subject}\n${message.text}`;
};

export const defaultContentReason = (entry: PolicyEntryBase): string => {
  const target =
    entry.scope === "subject" ? "subject" : entry.scope === "body" ? "body" : "content";
  return `${target} matches /${entry.pattern ?? ""}/`;
};

export const evaluatePolicy = (
  message: ParsedMessage,
  scored: Pick<ScoredMessage, "category">,
  policy: MailSentinelPolicy | null | undefined,
  referenceDate: Date,
): PolicyEvaluationResult => {
  const normalized = normalizePolicy(policy);
  const result: PolicyEvaluationResult = {
    scoreModifier: 0,
    zoneFloor: null,
    zoneCeiling: null,
    muted: false,
    minConfidence: null,
    reasons: [],
    matchedPolicyIds: [],
  };
  const noteMatch = (entry: PolicyEntryBase, reason?: string): void => {
    result.reasons.push(reason ?? entry.reason ?? "policy matched");
    if (typeof entry.id === "string") {
      result.matchedPolicyIds.push(entry.id);
    }
    if (typeof entry.boost === "number" && Number.isFinite(entry.boost)) {
      result.scoreModifier += entry.boost;
    }
    if (typeof entry.minZone === "string" && ZONE_ORDER[entry.minZone] !== undefined) {
      const minZone = entry.minZone as Zone;
      result.zoneFloor = result.zoneFloor === null ? minZone : zoneMax(result.zoneFloor, minZone);
    }
    if (typeof entry.maxZone === "string" && ZONE_ORDER[entry.maxZone] !== undefined) {
      const maxZone = entry.maxZone as Zone;
      result.zoneCeiling =
        result.zoneCeiling === null ? maxZone : zoneMin(result.zoneCeiling, maxZone);
    }
    if (entry.action === "mute" || entry.muted === true) {
      result.muted = true;
      result.zoneCeiling = "gray";
    }
    if (typeof entry.minConfidence === "number" && Number.isFinite(entry.minConfidence)) {
      result.minConfidence =
        result.minConfidence === null
          ? entry.minConfidence
          : Math.max(result.minConfidence, entry.minConfidence);
    }
  };

  for (const entry of normalized.senderPolicies) {
    if (
      matchesPolicyEntry(message, entry) ||
      matchGlob(message.fromAddress ?? "", entry.match ?? "")
    ) {
      noteMatch(entry);
    }
  }

  for (const entry of normalized.domainPolicies) {
    if (matchGlob(message.domain ?? "", entry.match ?? "")) {
      noteMatch(entry);
    }
  }

  for (const entry of normalized.receiverPolicies) {
    const pattern = entry.match ?? "";
    if (pattern.length > 0 && message.toAddresses.some((addr) => matchGlob(addr, pattern))) {
      noteMatch(entry);
    }
  }

  for (const entry of normalized.categoryPolicies) {
    if (entry.category === scored.category) {
      noteMatch(entry);
    }
  }

  for (const entry of normalized.contentPolicies) {
    if (typeof entry.pattern !== "string") {
      continue;
    }
    const haystack = contentHaystack(message, entry.scope);
    const regex = new RegExp(entry.pattern, entry.flags ?? "iu");
    if (!regex.test(haystack)) {
      continue;
    }
    if (typeof entry.amountThreshold === "number") {
      const amountSignal = parseHighestAmount(haystack);
      if (amountSignal === null || amountSignal.amount < entry.amountThreshold) {
        continue;
      }
    }
    // Scoped (subject/body) rules get a descriptive audit reason when the user
    // gave none; scope-less ("any") rules keep noteMatch's existing fallback so
    // the audit trail for legacy content policies is unchanged.
    if (entry.reason === undefined && (entry.scope === "subject" || entry.scope === "body")) {
      noteMatch(entry, defaultContentReason(entry));
    } else {
      noteMatch(entry);
    }
  }

  for (const entry of normalized.timePolicies) {
    if (isTimeInSchedule(referenceDate, entry.schedule)) {
      noteMatch(entry);
    }
  }

  for (const entry of normalized.mutePolicies) {
    if (matchesPolicyEntry(message, entry)) {
      noteMatch({ ...entry, action: "mute" }, entry.reason ?? "message muted by policy");
    }
  }

  return result;
};
