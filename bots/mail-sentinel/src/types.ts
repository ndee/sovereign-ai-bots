export type Zone = "gray" | "amber" | "red";

export type Category = "decision-required" | "financial-relevance" | "risk-escalation";

export type FeedbackState =
  | "pending"
  | "important"
  | "not-important"
  | "less-often"
  | "always-like-this"
  | "reduce"
  | "digest-only";

export type FeedbackAction =
  | "important"
  | "not-important"
  | "less-often"
  | "remind-later"
  | "always-like-this"
  | "reduce"
  | "digest-only";

export interface AmountSignal {
  amount: number;
}

export interface ParsedMessage {
  key: string;
  uid: number;
  messageId?: string | undefined;
  subject: string;
  normalizedThreadSubject: string;
  from: string;
  fromAddress?: string | undefined;
  domain?: string | undefined;
  date?: string | undefined;
  text: string;
  snippet: string;
  headers: Record<string, string>;
  /**
   * Union of every recipient address (To + Cc fields and the to/cc/delivered-to
   * headers). Kept as the backward-compatible surface an untargeted receiver
   * rule matches against and the list `scan.ts` persists onto the message.
   */
  toAddresses: string[];
  /** Cc recipients only (Cc field + `cc` header). Matched by `target: "cc"`. */
  ccAddresses?: string[] | undefined;
  /**
   * Addresses from the `Delivered-To` header only — the mailbox the MTA handed
   * the message to. Matched by `target: "delivered_to"`.
   */
  deliveredToAddresses?: string[] | undefined;
  /**
   * Alias / catch-all the message was routed to, recovered from alias-revealing
   * headers (`x-original-to`, `envelope-to`, `x-forwarded-to`). Matched by
   * `target: "alias"`.
   */
  aliasTargets?: string[] | undefined;
  amountSignal: AmountSignal | null;
  deadlineDetected: boolean;
}

export interface StoredMessage {
  key: string;
  uid: number;
  messageId?: string | undefined;
  subject: string;
  normalizedThreadSubject?: string | undefined;
  from: string;
  fromAddress?: string | undefined;
  domain?: string | undefined;
  date?: string | undefined;
  snippet: string;
  toAddresses?: string[] | undefined;
  firstSeenAt: string;
  lastSeenAt: string;
  alertId?: string | undefined;
}

export interface StoredAlert {
  alertId: string;
  /**
   * Stable short handle for this alert — a lowercase prefix of `alertId`,
   * minted at alert creation and lengthened only on collision. Optional so
   * pre-existing persisted alerts (minted before this field existed) remain
   * valid; callers derive a fallback prefix when it is absent.
   */
  shortRef?: string | undefined;
  messageKey?: string | undefined;
  uid?: number | undefined;
  messageId?: string | undefined;
  zone: Zone;
  category: Category;
  subject: string;
  from: string;
  fromAddress?: string | undefined;
  domain?: string | undefined;
  toAddresses?: string[] | undefined;
  why: string;
  /**
   * Short, capped, message-evidence excerpt copied onto the alert at scan time
   * (not looked up at render). Derived solely from the local message snippet —
   * never a remote fetch — so the alert is self-contained and survives
   * `pruneState`. Optional: pre-existing persisted alerts (and alerts whose
   * message had no snippet) simply render without an excerpt block.
   */
  excerpt?: string | undefined;
  sentAt: string;
  score?: number | undefined;
  adjustedScore?: number | undefined;
  categoryScores?: Record<string, number> | undefined;
  reasons?: string[] | undefined;
  matchedRuleIds?: string[] | undefined;
  feedbackState?: FeedbackState | undefined;
  feedbackAt?: string | undefined;
  reminderDueAt?: string | undefined;
  lastReminderAt?: string | undefined;
  digestSentAt?: string | undefined;
  policyModifiers?: string[] | undefined;
  llmResult?: LlmResult | null | undefined;
  confidence?: number | undefined;
}

export interface AlertSummary {
  alertId: string;
  shortRef: string;
  kind: "new-alert" | "reminder" | "digest";
  zone: Zone;
  category: Category;
  subject: string;
  from: string;
  why: string;
  sentAt: string;
  confidence?: number | undefined;
  messageId?: string | undefined;
  feedbackState?: FeedbackState | undefined;
}

export interface FeedbackEntry {
  alertId: string;
  action: FeedbackAction;
  at: string;
  delay?: string | undefined;
  policyId?: string | undefined;
}

export interface LearningState {
  senderWeights: Record<string, number>;
  domainWeights: Record<string, number>;
  ruleAdjustments: Record<string, number>;
}

export interface DigestState {
  pendingAmber: string[];
  lastDigestAt?: string | undefined;
  /**
   * Ordered `alertId`s of the items shown in the most recently *sent* digest.
   * Persisted at flush so positional feedback ("item 3") resolves against the
   * order the user actually saw, not a freshly re-rendered digest.
   */
  lastDigestAlertIds?: string[] | undefined;
}

export interface MailboxState {
  lastSeenUid?: number | undefined;
  uidValidity?: string | undefined;
}

export interface StateErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ZoneHistoryEntry {
  at: string;
  messageKey: string;
  zone: Zone;
  reason: string;
}

export interface MailSentinelState {
  version: number;
  lastPollAt?: string | undefined;
  lastAlertAt?: string | undefined;
  lastImapSuccessAt?: string | undefined;
  lastError?: StateErrorInfo | undefined;
  consecutiveFailures: number;
  mailbox: MailboxState;
  messages: Record<string, StoredMessage>;
  alerts: StoredAlert[];
  feedback: FeedbackEntry[];
  learning: LearningState;
  digest: DigestState;
  zoneHistory: ZoneHistoryEntry[];
}

export type PolicyScope = "subject" | "body" | "snippet" | "any";

/**
 * Which recipient field a `receiver` policy matches against. Omitting the target
 * keeps the legacy union behaviour (match any recipient in `toAddresses`).
 */
export type ReceiverTarget = "to" | "cc" | "delivered_to" | "alias";

export interface PolicyEntryBase {
  id?: string | undefined;
  match?: string | undefined;
  pattern?: string | undefined;
  scope?: PolicyScope | undefined;
  target?: ReceiverTarget | undefined;
  flags?: string | undefined;
  category?: Category | string | undefined;
  schedule?: string | undefined;
  minZone?: Zone | undefined;
  maxZone?: Zone | undefined;
  reason?: string | undefined;
  boost?: number | undefined;
  amountThreshold?: number | undefined;
  minConfidence?: number | undefined;
  action?: "mute" | undefined;
  muted?: boolean | undefined;
}

export interface MailSentinelPolicy {
  version: number;
  senderPolicies: PolicyEntryBase[];
  domainPolicies: PolicyEntryBase[];
  categoryPolicies: PolicyEntryBase[];
  contentPolicies: PolicyEntryBase[];
  timePolicies: PolicyEntryBase[];
  receiverPolicies: PolicyEntryBase[];
  mutePolicies: PolicyEntryBase[];
}

export type PolicyType =
  | "sender"
  | "domain"
  | "receiver"
  | "category"
  | "content"
  | "time"
  | "mute";

export interface FlattenedPolicyEntry extends PolicyEntryBase {
  type: PolicyType;
}

export interface RuleEntry {
  id: string;
  field: "subject" | "text" | "from" | "domain" | "header";
  headerName?: string | undefined;
  pattern: string;
  flags?: string | undefined;
  weight: number;
  reason: string;
  categories?: string[] | undefined;
}

export interface RuleMatch {
  ruleId: string;
  reason: string;
  weight: number;
  categories: string[];
}

/**
 * Tunables for the bulk/newsletter suppression layer. The detector caps a
 * message's zone (never RED) *before* the user policy floor is applied, so an
 * explicit user floor always wins. Defaults are conservative (require ≥2
 * distinct signals) to protect transactional mail riding bulk infrastructure.
 */
export interface BulkConfig {
  /** Master switch; when false the detector is a no-op. */
  enabled: boolean;
  /** Minimum distinct bulk signals before a message is treated as bulk. */
  minSignals: number;
  /** Outbound-link count that counts as a "high link density" signal. */
  minLinks: number;
  /** Confidence at/above which the cap tightens from amber to gray. */
  grayConfidence: number;
}

export interface RulesDocument {
  version: number;
  thresholds: {
    candidate: number;
    alert: number;
    category: number;
  };
  zoneThresholds: {
    redMinConfidence: number;
    amberMinConfidence: number;
    redMinHeuristicScore: number;
    amberMinHeuristicScore: number;
  };
  defaultReminderDelay?: string | undefined;
  senderWeights: Record<string, number>;
  domainWeights: Record<string, number>;
  bulk: BulkConfig;
  rules: RuleEntry[];
}

export interface ScoredMessage {
  candidate: boolean;
  relevant: boolean;
  score: number;
  category: Category;
  categoryScores: Record<string, number>;
  reasons: string[];
  matchedRuleIds: string[];
}

export interface PolicyEvaluationResult {
  scoreModifier: number;
  zoneFloor: Zone | null;
  zoneCeiling: Zone | null;
  muted: boolean;
  minConfidence: number | null;
  reasons: string[];
  matchedPolicyIds: string[];
}

export interface LlmResult {
  decisionRequired: boolean;
  financialRelevance: boolean;
  riskEscalation: boolean;
  confidence: number;
  urgency: "low" | "medium" | "high";
  reason: string;
  deadlineDetected: boolean;
  amountDetected: boolean;
  suggestedZone: Zone;
}

export interface ZoneDecision {
  zone: Zone;
  adjustedScore: number;
  reasons: string[];
}

export interface CommandOptions {
  json: boolean;
  subcommand?: string | undefined;
  instance?: string | undefined;
  configPath?: string | undefined;
  alertId?: string | undefined;
  ref?: string | undefined;
  action?: FeedbackAction | undefined;
  delay?: string | undefined;
  view?: "today" | "recent" | string | undefined;
  limit?: string | undefined;
  type?: PolicyType | string | undefined;
  match?: string | undefined;
  minZone?: Zone | string | undefined;
  maxZone?: Zone | string | undefined;
  boost?: string | undefined;
  reason?: string | undefined;
  id?: string | undefined;
  category?: string | undefined;
  schedule?: string | undefined;
  pattern?: string | undefined;
  scope?: PolicyScope | string | undefined;
  target?: ReceiverTarget | string | undefined;
  contains?: string | undefined;
  amountThreshold?: string | undefined;
  query?: string | undefined;
  announce?: boolean | undefined;
  latest?: boolean | undefined;
}

export interface KnownSender {
  from: string;
  fromAddress: string;
  domain?: string | undefined;
  messageCount: number;
  lastSeenAt: string;
}

export interface ScoredSenderCandidate extends KnownSender {
  score: number;
}

export interface ThreadContextEntry {
  subject: string;
  from: string;
  snippet: string;
  date?: string;
}

export interface LlmCandidate {
  subject: string;
  from: string;
  snippet: string;
  threadContext: ThreadContextEntry[];
  heuristicSignals: {
    candidateScore: number;
    category: string;
    categoryScores: Record<string, number>;
    matchedRules: string[];
    reasons: string[];
  };
  policyHints: string[];
  extractedSignals: {
    deadlineDetected: boolean;
    amountDetected: boolean;
    amount: number | null;
  };
}

export interface DerivedPolicy {
  id: string;
  type: PolicyType;
  entry: PolicyEntryBase;
}
