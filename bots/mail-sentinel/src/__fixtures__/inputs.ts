import { migrateState } from "../state/schema.js";
import type {
  MailSentinelPolicy,
  MailSentinelState,
  ParsedMessage,
  RulesDocument,
} from "../types.js";

/** Canonical fixture message that mirrors the one used in the capture script. */
export const sampleMessage: ParsedMessage = {
  key: "msg:<abc@ex>",
  uid: 42,
  messageId: "<abc@ex>",
  subject: "Invoice #123 for $500",
  normalizedThreadSubject: "invoice #123 for $500",
  from: "Alice <alice@example.com>",
  fromAddress: "alice@example.com",
  domain: "example.com",
  text: "Please pay this invoice. Amount: $500",
  snippet: "Please pay this invoice. Amount: $500",
  headers: { from: "alice@example.com", subject: "Invoice #123 for $500" },
  toAddresses: ["me@mybusiness.com"],
  amountSignal: { amount: 500 },
  deadlineDetected: false,
};

export const samplePolicy: MailSentinelPolicy = {
  version: 1,
  senderPolicies: [
    {
      id: "p-sender",
      match: "alice@example.com",
      minZone: "amber",
      boost: 2,
      reason: "known-good",
    },
  ],
  domainPolicies: [
    { id: "p-domain", match: "*.badge.example", boost: -1, reason: "ignore badges" },
  ],
  receiverPolicies: [
    { id: "p-receiver", match: "me@mybusiness.com", minZone: "amber", boost: 3, reason: "business email" },
  ],
  categoryPolicies: [{ id: "p-cat", category: "risk-escalation", boost: 1 }],
  contentPolicies: [
    {
      id: "p-content",
      pattern: "invoice",
      flags: "iu",
      boost: 3,
      amountThreshold: 100,
      minConfidence: 60,
    },
  ],
  timePolicies: [{ id: "p-time", schedule: "09:00-17:00", boost: 1 }],
  mutePolicies: [{ id: "p-mute", match: "noreply@*", reason: "auto-noise" }],
};

export const sampleRules: RulesDocument = {
  version: 2,
  thresholds: { candidate: 3, alert: 4, category: 4 },
  zoneThresholds: {
    redMinConfidence: 75,
    amberMinConfidence: 40,
    redMinHeuristicScore: 4,
    amberMinHeuristicScore: 3,
  },
  senderWeights: { "alice@example.com": 2 },
  domainWeights: { "example.com": 1 },
  rules: [
    {
      id: "rule-invoice",
      field: "subject",
      pattern: "invoice",
      flags: "iu",
      weight: 3,
      reason: "subject mentions an invoice",
      categories: ["financial-relevance"],
    },
    {
      id: "rule-amount",
      field: "text",
      pattern: "\\$\\d+",
      flags: "iu",
      weight: 2,
      reason: "mentions a dollar amount",
      categories: ["financial-relevance"],
    },
  ],
};

export const sampleState: MailSentinelState = migrateState({
  messages: {
    "msg:<abc@ex>": {
      ...sampleMessage,
      firstSeenAt: "2026-04-07T08:00:00Z",
      lastSeenAt: "2026-04-08T08:00:00Z",
    },
  },
  alerts: [
    {
      alertId: "prior-1",
      subject: "Invoice #122 for $400",
      fromAddress: "alice@example.com",
      domain: "example.com",
      category: "financial-relevance",
      zone: "amber",
      sentAt: "2026-04-07T08:00:00Z",
      from: "Alice <alice@example.com>",
      why: "prior",
    },
  ],
  learning: {
    senderWeights: { "alice@example.com": 1 },
    domainWeights: {},
    ruleAdjustments: { "rule-invoice": 1 },
  },
});

// NOTE: these messages intentionally lack normalizedThreadSubject to match
// the capture script's inputs, so buildThreadContext matches empty.
export const senderState: MailSentinelState = migrateState({
  messages: {
    "msg:1": {
      key: "msg:1",
      uid: 1,
      from: "Alice Smith <alice@example.com>",
      fromAddress: "alice@example.com",
      domain: "example.com",
      subject: "hi",
      snippet: "hi",
      lastSeenAt: "2026-04-08T10:00:00Z",
      firstSeenAt: "2026-04-07T10:00:00Z",
    },
    "msg:2": {
      key: "msg:2",
      uid: 2,
      from: "Alice Smith <alice@example.com>",
      fromAddress: "alice@example.com",
      domain: "example.com",
      subject: "hi2",
      snippet: "hi2",
      lastSeenAt: "2026-04-08T11:00:00Z",
      firstSeenAt: "2026-04-08T11:00:00Z",
    },
    "msg:3": {
      key: "msg:3",
      uid: 3,
      from: "Bob <bob@other.example>",
      fromAddress: "bob@other.example",
      domain: "other.example",
      subject: "hi3",
      snippet: "hi3",
      lastSeenAt: "2026-04-08T12:00:00Z",
      firstSeenAt: "2026-04-08T12:00:00Z",
    },
  },
} as unknown);

export const sampleAlert = {
  alertId: "alert-1",
  shortRef: "alert1",
  zone: "red" as const,
  category: "financial-relevance" as const,
  subject: "Invoice $500",
  from: "Alice <alice@example.com>",
  fromAddress: "alice@example.com",
  why: "invoice due today",
  sentAt: "2026-04-08T08:00:00.000Z",
  confidence: 85,
  messageId: "<abc@ex>",
  feedbackState: "pending" as const,
};
