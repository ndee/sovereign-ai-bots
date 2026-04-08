#!/usr/bin/env node
// One-off capture script. Runs pure mail-sentinel.mjs functions against canned
// inputs and writes their outputs as golden JSON fixtures. Used as regression
// baseline for the TypeScript port. Deleted in Phase 9.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as ms from "./mail-sentinel-exports.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = resolve(__dirname, "../bots/mail-sentinel/src/__fixtures__/golden");

const FIXED_NOW = new Date("2026-04-08T12:00:00.000Z");
const fixtures = {};

const record = (name, value) => {
  fixtures[name] = value;
};

// -------- util/normalize --------
record("normalizeMessageId", {
  empty: ms.normalizeMessageId(""),
  plain: ms.normalizeMessageId("abc@example.com"),
  wrapped: ms.normalizeMessageId("<ABC@Example.COM>"),
  trimmed: ms.normalizeMessageId("  <abc@example.com>  "),
  noAt: ms.normalizeMessageId("loose-id"),
  nonString: ms.normalizeMessageId(42),
});

record("normalizeEmailAddress", {
  simple: ms.normalizeEmailAddress("Alice@Example.COM"),
  named: ms.normalizeEmailAddress('"Alice" <Alice@Example.com>'),
  empty: ms.normalizeEmailAddress(""),
  nonString: ms.normalizeEmailAddress(undefined),
});

record("extractDomain", {
  plain: ms.extractDomain("alice@example.com"),
  noAt: ms.extractDomain("alice"),
  trailing: ms.extractDomain("alice@"),
  uppercase: ms.extractDomain("alice@Example.COM"),
  nonString: ms.extractDomain(null),
});

record("compactText", {
  spaces: ms.compactText("  hello   world  "),
  tabs: ms.compactText("\thello\n\tworld\t"),
  undef: ms.compactText(undefined),
  nullish: ms.compactText(null),
});

record("stripSingleTrailingNewline", {
  lf: ms.stripSingleTrailingNewline("line\n"),
  crlf: ms.stripSingleTrailingNewline("line\r\n"),
  none: ms.stripSingleTrailingNewline("line"),
  double: ms.stripSingleTrailingNewline("line\n\n"),
});

record("ensureTrailingSlash", {
  none: ms.ensureTrailingSlash("https://a.example"),
  already: ms.ensureTrailingSlash("https://a.example/"),
});

record("normalizeThreadSubject", {
  plain: ms.normalizeThreadSubject("Meeting notes"),
  reprefix: ms.normalizeThreadSubject("Re: Meeting notes"),
  aw: ms.normalizeThreadSubject("AW: Meeting notes"),
  fwd: ms.normalizeThreadSubject("Fwd: Meeting notes"),
  mixedCase: ms.normalizeThreadSubject("  ReMix "),
  empty: ms.normalizeThreadSubject(""),
});

// -------- util/time --------
record("parseDurationMs", {
  minutes: ms.parseDurationMs("30m"),
  hours: ms.parseDurationMs("2h"),
  days: ms.parseDurationMs("1d"),
  longForm: ms.parseDurationMs("15 minutes"),
  zeroHours: ms.parseDurationMs("0h"),
});

try {
  ms.parseDurationMs("invalid");
} catch (error) {
  record("parseDurationMs.error", { message: error.message });
}

record("clampLimit", {
  undef: ms.clampLimit(undefined, 20),
  under: ms.clampLimit(5, 20),
  over: ms.clampLimit(100, 20),
  equal: ms.clampLimit(20, 20),
  stringInput: ms.clampLimit("7", 20),
});
try {
  ms.clampLimit("0", 20);
} catch (error) {
  record("clampLimit.zero", { message: error.message });
}
try {
  ms.clampLimit("abc", 20);
} catch (error) {
  record("clampLimit.nonNumeric", { message: error.message });
}

record("startOfLocalDay", {
  iso: ms.startOfLocalDay("2026-04-08T12:34:56.000Z"),
  midnight: ms.startOfLocalDay(FIXED_NOW),
});

record("isSameLocalDay", {
  sameDay: ms.isSameLocalDay("2026-04-08T08:00:00.000Z", FIXED_NOW),
  differentDay: ms.isSameLocalDay("2026-04-07T08:00:00.000Z", FIXED_NOW),
  invalid: ms.isSameLocalDay("not-a-date", FIXED_NOW),
});

record("formatConfidenceLabel", {
  high: ms.formatConfidenceLabel(85),
  medium: ms.formatConfidenceLabel(50),
  low: ms.formatConfidenceLabel(10),
  undef: ms.formatConfidenceLabel(undefined),
});

record("buildMessageKey", {
  withMessageId: ms.buildMessageKey("<abc@ex>", 42),
  withoutMessageId: ms.buildMessageKey(undefined, 99),
});

record("sortAlertsNewestFirst", {
  empty: ms.sortAlertsNewestFirst([]),
  sorted: ms.sortAlertsNewestFirst([
    { alertId: "a", sentAt: "2026-04-08T10:00:00Z" },
    { alertId: "b", sentAt: "2026-04-08T12:00:00Z" },
    { alertId: "c", sentAt: "2026-04-08T11:00:00Z" },
  ]),
});

// -------- util/paths --------
record("parseJsonSafely", {
  valid: ms.parseJsonSafely('{"a":1}\n'),
  invalid: ms.parseJsonSafely("not json"),
});

// -------- state/schema --------
record("createDefaultPolicy", ms.createDefaultPolicy());
record("createDefaultState", ms.createDefaultState());

record("migrateState.empty", ms.migrateState({}));
record(
  "migrateState.partial",
  ms.migrateState({
    version: 1,
    mailbox: { lastSeenUid: 7 },
    messages: { "msg:<a@b>": { key: "msg:<a@b>", uid: 5, lastSeenAt: "2026-04-08T10:00:00Z" } },
    alerts: [{ alertId: "x", sentAt: "2026-04-08T10:00:00Z", zone: "red" }],
    feedback: "not-an-array",
    learning: { senderWeights: { "a@b.com": 2 } },
    digest: { pendingAmber: ["x"], lastDigestAt: "2026-04-08T09:00:00Z" },
  }),
);

const bulkMessages = {};
for (let i = 0; i < 12; i += 1) {
  const key = `msg:<${i}@bulk>`;
  bulkMessages[key] = {
    key,
    uid: i,
    lastSeenAt: new Date(Date.UTC(2026, 3, 8, 10, i, 0)).toISOString(),
    subject: `msg ${i}`,
  };
}
record(
  "pruneState",
  ms.pruneState(
    ms.migrateState({
      mailbox: { lastSeenUid: 11 },
      messages: bulkMessages,
      alerts: Array.from({ length: 3 }, (_, i) => ({
        alertId: `alert-${i}`,
        sentAt: new Date(Date.UTC(2026, 3, 8, 10, i, 0)).toISOString(),
        zone: "amber",
      })),
      feedback: Array.from({ length: 3 }, (_, i) => ({
        alertId: `alert-${i}`,
        action: "important",
        at: new Date(Date.UTC(2026, 3, 8, 10, i, 0)).toISOString(),
      })),
      digest: {
        pendingAmber: Array.from({ length: 5 }, (_, i) => `alert-${i}`),
      },
      zoneHistory: Array.from({ length: 4 }, (_, i) => ({
        at: new Date(Date.UTC(2026, 3, 8, 10, i, 0)).toISOString(),
        messageKey: `msg:<${i}@bulk>`,
        zone: "gray",
        reason: "none",
      })),
    }),
  ),
);

// -------- config/args --------
record("parseArgs.scan", ms.parseArgs(["scan", "--instance", "ms-core", "--json"]));
record(
  "parseArgs.feedback",
  ms.parseArgs([
    "feedback",
    "--instance",
    "ms-core",
    "--latest",
    "--action",
    "remind-later",
    "--delay",
    "4h",
    "--json",
  ]),
);
record(
  "parseArgs.policyAdd",
  ms.parseArgs([
    "policy",
    "add",
    "--instance",
    "ms-core",
    "--type",
    "sender",
    "--match",
    "alice@example.com",
    "--min-zone",
    "amber",
    "--json",
  ]),
);
record(
  "parseArgs.listAlerts",
  ms.parseArgs(["list-alerts", "--instance", "ms-core", "--view", "today", "--json"]),
);
try {
  ms.parseArgs(["scan", "--instance", "ms-core", "--bogus"]);
} catch (error) {
  record("parseArgs.unknown", { message: error.message });
}
try {
  ms.parseArgs(["scan", "--instance"]);
} catch (error) {
  record("parseArgs.missingValue", { message: error.message });
}

// -------- imap/parse --------
record("normalizeHeaderMap", {
  fromArray: ms.normalizeHeaderMap([
    { key: "From", value: "alice@example.com" },
    { name: "Subject", value: "  hi " },
    { key: "", value: "skipped" },
    { key: "X-Noise", value: 42 },
  ]),
  fromObject: ms.normalizeHeaderMap({
    Subject: "Hello",
    "X-Multi": ["a", "b"],
    "X-NonString": 7,
  }),
  nonObject: ms.normalizeHeaderMap("nope"),
});

record("parseHighestAmount", {
  eur: ms.parseHighestAmount("Total: EUR 1.234,56"),
  usd: ms.parseHighestAmount("$999.99 due"),
  multiple: ms.parseHighestAmount("$100 and €200 and $1,500.75"),
  none: ms.parseHighestAmount("no amounts here"),
});

record("detectDeadlineSignal", {
  today: ms.detectDeadlineSignal("please respond today"),
  german: ms.detectDeadlineSignal("bitte bis morgen antworten"),
  dateFormat: ms.detectDeadlineSignal("due by 12/04/2026"),
  none: ms.detectDeadlineSignal("ordinary mail"),
});

record("parseAddressFromList", {
  single: ms.parseAddressFromList(["alice@example.com"]),
  empty: ms.parseAddressFromList([]),
  notArray: ms.parseAddressFromList(undefined),
});

record(
  "parseMessage",
  ms.parseMessage(
    { uid: 42, messageId: "<abc@ex>", from: ["Alice <alice@example.com>"], subject: "Re: Budget $500" },
    {
      message: {
        uid: 42,
        messageId: "<abc@ex>",
        from: ["Alice <alice@example.com>"],
        subject: "Re: Budget $500",
        text: "Please approve the $500 expense by tomorrow.",
        date: "2026-04-08T08:00:00.000Z",
        headers: [
          { key: "From", value: "alice@example.com" },
          { key: "Subject", value: "Re: Budget $500" },
        ],
      },
    },
  ),
);

// -------- scoring / policy --------
record("matchGlob", {
  plain: ms.matchGlob("alice@example.com", "alice@*"),
  caseInsensitive: ms.matchGlob("Alice@Example.com", "alice@*.com"),
  no: ms.matchGlob("bob@example.com", "alice@*"),
  nonString: ms.matchGlob(42, "*"),
});

record("zoneMax", {
  redVsAmber: ms.zoneMax("red", "amber"),
  grayVsAmber: ms.zoneMax("gray", "amber"),
});
record("zoneMin", {
  redVsAmber: ms.zoneMin("red", "amber"),
  grayVsAmber: ms.zoneMin("gray", "amber"),
});
record("applyZoneFloor", {
  nullFloor: ms.applyZoneFloor("gray", null),
  raise: ms.applyZoneFloor("gray", "amber"),
  keep: ms.applyZoneFloor("red", "amber"),
});
record("applyZoneCeiling", {
  nullCeiling: ms.applyZoneCeiling("red", null),
  lower: ms.applyZoneCeiling("red", "amber"),
  keep: ms.applyZoneCeiling("gray", "amber"),
});

const samplePolicy = {
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

const sampleMessage = {
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
  amountSignal: { amount: 500 },
  deadlineDetected: false,
};

const sampleRules = {
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

const sampleState = ms.migrateState({
  messages: { "msg:<abc@ex>": { ...sampleMessage, firstSeenAt: "2026-04-07T08:00:00Z", lastSeenAt: "2026-04-08T08:00:00Z" } },
  alerts: [
    {
      alertId: "prior-1",
      subject: "Invoice #122 for $400",
      fromAddress: "alice@example.com",
      domain: "example.com",
      category: "financial-relevance",
      zone: "amber",
      sentAt: "2026-04-07T08:00:00Z",
    },
  ],
  learning: {
    senderWeights: { "alice@example.com": 1 },
    domainWeights: {},
    ruleAdjustments: { "rule-invoice": 1 },
  },
});

record("buildRuleMatches", ms.buildRuleMatches(sampleMessage, sampleState, sampleRules));
record("scoreMessage", ms.scoreMessage(sampleMessage, sampleState, sampleRules));
record("pickPrimaryCategory", {
  tieBreak: ms.pickPrimaryCategory({
    "decision-required": 2,
    "financial-relevance": 2,
    "risk-escalation": 0,
  }),
  winner: ms.pickPrimaryCategory({
    "decision-required": 1,
    "financial-relevance": 5,
    "risk-escalation": 3,
  }),
});
record("summarizeReasons", ms.summarizeReasons([
  { reason: "a", weight: 3 },
  { reason: "b", weight: 2 },
  { reason: "c", weight: -1 },
  { reason: "a", weight: 1 },
  { reason: "d", weight: 4 },
]));

record("matchesPolicyEntry", {
  senderHit: ms.matchesPolicyEntry(sampleMessage, samplePolicy.senderPolicies[0]),
  senderMiss: ms.matchesPolicyEntry(sampleMessage, { match: "bob@*.com" }),
  empty: ms.matchesPolicyEntry(sampleMessage, { match: "" }),
});

record("isTimeInSchedule", {
  inside: ms.isTimeInSchedule(new Date("2026-04-08T12:00:00Z"), "09:00-17:00"),
  outside: ms.isTimeInSchedule(new Date("2026-04-08T05:00:00Z"), "09:00-17:00"),
  crossMidnight: ms.isTimeInSchedule(new Date("2026-04-08T23:30:00Z"), "22:00-06:00"),
  invalid: ms.isTimeInSchedule(new Date("2026-04-08T12:00:00Z"), "nope"),
});

record("normalizePolicy", {
  empty: ms.normalizePolicy(undefined),
  partial: ms.normalizePolicy({ senderPolicies: [{ id: "x", match: "a@b" }] }),
});

record(
  "evaluatePolicy",
  ms.evaluatePolicy(sampleMessage, { category: "financial-relevance" }, samplePolicy, new Date("2026-04-08T12:00:00Z")),
);

record("determineZone", {
  noCandidate: ms.determineZone({
    scored: { score: 1, categoryScores: { "decision-required": 0, "financial-relevance": 1, "risk-escalation": 0 }, category: "financial-relevance" },
    policyResult: { scoreModifier: 0, zoneFloor: null, zoneCeiling: null, muted: false, minConfidence: null, reasons: [] },
    llmResult: null,
    rules: sampleRules,
  }),
  candidateNoLlm: ms.determineZone({
    scored: { score: 5, categoryScores: { "decision-required": 0, "financial-relevance": 5, "risk-escalation": 0 }, category: "financial-relevance" },
    policyResult: { scoreModifier: 0, zoneFloor: null, zoneCeiling: null, muted: false, minConfidence: null, reasons: [] },
    llmResult: null,
    rules: sampleRules,
  }),
  llmRed: ms.determineZone({
    scored: { score: 6, categoryScores: { "decision-required": 0, "financial-relevance": 6, "risk-escalation": 0 }, category: "financial-relevance" },
    policyResult: { scoreModifier: 0, zoneFloor: null, zoneCeiling: null, muted: false, minConfidence: null, reasons: [] },
    llmResult: {
      decisionRequired: true,
      financialRelevance: true,
      riskEscalation: false,
      confidence: 90,
      urgency: "high",
      reason: "clear invoice",
      deadlineDetected: true,
      amountDetected: true,
      suggestedZone: "red",
    },
    rules: sampleRules,
  }),
  muted: ms.determineZone({
    scored: { score: 6, categoryScores: { "decision-required": 0, "financial-relevance": 6, "risk-escalation": 0 }, category: "financial-relevance" },
    policyResult: { scoreModifier: 0, zoneFloor: null, zoneCeiling: null, muted: true, minConfidence: null, reasons: ["muted"] },
    llmResult: null,
    rules: sampleRules,
  }),
});

// -------- alerts / output --------
const sampleAlert = {
  alertId: "alert-1",
  zone: "red",
  category: "financial-relevance",
  subject: "Invoice $500",
  from: "Alice <alice@example.com>",
  fromAddress: "alice@example.com",
  why: "invoice due today",
  sentAt: "2026-04-08T08:00:00.000Z",
  confidence: 85,
  messageId: "<abc@ex>",
  feedbackState: "pending",
};

record("mapAlertToSummary.new", ms.mapAlertToSummary(sampleAlert, "new-alert"));
record("mapAlertToSummary.reminder", ms.mapAlertToSummary({ ...sampleAlert, lastReminderAt: "2026-04-08T12:00:00Z" }, "reminder"));
record("mapAlertToSummary.feedbackResolved", ms.mapAlertToSummary({ ...sampleAlert, feedbackState: "important" }));
record("formatAlertLine", ms.formatAlertLine(sampleAlert));
record("buildRedAlertMessage.alert", ms.buildRedAlertMessage(sampleAlert, "new-alert"));
record("buildRedAlertMessage.reminder", ms.buildRedAlertMessage({ ...sampleAlert, messageId: undefined }, "reminder"));

// buildDigestMessage and upsertSenderPolicy use randomUUID. We cannot stub
// node:crypto's randomUUID from here, so fixtures are post-processed after
// capture to normalize every UUID to a sentinel value.
record(
  "buildDigestMessage.few",
  ms.buildDigestMessage(
    [
      { ...sampleAlert, alertId: "a1", zone: "amber" },
      { ...sampleAlert, alertId: "a2", zone: "amber", subject: "Invoice $600" },
    ],
    "12h",
    "2026-04-08T12:00:00.000Z",
  ),
);
record(
  "buildDigestMessage.many",
  ms.buildDigestMessage(
    Array.from({ length: 12 }, (_, i) => ({
      ...sampleAlert,
      alertId: `a${i}`,
      subject: `Invoice #${i}`,
    })),
    "12h",
    "2026-04-08T12:00:00.000Z",
  ),
);

record(
  "formatScanResult.unconfigured",
  ms.formatScanResult({ configured: false, note: "IMAP not configured" }),
);
record(
  "formatScanResult.withAlerts",
  ms.formatScanResult({
    configured: true,
    newMessages: 3,
    redAlertsSent: 1,
    amberQueued: 2,
    digestsSent: 0,
    remindersSent: 1,
    alerts: [sampleAlert],
  }),
);
record("formatFeedbackResult.plain", ms.formatFeedbackResult({ note: "Alert marked as important.", alertId: "alert-1" }));
record(
  "formatFeedbackResult.reminder",
  ms.formatFeedbackResult({
    note: "Reminder scheduled.",
    alertId: "alert-1",
    nextReminderAt: "2026-04-08T16:00:00Z",
  }),
);
record(
  "formatFeedbackResult.policy",
  ms.formatFeedbackResult({
    note: "Policy created.",
    alertId: "alert-1",
    policyId: "pol-1",
  }),
);
record("formatListAlertsResult.empty.today", ms.formatListAlertsResult({ view: "today", alerts: [] }));
record("formatListAlertsResult.empty.recent", ms.formatListAlertsResult({ view: "recent", alerts: [] }));
record("formatListAlertsResult.withAlerts", ms.formatListAlertsResult({ view: "today", alerts: [sampleAlert] }));
record("formatDigestResult.empty", ms.formatDigestResult({ alerts: [] }));
record("formatDigestResult.withAlerts", ms.formatDigestResult({ alerts: [sampleAlert] }));
record("formatPolicyResult.empty", ms.formatPolicyResult({ policies: [] }));
record(
  "formatPolicyResult.mixed",
  ms.formatPolicyResult({
    policies: [
      { id: "p1", type: "sender", match: "alice@example.com" },
      { id: "p2", type: "category", category: "risk-escalation" },
      { id: "p3", type: "time", schedule: "09:00-17:00" },
      { id: "p4", type: "content", pattern: "invoice" },
    ],
  }),
);
record(
  "formatPolicyActionResult.withMatches",
  ms.formatPolicyActionResult({
    note: "Policy applied.",
    matches: [
      {
        from: "Alice <alice@example.com>",
        fromAddress: "alice@example.com",
        messageCount: 4,
        lastSeenAt: "2026-04-08T08:00:00Z",
      },
    ],
  }),
);
record("formatPolicyActionResult.plain", ms.formatPolicyActionResult({ note: "Nothing to do." }));

// -------- policy helpers --------
record(
  "flattenPolicies",
  ms.flattenPolicies({
    senderPolicies: [{ id: "s1", match: "a@b" }],
    domainPolicies: [{ id: "d1", match: "*.b" }],
    categoryPolicies: [{ id: "c1", category: "decision-required" }],
    contentPolicies: [{ id: "co1", pattern: "invoice" }],
    timePolicies: [{ id: "t1", schedule: "09:00-17:00" }],
    mutePolicies: [{ id: "m1", match: "noreply@*" }],
  }),
);

// -------- senders --------
const senderState = ms.migrateState({
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
});

record("collectKnownSenders", ms.collectKnownSenders(senderState));
record("findSenderCandidates.alice", ms.findSenderCandidates(senderState, "alice"));
record("findSenderCandidates.exact", ms.findSenderCandidates(senderState, "alice@example.com"));
record("findSenderCandidates.empty", ms.findSenderCandidates(senderState, ""));
record("findSenderCandidates.noMatch", ms.findSenderCandidates(senderState, "zzz"));

record("scoreSenderCandidate", {
  exact: ms.scoreSenderCandidate(
    { from: "Alice Smith <alice@example.com>", fromAddress: "alice@example.com", domain: "example.com" },
    "alice@example.com",
  ),
  display: ms.scoreSenderCandidate(
    { from: "Alice Smith <alice@example.com>", fromAddress: "alice@example.com", domain: "example.com" },
    "alice smith",
  ),
  none: ms.scoreSenderCandidate(
    { from: "Alice Smith <alice@example.com>", fromAddress: "alice@example.com", domain: "example.com" },
    "zzz",
  ),
});

record("pickResolvedSender.empty", ms.pickResolvedSender([]));
record(
  "pickResolvedSender.single",
  ms.pickResolvedSender([{ fromAddress: "a@b", score: 100, from: "A <a@b>", messageCount: 1, lastSeenAt: "x" }]),
);

record(
  "summarizeSenderCandidate",
  ms.summarizeSenderCandidate({
    from: "Alice",
    fromAddress: "alice@example.com",
    domain: "example.com",
    messageCount: 5,
    lastSeenAt: "2026-04-08T10:00:00Z",
  }),
);

// upsertSenderPolicy uses randomUUID. UUIDs are normalized post-capture.
record(
  "upsertSenderPolicy.create",
  ms.upsertSenderPolicy(ms.createDefaultPolicy(), {
    match: "alice@example.com",
    minZone: "amber",
    reason: "test",
  }),
);
record(
  "upsertSenderPolicy.updateNoop",
  ms.upsertSenderPolicy(
    {
      senderPolicies: [
        { id: "existing", match: "alice@example.com", minZone: "amber", reason: "old" },
      ],
    },
    { match: "alice@example.com", minZone: "amber", reason: "new" },
  ),
);
record(
  "upsertSenderPolicy.updateRaiseZone",
  ms.upsertSenderPolicy(
    { senderPolicies: [{ id: "existing", match: "alice@example.com", minZone: "amber" }] },
    { match: "alice@example.com", minZone: "red" },
  ),
);
record(
  "upsertSenderPolicy.clearMaxZone",
  ms.upsertSenderPolicy(
    { senderPolicies: [{ id: "existing", match: "alice@example.com", maxZone: "amber" }] },
    { match: "alice@example.com", clearMaxZone: true },
  ),
);

record("extractDisplayName", {
  withAngle: ms.extractDisplayName("Alice Smith <alice@example.com>"),
  justName: ms.extractDisplayName("Alice"),
  empty: ms.extractDisplayName(""),
});
record("tokenizeSenderText", {
  simple: ms.tokenizeSenderText("Alice Smith"),
  withEmail: ms.tokenizeSenderText("alice <alice@example.com>"),
  punct: ms.tokenizeSenderText("Alice: Smith!"),
});

// -------- llm / normalize --------
record("quoteLobsterArg", {
  simple: ms.quoteLobsterArg("hello"),
  withQuotes: ms.quoteLobsterArg('he said "hi"'),
});
record("buildLlmPrompt", ms.buildLlmPrompt());
record("buildLlmSchema", ms.buildLlmSchema());
record("normalizeLlmResult", {
  full: ms.normalizeLlmResult({
    decision_required: true,
    financial_relevance: true,
    risk_escalation: false,
    confidence: 82.7,
    urgency: "high",
    reason: "   clear   invoice   ",
    deadline_detected: true,
    amount_detected: true,
    suggested_zone: "red",
  }),
  defaults: ms.normalizeLlmResult({}),
});

// -------- thread context --------
record(
  "buildThreadContext",
  ms.buildThreadContext(senderState, {
    key: "msg:new",
    normalizedThreadSubject: "hi",
  }),
);

record(
  "queueAmberAlert.new",
  (() => {
    const s = ms.createDefaultState();
    ms.queueAmberAlert(s, "alert-1");
    ms.queueAmberAlert(s, "alert-1"); // dedupe
    ms.queueAmberAlert(s, "alert-2");
    return s.digest;
  })(),
);

record(
  "resolvePendingAmberAlerts",
  ms.resolvePendingAmberAlerts(
    ms.migrateState({
      alerts: [
        { alertId: "a1", zone: "amber", sentAt: "2026-04-08T10:00:00Z" },
        { alertId: "a2", zone: "red", sentAt: "2026-04-08T11:00:00Z" },
      ],
      digest: { pendingAmber: ["a1", "a2", "a3-missing"] },
    }),
  ),
);

record(
  "buildLlmCandidate",
  ms.buildLlmCandidate(
    sampleMessage,
    {
      score: 5,
      category: "financial-relevance",
      categoryScores: { "decision-required": 0, "financial-relevance": 5, "risk-escalation": 0 },
      matchedRuleIds: ["rule-invoice"],
      reasons: ["subject mentions an invoice"],
    },
    { reasons: ["known-good"] },
    sampleState,
  ),
);

record(
  "derivePolicyFromFeedback",
  (() => {
    const always = ms.derivePolicyFromFeedback(
      { fromAddress: "alice@example.com", zone: "amber" },
      "always-like-this",
    );
    const reduce = ms.derivePolicyFromFeedback(
      { fromAddress: "alice@example.com", zone: "red" },
      "reduce",
    );
    const notDerivable = ms.derivePolicyFromFeedback(
      { fromAddress: "alice@example.com", zone: "red" },
      "important",
    );
    const noSender = ms.derivePolicyFromFeedback({}, "always-like-this");
    return { always, reduce, notDerivable, noSender };
  })(),
);

record(
  "addPolicyEntry",
  (() => {
    const base = ms.createDefaultPolicy();
    const withSender = ms.addPolicyEntry(base, "sender", { id: "s1", match: "a@b" });
    const withDomain = ms.addPolicyEntry(withSender, "domain", { id: "d1", match: "*.b" });
    return withDomain;
  })(),
);

try {
  ms.addPolicyEntry(ms.createDefaultPolicy(), "bogus", { id: "x" });
} catch (error) {
  record("addPolicyEntry.invalid", { message: error.message });
}

record("applyLearningAdjustment", {
  increment: (() => {
    const target = { "a@b": 2 };
    ms.applyLearningAdjustment(target, "a@b", 1);
    return target;
  })(),
  decrementToFloor: (() => {
    const target = { "a@b": 0 };
    ms.applyLearningAdjustment(target, "a@b", -5, -1);
    return target;
  })(),
  removeOnZero: (() => {
    const target = { "a@b": 1 };
    ms.applyLearningAdjustment(target, "a@b", -1);
    return target;
  })(),
  emptyKey: (() => {
    const target = { "a@b": 1 };
    ms.applyLearningAdjustment(target, "", 1);
    return target;
  })(),
});

// ---- normalize UUIDs, then write fixtures ----
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const SENTINEL_UUID = "00000000-0000-0000-0000-000000000000";

const normalizeUuids = (value) => {
  if (typeof value === "string") {
    return value.replace(UUID_RE, SENTINEL_UUID);
  }
  if (Array.isArray(value)) {
    return value.map(normalizeUuids);
  }
  if (value !== null && typeof value === "object") {
    const next = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = normalizeUuids(entry);
    }
    return next;
  }
  return value;
};

await mkdir(FIXTURES_DIR, { recursive: true });
const sortedKeys = Object.keys(fixtures).sort();
for (const key of sortedKeys) {
  const safeName = key.replace(/[^a-zA-Z0-9.-]/g, "_");
  await writeFile(
    resolve(FIXTURES_DIR, `${safeName}.json`),
    `${JSON.stringify(normalizeUuids(fixtures[key]), null, 2)}\n`,
    "utf8",
  );
}
process.stdout.write(`Captured ${sortedKeys.length} fixtures into ${FIXTURES_DIR}\n`);
