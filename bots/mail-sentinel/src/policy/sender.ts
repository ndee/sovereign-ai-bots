import { randomUUID } from "node:crypto";
import { zoneMax, zoneMin } from "../scoring/zone.js";
import { normalizePolicy } from "../state/schema.js";
import type {
  KnownSender,
  MailSentinelPolicy,
  MailSentinelState,
  PolicyEntryBase,
  ScoredSenderCandidate,
  Zone,
} from "../types.js";
import { compactText, extractDomain } from "../util/normalize.js";

export const extractDisplayName = (value: unknown): string => {
  const raw = String(value ?? "").trim();
  if (raw.length === 0) {
    return "";
  }
  return compactText(raw.replace(/<[^>]+>/g, " "));
};

export const tokenizeSenderText = (value: unknown): string[] =>
  compactText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@._+-]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);

export const collectKnownSenders = (state: MailSentinelState): KnownSender[] => {
  const senders = new Map<string, KnownSender>();
  for (const entry of Object.values(state.messages)) {
    if (typeof entry.fromAddress !== "string" || entry.fromAddress.length === 0) {
      continue;
    }
    const existing = senders.get(entry.fromAddress);
    if (existing === undefined) {
      senders.set(entry.fromAddress, {
        from: entry.from,
        fromAddress: entry.fromAddress,
        domain: entry.domain ?? extractDomain(entry.fromAddress),
        messageCount: 1,
        lastSeenAt: entry.lastSeenAt,
      });
      continue;
    }
    existing.messageCount += 1;
    if (entry.lastSeenAt > existing.lastSeenAt) {
      existing.lastSeenAt = entry.lastSeenAt;
      existing.from = entry.from;
      existing.domain = entry.domain ?? existing.domain;
    }
  }
  return Array.from(senders.values());
};

export const scoreSenderCandidate = (
  candidate: Pick<KnownSender, "from" | "fromAddress" | "domain">,
  query: string,
): number => {
  const address = candidate.fromAddress.toLowerCase();
  const from = String(candidate.from ?? "").toLowerCase();
  const domain = String(candidate.domain ?? "").toLowerCase();
  const displayName = extractDisplayName(candidate.from).toLowerCase();
  const queryTokens = tokenizeSenderText(query).filter((token) => !token.includes("@"));
  const displayTokens = tokenizeSenderText(displayName);
  const fromTokens = tokenizeSenderText(from);
  let score = 0;
  if (address === query) {
    score = Math.max(score, 250);
  }
  if (from === query) {
    score = Math.max(score, 220);
  }
  if (domain === query) {
    score = Math.max(score, 200);
  }
  if (address.startsWith(query)) {
    score = Math.max(score, 180);
  }
  if (from.startsWith(query)) {
    score = Math.max(score, 160);
  }
  if (domain.startsWith(query)) {
    score = Math.max(score, 140);
  }
  if (address.includes(query)) {
    score = Math.max(score, 130);
  }
  if (from.includes(query)) {
    score = Math.max(score, 120);
  }
  if (domain.includes(query)) {
    score = Math.max(score, 100);
  }
  if (queryTokens.length > 0 && queryTokens.every((token) => displayTokens.includes(token))) {
    score = Math.max(score, 210);
  }
  if (queryTokens.length > 0 && queryTokens.every((token) => fromTokens.includes(token))) {
    score = Math.max(score, 190);
  }
  return score;
};

export const findSenderCandidates = (
  state: MailSentinelState,
  query: string,
): ScoredSenderCandidate[] => {
  const normalizedQuery = compactText(query).toLowerCase();
  if (normalizedQuery.length === 0) {
    return [];
  }
  return collectKnownSenders(state)
    .map((candidate) => ({
      ...candidate,
      score: scoreSenderCandidate(candidate, normalizedQuery),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.lastSeenAt !== left.lastSeenAt) {
        return right.lastSeenAt.localeCompare(left.lastSeenAt);
      }
      return left.fromAddress.localeCompare(right.fromAddress);
    });
};

export const pickResolvedSender = (
  matches: readonly ScoredSenderCandidate[],
): ScoredSenderCandidate | null => {
  if (matches.length === 0) {
    return null;
  }
  if (matches.length === 1) {
    return matches[0] as ScoredSenderCandidate;
  }
  const top = matches[0] as ScoredSenderCandidate;
  const next = matches[1] as ScoredSenderCandidate;
  const topDisplayTokens = tokenizeSenderText(extractDisplayName(top.from));
  const nextDisplayTokens = tokenizeSenderText(extractDisplayName(next.from));
  if (
    topDisplayTokens.length > 0 &&
    nextDisplayTokens.length > 0 &&
    top.score >= 190 &&
    next.score >= 190
  ) {
    return null;
  }
  if (top.score >= 200 && top.score > next.score) {
    return top;
  }
  if (top.score >= 160 && top.score >= next.score + 40) {
    return top;
  }
  return null;
};

export interface SenderSummary {
  from: string;
  fromAddress: string;
  domain?: string;
  messageCount: number;
  lastSeenAt: string;
}

export const summarizeSenderCandidate = (candidate: KnownSender): SenderSummary => ({
  from: candidate.from,
  fromAddress: candidate.fromAddress,
  ...(candidate.domain === undefined ? {} : { domain: candidate.domain }),
  messageCount: candidate.messageCount,
  lastSeenAt: candidate.lastSeenAt,
});

export interface UpsertSenderInput {
  match: string;
  minZone?: Zone;
  maxZone?: Zone;
  reason?: string;
  clearMaxZone?: boolean;
}

export interface UpsertSenderResult {
  changed: boolean;
  created: boolean;
  entry: PolicyEntryBase;
  policy: MailSentinelPolicy;
}

export const upsertSenderPolicy = (
  policy: MailSentinelPolicy | null | undefined,
  input: UpsertSenderInput,
): UpsertSenderResult => {
  const normalized = normalizePolicy(policy);
  const index = normalized.senderPolicies.findIndex(
    (entry) => String(entry.match ?? "").toLowerCase() === input.match.toLowerCase(),
  );
  if (index < 0) {
    const entry: PolicyEntryBase & { clearMaxZone?: boolean } = {
      id: randomUUID(),
      ...input,
    };
    delete entry.clearMaxZone;
    normalized.senderPolicies.push(entry);
    return {
      changed: true,
      created: true,
      entry,
      policy: normalized,
    };
  }
  const existing = normalized.senderPolicies[index] as PolicyEntryBase;
  const next: PolicyEntryBase & { clearMaxZone?: boolean } = {
    ...existing,
    ...input,
    minZone:
      typeof input.minZone === "string" && typeof existing.minZone === "string"
        ? zoneMax(existing.minZone, input.minZone)
        : (input.minZone ?? existing.minZone),
    maxZone:
      typeof input.maxZone === "string" && typeof existing.maxZone === "string"
        ? zoneMin(existing.maxZone, input.maxZone)
        : (input.maxZone ?? existing.maxZone),
    reason: existing.reason ?? input.reason,
  };
  if (input.clearMaxZone === true) {
    delete next.maxZone;
  }
  delete next.clearMaxZone;
  const changed = JSON.stringify(existing) !== JSON.stringify(next);
  normalized.senderPolicies[index] = next;
  return {
    changed,
    created: false,
    entry: next,
    policy: normalized,
  };
};
