import { randomUUID } from "node:crypto";
import { normalizePolicy } from "../state/schema.js";
import type {
  DerivedPolicy,
  FeedbackAction,
  FlattenedPolicyEntry,
  MailSentinelPolicy,
  PolicyEntryBase,
  PolicyType,
  StoredAlert,
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

export const derivePolicyFromFeedback = (
  alert: Pick<StoredAlert, "fromAddress" | "zone">,
  action: FeedbackAction,
): DerivedPolicy | null => {
  if (typeof alert.fromAddress !== "string" || alert.fromAddress.length === 0) {
    return null;
  }
  if (action === "always-like-this") {
    return {
      id: randomUUID(),
      type: "sender" as PolicyType,
      entry: {
        id: randomUUID(),
        match: alert.fromAddress,
        minZone: alert.zone === "red" ? "red" : "amber",
        reason: `Derived from feedback for ${alert.fromAddress}`,
      },
    };
  }
  if (action === "reduce") {
    return {
      id: randomUUID(),
      type: "sender" as PolicyType,
      entry: {
        id: randomUUID(),
        match: alert.fromAddress,
        maxZone: alert.zone === "red" ? "amber" : "gray",
        reason: `Derived from reduce feedback for ${alert.fromAddress}`,
      },
    };
  }
  if (action === "digest-only") {
    return {
      id: randomUUID(),
      type: "sender" as PolicyType,
      entry: {
        id: randomUUID(),
        match: alert.fromAddress,
        maxZone: "amber",
        reason: `Derived from digest-only feedback for ${alert.fromAddress}`,
      },
    };
  }
  if (action === "mute") {
    // A mute is a sender-scoped entry routed onto the engine's mutePolicies path
    // (action: "mute") so future similar mail is hidden rather than re-zoned.
    return {
      id: randomUUID(),
      type: "mute" as PolicyType,
      entry: {
        id: randomUUID(),
        match: alert.fromAddress,
        action: "mute",
        reason: `Derived from mute feedback for ${alert.fromAddress}`,
      },
    };
  }
  return null;
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
