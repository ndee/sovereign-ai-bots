import { MAX_PENDING_AMBER_ITEMS } from "../constants.js";
import type {
  MailSentinelPolicy,
  MailSentinelState,
  ReviewRetryState,
  StoredAlert,
  StoredMessage,
} from "../types.js";

export const createDefaultPolicy = (): MailSentinelPolicy => ({
  version: 1,
  senderPolicies: [],
  domainPolicies: [],
  receiverPolicies: [],
  categoryPolicies: [],
  contentPolicies: [],
  timePolicies: [],
  mutePolicies: [],
});

export const createDefaultState = (): MailSentinelState => ({
  version: 2,
  lastPollAt: undefined,
  lastAlertAt: undefined,
  lastImapSuccessAt: undefined,
  lastError: undefined,
  consecutiveFailures: 0,
  lastScanLlmFailures: undefined,
  lastScanCandidates: undefined,
  lastScanWarnings: undefined,
  degradationState: undefined,
  mailbox: {
    lastSeenUid: undefined,
    uidValidity: undefined,
  },
  messages: {},
  alerts: [],
  feedback: [],
  learning: {
    senderWeights: {},
    domainWeights: {},
    ruleAdjustments: {},
  },
  digest: {
    pendingAmber: [],
    lastDigestAt: undefined,
  },
  zoneHistory: [],
});

type PartialState = Partial<MailSentinelState> & {
  mailbox?: Partial<MailSentinelState["mailbox"]>;
  learning?: Partial<MailSentinelState["learning"]>;
  digest?: Partial<MailSentinelState["digest"]>;
};

/**
 * Coerce a persisted degradation counter (F-01). State files written before the
 * degradation fields existed simply omit them, and a hand-edited file could
 * carry anything; either way the counter must land on `undefined` rather than
 * poisoning `deriveDegradationState` with a NaN or a string.
 */
const readCounter = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const REVIEW_RETRY_STATUSES = new Set<string>(["retrying", "exhausted", "reviewed", "stopped"]);

/**
 * A review retry drives AI calls, so one the scan cannot read safely (a
 * hand-edited or truncated state file) is dropped rather than guessed at: the
 * alert then simply keeps its fallback zone, and the ledger sweep closes its
 * entry.
 */
const isReviewRetryState = (value: unknown): value is ReviewRetryState => {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const review = value as Partial<Record<keyof ReviewRetryState, unknown>>;
  return (
    typeof review.status === "string" &&
    REVIEW_RETRY_STATUSES.has(review.status) &&
    typeof review.attempts === "number" &&
    Number.isInteger(review.attempts) &&
    review.attempts >= 0 &&
    typeof review.firstFailedAt === "string" &&
    typeof review.ledgerKey === "string"
  );
};

const migrateAlert = (alert: StoredAlert): StoredAlert => {
  if (alert.review === undefined || isReviewRetryState(alert.review)) {
    return alert;
  }
  const { review: _dropped, ...rest } = alert;
  return rest;
};

export const migrateState = (state: unknown): MailSentinelState => {
  const defaults = createDefaultState();
  const source = (state ?? {}) as PartialState;
  const next: MailSentinelState = {
    ...defaults,
    ...source,
    lastScanLlmFailures: readCounter(source.lastScanLlmFailures),
    lastScanCandidates: readCounter(source.lastScanCandidates),
    lastScanWarnings: readCounter(source.lastScanWarnings),
    degradationState:
      typeof source.degradationState === "string" ? source.degradationState : undefined,
    mailbox: {
      ...defaults.mailbox,
      ...(source.mailbox ?? {}),
    },
    messages: (source.messages ?? {}) as Record<string, StoredMessage>,
    alerts: Array.isArray(source.alerts) ? (source.alerts as StoredAlert[]).map(migrateAlert) : [],
    feedback: Array.isArray(source.feedback) ? source.feedback : [],
    learning: {
      ...defaults.learning,
      ...(source.learning ?? {}),
      senderWeights: source.learning?.senderWeights ?? {},
      domainWeights: source.learning?.domainWeights ?? {},
      ruleAdjustments: source.learning?.ruleAdjustments ?? {},
    },
    digest: {
      ...defaults.digest,
      ...(source.digest ?? {}),
      pendingAmber: Array.isArray(source.digest?.pendingAmber) ? source.digest.pendingAmber : [],
    },
    zoneHistory: Array.isArray(source.zoneHistory) ? source.zoneHistory : [],
  };
  next.version = 2;
  return next;
};

export const pruneState = (state: MailSentinelState): MailSentinelState => {
  const retainedMessages = Object.values(state.messages)
    .sort((left, right) => left.lastSeenAt.localeCompare(right.lastSeenAt))
    .slice(-5000);
  state.messages = Object.fromEntries(retainedMessages.map((entry) => [entry.key, entry]));
  state.alerts = state.alerts
    .slice()
    .sort((left, right) => left.sentAt.localeCompare(right.sentAt))
    .slice(-500);
  state.feedback = state.feedback
    .slice()
    .sort((left, right) => left.at.localeCompare(right.at))
    .slice(-1000);
  state.zoneHistory = state.zoneHistory
    .slice()
    .sort((left, right) => left.at.localeCompare(right.at))
    .slice(-1000);
  // Drop pending-amber IDs whose alert was just pruned out of `state.alerts`.
  // `resolvePendingAmberAlerts` resolves each pending ID against `state.alerts`
  // and silently discards dangling ones; without this, a red-heavy mailbox can
  // evict a queued amber alert from the newest-500 while its ID lingers in
  // `pendingAmber`, leaving the digest permanently empty (it is only cleared on
  // an actual send, which never happens with zero resolvable items). Applied
  // before the count cap so the cap sees only live IDs.
  const retainedAlertIds = new Set(state.alerts.map((alert) => alert.alertId));
  state.digest.pendingAmber = state.digest.pendingAmber
    .filter((alertId) => retainedAlertIds.has(alertId))
    .slice(-MAX_PENDING_AMBER_ITEMS);
  return state;
};

export const normalizePolicy = (policy: unknown): MailSentinelPolicy => {
  const source = (policy ?? {}) as Partial<MailSentinelPolicy>;
  return {
    ...createDefaultPolicy(),
    ...source,
    senderPolicies: Array.isArray(source.senderPolicies) ? source.senderPolicies : [],
    domainPolicies: Array.isArray(source.domainPolicies) ? source.domainPolicies : [],
    receiverPolicies: Array.isArray(source.receiverPolicies) ? source.receiverPolicies : [],
    categoryPolicies: Array.isArray(source.categoryPolicies) ? source.categoryPolicies : [],
    contentPolicies: Array.isArray(source.contentPolicies) ? source.contentPolicies : [],
    timePolicies: Array.isArray(source.timePolicies) ? source.timePolicies : [],
    mutePolicies: Array.isArray(source.mutePolicies) ? source.mutePolicies : [],
  };
};
