import { randomUUID } from "node:crypto";

import { formatPolicyActionResult } from "../alerts/output.js";
import { resolveToolRuntime } from "../config/runtime.js";
import { addPolicyEntry, flattenPolicies } from "../policy/actions.js";
import {
  findSenderCandidates,
  pickResolvedSender,
  summarizeSenderCandidate,
  upsertSenderPolicy,
} from "../policy/sender.js";
import { withLockedState } from "../state/io.js";
import { normalizePolicy } from "../state/schema.js";
import type {
  CommandOptions,
  FlattenedPolicyEntry,
  PolicyEntryBase,
  PolicyScope,
  PolicyType,
  ReceiverTarget,
} from "../types.js";
import { compactText, escapeRegExp } from "../util/normalize.js";

const POLICY_SCOPES: readonly PolicyScope[] = ["subject", "body", "snippet", "any"];

const isPolicyScope = (value: unknown): value is PolicyScope =>
  typeof value === "string" && (POLICY_SCOPES as readonly string[]).includes(value);

const RECEIVER_TARGETS: readonly ReceiverTarget[] = ["to", "cc", "delivered_to", "alias"];

const isReceiverTarget = (value: unknown): value is ReceiverTarget =>
  typeof value === "string" && (RECEIVER_TARGETS as readonly string[]).includes(value);

export interface PolicyListCommandResult {
  instanceId: string;
  count: number;
  policies: FlattenedPolicyEntry[];
}

export const policyList = async (
  options: Pick<CommandOptions, "instance" | "configPath">,
): Promise<PolicyListCommandResult> => {
  if (options.instance === undefined) {
    throw new Error("Expected --instance <id>");
  }
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  const policy = await runtime.readPolicy();
  const policies = flattenPolicies(policy);
  return {
    instanceId: runtime.instanceId,
    count: policies.length,
    policies,
  };
};

export interface PolicyAddCommandResult {
  instanceId: string;
  changed: boolean;
  policy: PolicyEntryBase & { type: string };
}

export const policyAdd = async (options: CommandOptions): Promise<PolicyAddCommandResult> => {
  if (options.instance === undefined) {
    throw new Error("Expected --instance <id>");
  }
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  const policy = await runtime.readPolicy();
  if (typeof options.type !== "string" || options.type.length === 0) {
    throw new Error("Expected --type <sender|domain|receiver|category|content|time|mute>");
  }
  if (
    ["sender", "domain", "receiver", "mute"].includes(options.type) &&
    typeof options.match !== "string"
  ) {
    throw new Error(`Policy type '${options.type}' requires --match <pattern>`);
  }
  if (options.type === "category" && typeof options.category !== "string") {
    throw new Error("Policy type 'category' requires --category <name>");
  }
  if (options.type === "time" && typeof options.schedule !== "string") {
    throw new Error("Policy type 'time' requires --schedule <HH:MM-HH:MM>");
  }
  if (
    options.type === "content" &&
    typeof options.pattern !== "string" &&
    typeof options.contains !== "string"
  ) {
    throw new Error("Policy type 'content' requires --pattern <regex> or --contains <text>");
  }
  if (options.scope !== undefined && !isPolicyScope(options.scope)) {
    throw new Error("Option --scope must be one of subject|body|snippet|any");
  }
  if (options.target !== undefined) {
    if (options.type !== "receiver") {
      throw new Error("Option --target is only valid for policy type 'receiver'");
    }
    if (!isReceiverTarget(options.target)) {
      throw new Error("Option --target must be one of to|cc|delivered_to|alias");
    }
  }
  // Explicit --pattern wins; otherwise --contains is escaped into a literal-match
  // regex so users never hand-write regex. Literal --contains rules default to the
  // subject scope (the issue's "subject contains …" use cases); raw --pattern rules
  // keep the existing subject+body ("any") behaviour unless --scope is given.
  const resolvedPattern =
    typeof options.pattern === "string"
      ? options.pattern
      : typeof options.contains === "string"
        ? escapeRegExp(options.contains)
        : undefined;
  const resolvedScope: PolicyScope | undefined = isPolicyScope(options.scope)
    ? options.scope
    : typeof options.pattern !== "string" && typeof options.contains === "string"
      ? "subject"
      : undefined;
  const entry: PolicyEntryBase = {
    id: randomUUID(),
    ...(typeof options.match === "string" ? { match: options.match } : {}),
    ...(resolvedPattern === undefined ? {} : { pattern: resolvedPattern }),
    ...(resolvedScope === undefined ? {} : { scope: resolvedScope }),
    ...(isReceiverTarget(options.target) ? { target: options.target } : {}),
    ...(typeof options.category === "string" ? { category: options.category } : {}),
    ...(typeof options.schedule === "string" ? { schedule: options.schedule } : {}),
    ...(typeof options.minZone === "string"
      ? { minZone: options.minZone as PolicyEntryBase["minZone"] }
      : {}),
    ...(typeof options.maxZone === "string"
      ? { maxZone: options.maxZone as PolicyEntryBase["maxZone"] }
      : {}),
    ...(typeof options.reason === "string" ? { reason: options.reason } : {}),
    ...(options.boost === undefined ? {} : { boost: Number(options.boost) }),
    ...(options.amountThreshold === undefined
      ? {}
      : { amountThreshold: Number(options.amountThreshold) }),
    ...(options.type === "mute" ? { action: "mute" as const } : {}),
  };
  await runtime.writePolicy(addPolicyEntry(policy, options.type, entry));
  return {
    instanceId: runtime.instanceId,
    changed: true,
    policy: {
      type: options.type,
      ...entry,
    },
  };
};

export interface PolicyRemoveCommandResult {
  instanceId: string;
  changed: boolean;
  id: string;
}

export const policyRemove = async (
  options: Pick<CommandOptions, "instance" | "configPath" | "id">,
): Promise<PolicyRemoveCommandResult> => {
  if (options.instance === undefined) {
    throw new Error("Expected --instance <id>");
  }
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  const policy = await runtime.readPolicy();
  if (typeof options.id !== "string" || options.id.length === 0) {
    throw new Error("Expected --id <policy-id>");
  }
  const targetId = options.id;
  const normalized = normalizePolicy(policy);
  const strip = (entries: PolicyEntryBase[]): PolicyEntryBase[] =>
    entries.filter((entry) => entry.id !== targetId);
  const next = {
    ...normalized,
    senderPolicies: strip(normalized.senderPolicies),
    domainPolicies: strip(normalized.domainPolicies),
    receiverPolicies: strip(normalized.receiverPolicies),
    categoryPolicies: strip(normalized.categoryPolicies),
    contentPolicies: strip(normalized.contentPolicies),
    timePolicies: strip(normalized.timePolicies),
    mutePolicies: strip(normalized.mutePolicies),
  };
  const changed = flattenPolicies(normalized).length !== flattenPolicies(next).length;
  if (changed) {
    await runtime.writePolicy(next);
  }
  return {
    instanceId: runtime.instanceId,
    changed,
    id: targetId,
  };
};

export interface PolicyImportantSenderCommandResult {
  instanceId: string;
  changed: boolean;
  status: "not-found" | "ambiguous" | "created" | "updated" | "unchanged";
  note: string;
  matches: Array<{
    from: string;
    fromAddress: string;
    domain?: string;
    messageCount: number;
    lastSeenAt: string;
  }>;
  policy?: PolicyEntryBase & { type: PolicyType };
}

export const policyImportantSender = async (
  options: Pick<CommandOptions, "instance" | "configPath" | "query" | "announce">,
): Promise<PolicyImportantSenderCommandResult> => {
  if (options.instance === undefined) {
    throw new Error("Expected --instance <id>");
  }
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  if (typeof options.query !== "string" || compactText(options.query).length === 0) {
    throw new Error("Expected --query <sender name or email>");
  }
  const query = options.query;
  try {
    const result = await withLockedState<PolicyImportantSenderCommandResult>(
      runtime.statePath,
      async () => {
        const state = await runtime.readState();
        const policy = await runtime.readPolicy();
        const matches = findSenderCandidates(state, query);
        if (matches.length === 0) {
          return {
            instanceId: runtime.instanceId,
            changed: false,
            status: "not-found",
            // The trailing version marker is the LEGACY update-verification
            // hack (edfac62): it proves a redeploy by surfacing the version in
            // a reply an operator can trigger from chat. It is superseded by
            // the `version` command and is kept only as a fallback for this
            // canary. Remove it — and its assertion in policy.test.ts — once
            // runtime identity is confirmed on a device. It MUST track the
            // shipped version; a stale marker is worse than none.
            note: `No match found for '${query}'. Use the email address directly if needed. (v2.0.4-test.1)`,
            matches: [],
          };
        }
        const resolved = pickResolvedSender(matches);
        if (resolved === null) {
          return {
            instanceId: runtime.instanceId,
            changed: false,
            status: "ambiguous",
            note: `Multiple sender matches found for '${query}'. Pick the exact address.`,
            matches: matches.slice(0, 5).map(summarizeSenderCandidate),
          };
        }
        const upserted = upsertSenderPolicy(policy, {
          match: resolved.fromAddress,
          minZone: "amber",
          clearMaxZone: true,
          reason: `Direct sender importance from '${query}'`,
        });
        if (upserted.changed) {
          await runtime.writePolicy(upserted.policy);
        }
        return {
          instanceId: runtime.instanceId,
          changed: upserted.changed,
          status: upserted.created ? "created" : upserted.changed ? "updated" : "unchanged",
          note: upserted.changed
            ? `Policy updated locally. ${resolved.fromAddress} routed as at least amber.`
            : `No change. ${resolved.fromAddress} already routed as at least amber.`,
          matches: [summarizeSenderCandidate(resolved)],
          policy: {
            type: "sender" as PolicyType,
            ...upserted.entry,
          },
        };
      },
    );
    if (options.announce === true) {
      await runtime.sendMatrixRoomMessage(formatPolicyActionResult(result));
    }
    return result;
  } catch (error) {
    if (options.announce === true) {
      await runtime.sendMatrixRoomMessage(
        `Mail Sentinel could not apply the sender preference: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    throw error;
  }
};
