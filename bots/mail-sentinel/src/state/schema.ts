import { MAX_PENDING_AMBER_ITEMS } from "../constants.js";
import type {
  MailSentinelPolicy,
  MailSentinelState,
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

export const migrateState = (state: unknown): MailSentinelState => {
  const defaults = createDefaultState();
  const source = (state ?? {}) as PartialState;
  const next: MailSentinelState = {
    ...defaults,
    ...source,
    mailbox: {
      ...defaults.mailbox,
      ...(source.mailbox ?? {}),
    },
    messages: (source.messages ?? {}) as Record<string, StoredMessage>,
    alerts: Array.isArray(source.alerts) ? (source.alerts as StoredAlert[]) : [],
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
