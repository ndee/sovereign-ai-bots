#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_CONFIG_PATH = "/etc/sovereign-node/sovereign-node.json5";
const DEFAULT_STATE_PATH = "data/mail-sentinel-state.json";
const DEFAULT_RULES_PATH = "config/default-rules.json";
const DEFAULT_POLICY_PATH = "config/user-policy.json";
const DEFAULT_IMAP_INSTANCE_ID = "mail-sentinel-imap";
const DEFAULT_LOOKBACK_WINDOW = "1h";
const DEFAULT_REMINDER_DELAY = "4h";
const DEFAULT_DIGEST_INTERVAL = "12h";
const DEFAULT_IMAP_SEARCH_LIMIT = 50;
const DEFAULT_IMAP_READ_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_STATE_LOCK_RETRY_DELAY_MS = 50;
const DEFAULT_STATE_LOCK_RETRY_ATTEMPTS = 200;
const DEFAULT_STATE_LOCK_STALE_MS = 5 * 60 * 1000;
const DEFAULT_TOOL_EXECUTABLE = "/usr/local/bin/sovereign-tool";
const DEFAULT_AGENT_ID = "mail-sentinel";
const DEFAULT_OPENCLAW_URL = "http://127.0.0.1:18789";
const DEFAULT_LLM_MODEL = "qwen/qwen3.5-9b";
const DEFAULT_LLM_TIMEOUT_MS = 30_000;
const RULE_ADJUSTMENT_FLOOR = -1;
const MAX_THREAD_CONTEXT_ENTRIES = 2;
const MAX_PENDING_AMBER_ITEMS = 200;

const CATEGORY_LABELS = {
  "decision-required": "Decision Required",
  "financial-relevance": "Financial Relevance",
  "risk-escalation": "Risk / Escalation",
};

const ZONE_ORDER = {
  gray: 0,
  amber: 1,
  red: 2,
};

const normalizeMessageId = (value) => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.toLowerCase();
  }
  return trimmed.includes("@") ? `<${trimmed.toLowerCase()}>` : trimmed.toLowerCase();
};

const normalizeEmailAddress = (value) => {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = value.match(/<([^>]+)>/);
  const candidate = (match?.[1] ?? value).trim().toLowerCase();
  return candidate.length === 0 ? undefined : candidate;
};

const extractDomain = (address) => {
  if (typeof address !== "string") {
    return undefined;
  }
  const index = address.lastIndexOf("@");
  if (index < 0 || index === address.length - 1) {
    return undefined;
  }
  return address.slice(index + 1).toLowerCase();
};

const compactText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const stripSingleTrailingNewline = (value) => value.replace(/\r?\n$/, "");

const ensureTrailingSlash = (value) => (value.endsWith("/") ? value : `${value}/`);

const nowIso = () => new Date().toISOString();

const normalizeThreadSubject = (value) =>
  compactText(String(value ?? "").toLowerCase().replace(/^(re|aw|fw|fwd):\s*/i, ""));

const parseDurationMs = (value) => {
  const match = String(value)
    .trim()
    .toLowerCase()
    .match(/^([0-9]+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/);
  if (match === null) {
    throw new Error(`Unsupported duration '${String(value)}'`);
  }
  const amount = Number.parseInt(match[1] ?? "0", 10);
  const unit = match[2] ?? "m";
  const multiplier = unit.startsWith("d")
    ? 24 * 60 * 60 * 1000
    : unit.startsWith("h")
      ? 60 * 60 * 1000
      : 60 * 1000;
  return amount * multiplier;
};

const clampLimit = (value, max) => {
  if (value === undefined) {
    return max;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Expected a positive integer limit");
  }
  return Math.min(parsed, max);
};

const parseRuntimeConfigDocument = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return Function(`"use strict"; return (${raw});`)();
  }
};

const parseJsonSafely = (raw) => {
  try {
    return JSON.parse(stripSingleTrailingNewline(raw));
  } catch {
    return null;
  }
};

const resolveSecretRefValue = async (secretRef) => {
  if (typeof secretRef !== "string" || secretRef.length === 0) {
    throw new Error("Missing secret reference");
  }
  if (secretRef.startsWith("file:")) {
    const value = stripSingleTrailingNewline(await readFile(secretRef.slice(5), "utf8"));
    if (value.length === 0) {
      throw new Error(`Secret file for ${secretRef} is empty`);
    }
    return value;
  }
  if (secretRef.startsWith("env:")) {
    const key = secretRef.slice(4);
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    throw new Error(`Environment variable ${key} is not set`);
  }
  throw new Error(`Unsupported secretRef format: ${secretRef}`);
};

const resolveRelativeToBase = (value, baseDir) =>
  isAbsolute(value) ? value : resolve(baseDir, value);

const sortAlertsNewestFirst = (alerts) =>
  alerts.slice().sort((left, right) => right.sentAt.localeCompare(left.sentAt));

const formatAlertLine = (alert) =>
  `- [${alert.alertId}] ${String(alert.zone ?? "red").toUpperCase()} | ${CATEGORY_LABELS[alert.category] ?? alert.category} | ${alert.from} | ${alert.subject}`;

const parseAddressFromList = (addresses) => {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return "(unknown sender)";
  }
  return String(addresses[0]);
};

const createRegex = (rule) => new RegExp(rule.pattern, rule.flags ?? "iu");

const summarizeReasons = (matches) => {
  const unique = new Set();
  return matches
    .filter((entry) => entry.weight > 0)
    .sort((left, right) => Math.abs(right.weight) - Math.abs(left.weight))
    .flatMap((entry) => {
      if (unique.has(entry.reason)) {
        return [];
      }
      unique.add(entry.reason);
      return [entry.reason];
    })
    .slice(0, 3);
};

const applyLearningAdjustment = (target, key, delta, floor) => {
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

const buildMessageKey = (messageId, uid) =>
  messageId === undefined ? `uid:${String(uid)}` : `msg:${messageId}`;

const startOfLocalDay = (value) => {
  const local = new Date(value);
  local.setHours(0, 0, 0, 0);
  return local.getTime();
};

const isSameLocalDay = (value, reference) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && startOfLocalDay(parsed) === startOfLocalDay(reference);
};

const formatConfidenceLabel = (confidence) => {
  if (typeof confidence !== "number") {
    return "unbekannt";
  }
  if (confidence >= 75) {
    return `hoch (${confidence}%)`;
  }
  if (confidence >= 40) {
    return `mittel (${confidence}%)`;
  }
  return `niedrig (${confidence}%)`;
};

const createDefaultPolicy = () => ({
  version: 1,
  senderPolicies: [],
  domainPolicies: [],
  categoryPolicies: [],
  contentPolicies: [],
  timePolicies: [],
  mutePolicies: [],
});

const createDefaultState = () => ({
  version: 2,
  lastPollAt: undefined,
  lastAlertAt: undefined,
  lastImapSuccessAt: undefined,
  lastError: undefined,
  consecutiveFailures: 0,
  mailbox: {
    lastSeenUid: undefined,
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

const migrateState = (state) => {
  const defaults = createDefaultState();
  const next = {
    ...defaults,
    ...(state ?? {}),
    mailbox: {
      ...defaults.mailbox,
      ...(state?.mailbox ?? {}),
    },
    messages: state?.messages ?? {},
    alerts: Array.isArray(state?.alerts) ? state.alerts : [],
    feedback: Array.isArray(state?.feedback) ? state.feedback : [],
    learning: {
      ...defaults.learning,
      ...(state?.learning ?? {}),
      senderWeights: state?.learning?.senderWeights ?? {},
      domainWeights: state?.learning?.domainWeights ?? {},
      ruleAdjustments: state?.learning?.ruleAdjustments ?? {},
    },
    digest: {
      ...defaults.digest,
      ...(state?.digest ?? {}),
      pendingAmber: Array.isArray(state?.digest?.pendingAmber) ? state.digest.pendingAmber : [],
    },
    zoneHistory: Array.isArray(state?.zoneHistory) ? state.zoneHistory : [],
  };
  next.version = 2;
  return next;
};

const pruneState = (state) => {
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
  state.digest.pendingAmber = state.digest.pendingAmber.slice(-MAX_PENDING_AMBER_ITEMS);
  return state;
};

const parseArgs = (argv) => {
  const args = [...argv];
  const command = args.shift();
  const options = {
    json: false,
  };
  if (command === "policy" && args[0] !== undefined && !String(args[0]).startsWith("--")) {
    options.subcommand = args.shift();
  }
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--announce") {
      options.announce = true;
      continue;
    }
    if (token === "--latest") {
      options.latest = true;
      continue;
    }
    const keyedOptions = new Set([
      "--instance",
      "--config-path",
      "--alert-id",
      "--action",
      "--delay",
      "--view",
      "--limit",
      "--type",
      "--match",
      "--min-zone",
      "--max-zone",
      "--boost",
      "--reason",
      "--id",
      "--category",
      "--schedule",
      "--pattern",
      "--amount-threshold",
      "--query",
    ]);
    if (!keyedOptions.has(token)) {
      throw new Error(`Unknown argument: ${token}`);
    }
    if (args.length === 0) {
      throw new Error(`Missing value for ${token}`);
    }
    const value = args.shift();
    if (token === "--instance") options.instance = value;
    if (token === "--config-path") options.configPath = value;
    if (token === "--alert-id") options.alertId = value;
    if (token === "--action") options.action = value;
    if (token === "--delay") options.delay = value;
    if (token === "--view") options.view = value;
    if (token === "--limit") options.limit = value;
    if (token === "--type") options.type = value;
    if (token === "--match") options.match = value;
    if (token === "--min-zone") options.minZone = value;
    if (token === "--max-zone") options.maxZone = value;
    if (token === "--boost") options.boost = value;
    if (token === "--reason") options.reason = value;
    if (token === "--id") options.id = value;
    if (token === "--category") options.category = value;
    if (token === "--schedule") options.schedule = value;
    if (token === "--pattern") options.pattern = value;
    if (token === "--amount-threshold") options.amountThreshold = value;
    if (token === "--query") options.query = value;
  }
  return {
    command,
    options,
  };
};

const readJsonFile = async (filePath, fallback) => {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(stripSingleTrailingNewline(raw));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
};

const writeJsonFile = async (filePath, value) => {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
};

const withLockedState = async (statePath, action) => {
  const lockPath = `${statePath}.lock`;
  let handle;
  for (let attempt = 0; attempt < DEFAULT_STATE_LOCK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(dirname(lockPath), { recursive: true });
      handle = await open(lockPath, "wx");
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > DEFAULT_STATE_LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, DEFAULT_STATE_LOCK_RETRY_DELAY_MS));
    }
  }
  if (handle === undefined) {
    throw new Error(`Timed out while waiting for the state lock on ${statePath}`);
  }
  try {
    return await action();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
};

const normalizeHeaderMap = (value) => {
  if (Array.isArray(value)) {
    const entries = value.flatMap((entry) => {
      if (entry && typeof entry === "object") {
        const key = compactText(entry.key ?? entry.name ?? "").toLowerCase();
        const headerValue = entry.value;
        if (key.length > 0 && typeof headerValue === "string") {
          return [[key, compactText(headerValue)]];
        }
      }
      return [];
    });
    return Object.fromEntries(entries);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, headerValue]) => {
        if (Array.isArray(headerValue)) {
          return [[key.toLowerCase(), compactText(headerValue.join(", "))]];
        }
        if (typeof headerValue === "string") {
          return [[key.toLowerCase(), compactText(headerValue)]];
        }
        return [];
      }),
    );
  }
  return {};
};

const parseHighestAmount = (text) => {
  const raw = String(text ?? "");
  const patterns = [
    /(?:€|eur|euro|\$|usd)\s*([0-9][0-9.,]*)/giu,
    /([0-9][0-9.,]*)\s*(?:€|eur|euro|\$|usd)/giu,
  ];
  let best = null;
  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern)) {
      const numericText = String(match[1] ?? "");
      const normalized = numericText
        .replace(/\.(?=.*[,])/g, "")
        .replace(/,(?=\d{3}(?:\D|$))/g, "")
        .replace(/,/g, ".");
      const amount = Number.parseFloat(normalized);
      if (Number.isFinite(amount) && (best === null || amount > best.amount)) {
        best = {
          amount,
        };
      }
    }
  }
  return best;
};

const detectDeadlineSignal = (text) =>
  /\b(heute|today|morgen|tomorrow|friday|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?)\b/i.test(
    String(text ?? ""),
  );

const matchGlob = (value, pattern) => {
  if (typeof value !== "string" || typeof pattern !== "string") {
    return false;
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "iu").test(value);
};

const zoneMax = (left, right) =>
  ZONE_ORDER[left] >= ZONE_ORDER[right] ? left : right;

const zoneMin = (left, right) =>
  ZONE_ORDER[left] <= ZONE_ORDER[right] ? left : right;

const applyZoneFloor = (current, floor) => (floor === null ? current : zoneMax(current, floor));

const applyZoneCeiling = (current, ceiling) => (ceiling === null ? current : zoneMin(current, ceiling));

const matchesPolicyEntry = (message, entry) => {
  const candidate = entry.match ?? entry.pattern;
  if (typeof candidate !== "string" || candidate.length === 0) {
    return false;
  }
  return [message.fromAddress, message.from, message.domain]
    .filter((value) => typeof value === "string")
    .some((value) => matchGlob(value, candidate));
};

const isTimeInSchedule = (date, schedule) => {
  if (typeof schedule !== "string") {
    return false;
  }
  const match = schedule.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (match === null) {
    return false;
  }
  const startMinutes = Number.parseInt(match[1], 10) * 60 + Number.parseInt(match[2], 10);
  const endMinutes = Number.parseInt(match[3], 10) * 60 + Number.parseInt(match[4], 10);
  const currentMinutes = date.getHours() * 60 + date.getMinutes();
  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
};

const normalizePolicy = (policy) => ({
  ...createDefaultPolicy(),
  ...(policy ?? {}),
  senderPolicies: Array.isArray(policy?.senderPolicies) ? policy.senderPolicies : [],
  domainPolicies: Array.isArray(policy?.domainPolicies) ? policy.domainPolicies : [],
  categoryPolicies: Array.isArray(policy?.categoryPolicies) ? policy.categoryPolicies : [],
  contentPolicies: Array.isArray(policy?.contentPolicies) ? policy.contentPolicies : [],
  timePolicies: Array.isArray(policy?.timePolicies) ? policy.timePolicies : [],
  mutePolicies: Array.isArray(policy?.mutePolicies) ? policy.mutePolicies : [],
});

const evaluatePolicy = (message, scored, policy, referenceDate) => {
  const normalized = normalizePolicy(policy);
  const result = {
    scoreModifier: 0,
    zoneFloor: null,
    zoneCeiling: null,
    muted: false,
    minConfidence: null,
    reasons: [],
    matchedPolicyIds: [],
  };
  const noteMatch = (entry, reason) => {
    result.reasons.push(reason ?? entry.reason ?? "policy matched");
    if (typeof entry.id === "string") {
      result.matchedPolicyIds.push(entry.id);
    }
    if (typeof entry.boost === "number" && Number.isFinite(entry.boost)) {
      result.scoreModifier += entry.boost;
    }
    if (typeof entry.minZone === "string" && ZONE_ORDER[entry.minZone] !== undefined) {
      result.zoneFloor = result.zoneFloor === null ? entry.minZone : zoneMax(result.zoneFloor, entry.minZone);
    }
    if (typeof entry.maxZone === "string" && ZONE_ORDER[entry.maxZone] !== undefined) {
      result.zoneCeiling =
        result.zoneCeiling === null ? entry.maxZone : zoneMin(result.zoneCeiling, entry.maxZone);
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
    if (matchesPolicyEntry(message, entry) || matchGlob(message.fromAddress ?? "", entry.match ?? "")) {
      noteMatch(entry);
    }
  }

  for (const entry of normalized.domainPolicies) {
    if (matchGlob(message.domain ?? "", entry.match ?? "")) {
      noteMatch(entry);
    }
  }

  for (const entry of normalized.categoryPolicies) {
    if (entry.category === scored.category) {
      noteMatch(entry);
    }
  }

  const combinedText = `${message.subject}\n${message.text}`;
  for (const entry of normalized.contentPolicies) {
    if (typeof entry.pattern !== "string") {
      continue;
    }
    const regex = new RegExp(entry.pattern, entry.flags ?? "iu");
    if (!regex.test(combinedText)) {
      continue;
    }
    if (typeof entry.amountThreshold === "number") {
      const amountSignal = parseHighestAmount(combinedText);
      if (amountSignal === null || amountSignal.amount < entry.amountThreshold) {
        continue;
      }
    }
    noteMatch(entry);
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

const buildRuleMatches = (message, state, rules) => {
  const matches = [];
  const senderAdjustment =
    (rules.senderWeights[message.fromAddress ?? ""] ?? 0) +
    (state.learning.senderWeights[message.fromAddress ?? ""] ?? 0);
  if (senderAdjustment !== 0 && message.fromAddress !== undefined) {
    matches.push({
      ruleId: `sender:${message.fromAddress}`,
      reason:
        senderAdjustment > 0
          ? "sender has been rated as important before"
          : "sender has been down-weighted by feedback",
      weight: senderAdjustment,
      categories: [],
    });
  }

  const domainAdjustment =
    (rules.domainWeights[message.domain ?? ""] ?? 0) +
    (state.learning.domainWeights[message.domain ?? ""] ?? 0);
  if (domainAdjustment !== 0 && message.domain !== undefined) {
    matches.push({
      ruleId: `domain:${message.domain}`,
      reason:
        domainAdjustment > 0
          ? "sender domain has been rated as important before"
          : "sender domain has been down-weighted by feedback",
      weight: domainAdjustment,
      categories: [],
    });
  }

  for (const rule of rules.rules) {
    const regex = createRegex(rule);
    const candidate =
      rule.field === "subject"
        ? message.subject
        : rule.field === "text"
          ? message.text
          : rule.field === "from"
            ? message.from
            : rule.field === "domain"
              ? (message.domain ?? "")
              : rule.field === "header"
                ? (message.headers[String(rule.headerName ?? "").toLowerCase()] ?? "")
                : "";
    if (candidate.length === 0 || !regex.test(candidate)) {
      continue;
    }
    matches.push({
      ruleId: rule.id,
      reason: rule.reason,
      weight: rule.weight + (state.learning.ruleAdjustments[rule.id] ?? 0),
      categories: Array.isArray(rule.categories) ? rule.categories : [],
    });
  }

  const priorAlert = state.alerts
    .slice()
    .reverse()
    .find(
      (alert) =>
        normalizeThreadSubject(alert.subject) === normalizeThreadSubject(message.subject) &&
        (alert.fromAddress === message.fromAddress || alert.domain === message.domain),
    );
  if (priorAlert !== undefined) {
    matches.push({
      ruleId: "thread:prior-subject-match",
      reason: "continues a subject thread that already mattered before",
      weight: 2,
      categories: [priorAlert.category],
    });
  }

  return matches;
};

const pickPrimaryCategory = (scores) =>
  Object.entries(scores)
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0]);
    })[0]?.[0] ?? "decision-required";

const scoreMessage = (message, state, rules) => {
  const matches = buildRuleMatches(message, state, rules);
  const categoryScores = {
    "decision-required": 0,
    "financial-relevance": 0,
    "risk-escalation": 0,
  };
  let score = 0;
  for (const match of matches) {
    score += match.weight;
    for (const category of match.categories) {
      if (categoryScores[category] !== undefined) {
        categoryScores[category] += match.weight;
      }
    }
  }
  const category = pickPrimaryCategory(categoryScores);
  const candidate = score >= rules.thresholds.candidate;
  const relevant =
    score >= rules.thresholds.alert && categoryScores[category] >= rules.thresholds.category;
  return {
    candidate,
    relevant,
    score,
    category,
    categoryScores,
    reasons: summarizeReasons(matches),
    matchedRuleIds: matches.map((entry) => entry.ruleId),
  };
};

const quoteLobsterArg = (value) => JSON.stringify(String(value));

const normalizeLlmResult = (raw) => {
  const confidence = Number.isFinite(Number(raw?.confidence))
    ? Math.max(0, Math.min(100, Math.round(Number(raw.confidence))))
    : 0;
  const urgency = ["low", "medium", "high"].includes(raw?.urgency) ? raw.urgency : "low";
  const suggestedZone = ["gray", "amber", "red"].includes(raw?.suggested_zone)
    ? raw.suggested_zone
    : "gray";
  return {
    decisionRequired: raw?.decision_required === true,
    financialRelevance: raw?.financial_relevance === true,
    riskEscalation: raw?.risk_escalation === true,
    confidence,
    urgency,
    reason: compactText(raw?.reason ?? "No semantic reason returned."),
    deadlineDetected: raw?.deadline_detected === true,
    amountDetected: raw?.amount_detected === true,
    suggestedZone,
  };
};

const buildLlmSchema = () => ({
  type: "object",
  additionalProperties: false,
  properties: {
    decision_required: { type: "boolean" },
    financial_relevance: { type: "boolean" },
    risk_escalation: { type: "boolean" },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    urgency: { type: "string", enum: ["low", "medium", "high"] },
    reason: { type: "string" },
    deadline_detected: { type: "boolean" },
    amount_detected: { type: "boolean" },
    suggested_zone: { type: "string", enum: ["red", "amber", "gray"] },
  },
  required: [
    "decision_required",
    "financial_relevance",
    "risk_escalation",
    "confidence",
    "urgency",
    "reason",
    "deadline_detected",
    "amount_detected",
    "suggested_zone",
  ],
});

const buildLlmPrompt = () => [
  "You are a conservative mail triage reviewer.",
  "Use only the provided candidate payload.",
  "Do not speculate about missing context.",
  "Classify whether the mail needs a decision, has financial relevance, or indicates risk/escalation.",
  "Return ONLY a JSON object with exactly these snake_case fields:",
  "decision_required, financial_relevance, risk_escalation, confidence, urgency, reason, deadline_detected, amount_detected, suggested_zone.",
  "confidence must be a number from 0 to 100.",
  "urgency must be low, medium, or high.",
  "suggested_zone must be red, amber, or gray.",
  "Lower confidence when evidence is weak or ambiguous.",
].join(" ");

const determineZone = (input) => {
  const { scored, policyResult, llmResult, rules } = input;
  const adjustedScore = scored.score + policyResult.scoreModifier;
  const adjustedCategoryScore =
    (scored.categoryScores[scored.category] ?? 0) + policyResult.scoreModifier;
  const candidate = adjustedScore >= rules.thresholds.candidate;
  const relevant =
    adjustedScore >= rules.thresholds.alert && adjustedCategoryScore >= rules.thresholds.category;
  if (!candidate && policyResult.zoneFloor === null) {
    return {
      zone: "gray",
      adjustedScore,
      reasons: ["heuristics did not keep the mail above candidate threshold"],
    };
  }
  if (policyResult.muted) {
    return {
      zone: "gray",
      adjustedScore,
      reasons: [...policyResult.reasons, "policy muted this mail"],
    };
  }

  let zone = "gray";
  const reasons = [...policyResult.reasons];
  if (llmResult === null) {
    zone = relevant ? "amber" : candidate ? "amber" : "gray";
    reasons.push("semantic reviewer unavailable; keeping candidate out of red zone");
  } else {
    if (
      policyResult.minConfidence !== null &&
      llmResult.confidence < policyResult.minConfidence
    ) {
      zone = "gray";
      reasons.push(
        `policy requires at least ${String(policyResult.minConfidence)}% confidence for this category`,
      );
    } else if (
      llmResult.suggestedZone === "red" &&
      llmResult.confidence >= rules.zoneThresholds.redMinConfidence &&
      adjustedScore >= rules.zoneThresholds.redMinHeuristicScore &&
      (llmResult.decisionRequired || llmResult.financialRelevance || llmResult.riskEscalation || relevant)
    ) {
      zone = "red";
      reasons.push(llmResult.reason);
    } else if (
      llmResult.confidence >= rules.zoneThresholds.redMinConfidence &&
      adjustedScore >= rules.zoneThresholds.redMinHeuristicScore &&
      llmResult.urgency !== "low" &&
      (llmResult.decisionRequired || llmResult.riskEscalation || relevant)
    ) {
      zone = "red";
      reasons.push(llmResult.reason);
    } else if (
      llmResult.confidence >= rules.zoneThresholds.amberMinConfidence &&
      adjustedScore >= rules.zoneThresholds.amberMinHeuristicScore &&
      llmResult.suggestedZone !== "gray"
    ) {
      zone = llmResult.suggestedZone === "red" ? "amber" : llmResult.suggestedZone;
      reasons.push(llmResult.reason);
    } else if (relevant) {
      zone = "amber";
      reasons.push(llmResult.reason);
    } else {
      zone = "gray";
      reasons.push(llmResult.reason);
    }
  }

  zone = applyZoneFloor(zone, policyResult.zoneFloor);
  zone = applyZoneCeiling(zone, policyResult.zoneCeiling);
  return {
    zone,
    adjustedScore,
    reasons,
  };
};

const mapAlertToSummary = (alert, kind = "new-alert") => ({
  alertId: alert.alertId,
  kind,
  zone: alert.zone,
  category: alert.category,
  subject: alert.subject,
  from: alert.from,
  why: alert.why,
  sentAt: kind === "reminder" ? (alert.lastReminderAt ?? alert.sentAt) : alert.sentAt,
  ...(typeof alert.confidence === "number" ? { confidence: alert.confidence } : {}),
  ...(alert.messageId === undefined ? {} : { messageId: alert.messageId }),
  ...(alert.feedbackState === "pending" ? {} : { feedbackState: alert.feedbackState }),
});

const buildRedAlertMessage = (alert, kind) => {
  const title = kind === "reminder" ? "Mail Sentinel Reminder" : "Mail Sentinel Alert";
  const lines = [
    `${title} [${alert.alertId}]`,
    `Zone: ${String(alert.zone ?? "red").toUpperCase()}`,
    `Kategorie: ${CATEGORY_LABELS[alert.category] ?? alert.category}`,
    `Betreff: ${alert.subject}`,
    `Absender: ${alert.from}`,
    `Warum wichtig: ${alert.why}`,
    `Confidence: ${formatConfidenceLabel(alert.confidence)}`,
    "Feedback: 'War wichtig', 'Nicht wichtig', 'Spater erinnern', 'Immer so behandeln' oder 'Weniger davon'.",
  ];
  if (alert.messageId !== undefined) {
    lines.push(`Mail-ID: ${alert.messageId}`);
  }
  return lines.join("\n");
};

const buildDigestMessage = (alerts, interval, sentAt) => {
  const lines = [
    `Mail Sentinel Digest [${randomUUID()}]`,
    `Zeitraum: letzte ${interval}`,
    `Amber-Signale: ${String(alerts.length)}`,
    "",
  ];
  for (const [index, alert] of alerts.slice(0, 10).entries()) {
    lines.push(
      `${String(index + 1)}. ${alert.subject}`,
      `   Absender: ${alert.from}`,
      `   Kategorie: ${CATEGORY_LABELS[alert.category] ?? alert.category}`,
      `   Confidence: ${formatConfidenceLabel(alert.confidence)}`,
      `   Warum: ${alert.why}`,
    );
  }
  if (alerts.length > 10) {
    lines.push(`... und ${String(alerts.length - 10)} weitere.`);
  }
  lines.push("", `Erstellt: ${sentAt}`);
  return lines.join("\n");
};

const formatScanResult = (result) => {
  if (!result.configured) {
    return result.note ?? "IMAP is not configured yet.";
  }
  const lines = [
    `Mail Sentinel scan: ${String(result.newMessages)} new message(s), ${String(result.redAlertsSent)} red alert(s), ${String(result.amberQueued)} amber candidate(s), ${String(result.digestsSent)} digest(s), ${String(result.remindersSent)} reminder(s).`,
  ];
  if (result.alerts.length > 0) {
    lines.push(...result.alerts.map((alert) => formatAlertLine(alert)));
  }
  return lines.join("\n");
};

const formatFeedbackResult = (result) => {
  if (result.policyId !== undefined) {
    return `${result.note} Alert ${result.alertId}. Policy ${result.policyId} created.`;
  }
  return result.nextReminderAt === undefined
    ? `${result.note} Alert ${result.alertId}.`
    : `${result.note} Alert ${result.alertId} will be revisited at ${result.nextReminderAt}.`;
};

const formatListAlertsResult = (result) => {
  if (result.alerts.length === 0) {
    return result.view === "today"
      ? "No important Mail Sentinel alerts today."
      : "No Mail Sentinel alerts have been recorded yet.";
  }
  return [
    result.view === "today" ? "Important today:" : "Recent alerts:",
    ...result.alerts.map((alert) => formatAlertLine(alert)),
  ].join("\n");
};

const formatDigestResult = (result) => {
  if (result.alerts.length === 0) {
    return "No amber digest entries are currently queued.";
  }
  return [
    `Amber digest queue (${String(result.alerts.length)} item(s)):` ,
    ...result.alerts.map((alert) => formatAlertLine(alert)),
  ].join("\n");
};

const flattenPolicies = (policy) => {
  const normalized = normalizePolicy(policy);
  return [
    ...normalized.senderPolicies.map((entry) => ({ type: "sender", ...entry })),
    ...normalized.domainPolicies.map((entry) => ({ type: "domain", ...entry })),
    ...normalized.categoryPolicies.map((entry) => ({ type: "category", ...entry })),
    ...normalized.contentPolicies.map((entry) => ({ type: "content", ...entry })),
    ...normalized.timePolicies.map((entry) => ({ type: "time", ...entry })),
    ...normalized.mutePolicies.map((entry) => ({ type: "mute", ...entry })),
  ];
};

const formatPolicyResult = (result) => {
  if (result.policies.length === 0) {
    return "No Mail Sentinel policies are configured.";
  }
  return [
    "Mail Sentinel policies:",
    ...result.policies.map((entry) => `- [${entry.id}] ${entry.type} ${entry.match ?? entry.category ?? entry.schedule ?? entry.pattern}`),
  ].join("\n");
};

const collectKnownSenders = (state) => {
  const senders = new Map();
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

const scoreSenderCandidate = (candidate, query) => {
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

const findSenderCandidates = (state, query) => {
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

const pickResolvedSender = (matches) => {
  if (matches.length === 0) {
    return null;
  }
  if (matches.length === 1) {
    return matches[0];
  }
  const top = matches[0];
  const next = matches[1];
  const topDisplayTokens = tokenizeSenderText(extractDisplayName(top.from));
  const nextDisplayTokens = tokenizeSenderText(extractDisplayName(next.from));
  if (topDisplayTokens.length > 0 && nextDisplayTokens.length > 0 && top.score >= 190 && next.score >= 190) {
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

const summarizeSenderCandidate = (candidate) => ({
  from: candidate.from,
  fromAddress: candidate.fromAddress,
  ...(candidate.domain === undefined ? {} : { domain: candidate.domain }),
  messageCount: candidate.messageCount,
  lastSeenAt: candidate.lastSeenAt,
});

const upsertSenderPolicy = (policy, input) => {
  const normalized = normalizePolicy(policy);
  const index = normalized.senderPolicies.findIndex(
    (entry) => String(entry.match ?? "").toLowerCase() === input.match.toLowerCase(),
  );
  if (index < 0) {
    const entry = {
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
  const existing = normalized.senderPolicies[index];
  const next = {
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

const formatPolicyActionResult = (result) => {
  const lines = [result.note];
  if (Array.isArray(result.matches) && result.matches.length > 0) {
    lines.push(
      ...result.matches.map(
        (match) =>
          `- ${match.from} | ${match.fromAddress} | ${String(match.messageCount)} message(s) | last seen ${match.lastSeenAt}`,
      ),
    );
  }
  return lines.join("\n");
};

const extractDisplayName = (value) => {
  const raw = String(value ?? "").trim();
  if (raw.length === 0) {
    return "";
  }
  return compactText(raw.replace(/<[^>]+>/g, " "));
};

const tokenizeSenderText = (value) =>
  compactText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@._+-]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);

class MailSentinelRuntime {
  constructor(instanceId, configPath) {
    this.instanceId = instanceId;
    this.configPath = configPath ?? process.env.SOVEREIGN_NODE_CONFIG ?? DEFAULT_CONFIG_PATH;
  }

  async load() {
    const raw = await readFile(this.configPath, "utf8");
    this.runtimeConfig = parseRuntimeConfigDocument(raw);
    const tool = (this.runtimeConfig.sovereignTools?.instances ?? []).find(
      (entry) => entry.id === this.instanceId,
    );
    if (tool === undefined) {
      throw new Error(`Tool instance '${this.instanceId}' was not found in ${this.configPath}`);
    }
    const agentId = tool.config?.agentId ?? DEFAULT_AGENT_ID;
    const agent = (this.runtimeConfig.openclawProfile?.agents ?? []).find((entry) => entry.id === agentId);
    if (agent === undefined) {
      throw new Error(`Mail Sentinel agent '${agentId}' was not found in ${this.configPath}`);
    }
    this.agent = agent;
    this.tool = tool;
    this.workspaceDir = agent.workspace;
    this.statePath = resolveRelativeToBase(tool.config?.statePath ?? DEFAULT_STATE_PATH, this.workspaceDir);
    this.rulesPath = resolveRelativeToBase(tool.config?.rulesPath ?? DEFAULT_RULES_PATH, this.workspaceDir);
    this.policyPath = resolveRelativeToBase(tool.config?.policyPath ?? DEFAULT_POLICY_PATH, this.workspaceDir);
    this.lookbackWindow = tool.config?.lookbackWindow ?? DEFAULT_LOOKBACK_WINDOW;
    this.defaultReminderDelay = tool.config?.defaultReminderDelay ?? DEFAULT_REMINDER_DELAY;
    this.digestInterval = tool.config?.digestInterval ?? DEFAULT_DIGEST_INTERVAL;
    this.imapInstanceId = tool.config?.imapInstanceId ?? DEFAULT_IMAP_INSTANCE_ID;
    this.openclawUrl = tool.config?.openclawUrl ?? DEFAULT_OPENCLAW_URL;
    this.llmModel = tool.config?.llmModel ?? DEFAULT_LLM_MODEL;
    this.llmTimeoutMs = Number.parseInt(String(tool.config?.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS), 10);
    this.openclawToken = await this.readOpenClawGatewayToken();
    this.matrix = {
      adminBaseUrl: this.runtimeConfig.matrix?.adminBaseUrl,
      roomId: this.runtimeConfig.matrix?.alertRoom?.roomId,
      accessToken: await resolveSecretRefValue(agent.matrix?.accessTokenSecretRef),
    };
    this.imapConfigured = this.runtimeConfig.imap?.status === "configured";
  }

  async readOpenClawGatewayToken() {
    const runtimePath = this.runtimeConfig.openclaw?.runtimeConfigPath;
    if (typeof runtimePath !== "string" || runtimePath.length === 0) {
      return undefined;
    }
    try {
      const raw = await readFile(runtimePath, "utf8");
      const parsed = parseRuntimeConfigDocument(raw);
      const token = parsed?.gateway?.auth?.token;
      return typeof token === "string" && token.length > 0 ? token : undefined;
    } catch {
      return undefined;
    }
  }

  async readRules() {
    const rules = await readJsonFile(this.rulesPath, null);
    if (rules === null || typeof rules !== "object") {
      throw new Error(`Mail Sentinel rules at ${this.rulesPath} are invalid`);
    }
    return {
      version: Number(rules.version ?? 2),
      thresholds: {
        candidate: Number(rules.thresholds?.candidate ?? 3),
        alert: Number(rules.thresholds?.alert ?? 4),
        category: Number(rules.thresholds?.category ?? 4),
      },
      zoneThresholds: {
        redMinConfidence: Number(rules.zoneThresholds?.redMinConfidence ?? 75),
        amberMinConfidence: Number(rules.zoneThresholds?.amberMinConfidence ?? 40),
        redMinHeuristicScore: Number(rules.zoneThresholds?.redMinHeuristicScore ?? 4),
        amberMinHeuristicScore: Number(rules.zoneThresholds?.amberMinHeuristicScore ?? 3),
      },
      defaultReminderDelay:
        typeof rules.defaultReminderDelay === "string" ? rules.defaultReminderDelay : undefined,
      senderWeights: rules.senderWeights ?? {},
      domainWeights: rules.domainWeights ?? {},
      rules: Array.isArray(rules.rules) ? rules.rules : [],
    };
  }

  async readPolicy() {
    return normalizePolicy(await readJsonFile(this.policyPath, createDefaultPolicy()));
  }

  async writePolicy(policy) {
    await writeJsonFile(this.policyPath, normalizePolicy(policy));
  }

  async readState() {
    return migrateState(await readJsonFile(this.statePath, createDefaultState()));
  }

  async writeState(state) {
    await writeJsonFile(this.statePath, pruneState(migrateState(state)));
  }

  async runTool(command, args) {
    const executable = process.env.SOVEREIGN_TOOL_EXECUTABLE ?? DEFAULT_TOOL_EXECUTABLE;
    const result = await execFileAsync(executable, [...command, ...args], {
      maxBuffer: 10 * 1024 * 1024,
    }).catch((error) => {
      const stdout = typeof error.stdout === "string" ? error.stdout : "";
      const stderr = typeof error.stderr === "string" ? error.stderr : "";
      throw new Error(`${command.join(" ")} failed: ${stderr || stdout || error.message}`);
    });
    const payload = JSON.parse(stripSingleTrailingNewline(result.stdout));
    if (payload?.ok === true && payload.result !== undefined) {
      return payload.result;
    }
    return payload;
  }

  async searchMail(limit = DEFAULT_IMAP_SEARCH_LIMIT) {
    return await this.runTool(
      ["imap-search-mail"],
      [
        "--instance",
        this.imapInstanceId,
        "--query",
        "ALL",
        "--limit",
        String(limit),
        "--config-path",
        this.configPath,
        "--json",
      ],
    );
  }

  async readMail(selector) {
    return await this.runTool(
      ["imap-read-mail"],
      [
        "--instance",
        this.imapInstanceId,
        "--message-id",
        String(selector),
        "--config-path",
        this.configPath,
        "--json",
      ],
    );
  }

  async sendMatrixRoomMessage(text) {
    const endpoint = new URL(
      `/_matrix/client/v3/rooms/${encodeURIComponent(this.matrix.roomId)}/send/m.room.message/${encodeURIComponent(randomUUID())}`,
      ensureTrailingSlash(this.matrix.adminBaseUrl),
    ).toString();
    const response = await fetch(endpoint, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.matrix.accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        msgtype: "m.text",
        body: text,
      }),
    });
    if (!response.ok) {
      throw new Error(`Failed to send Matrix room message (${response.status})`);
    }
  }

  async classifyCandidate(candidate) {
    const args = {
      prompt: buildLlmPrompt(),
    };
    const candidateFile = resolve(this.workspaceDir, `.mail-sentinel-candidate-${randomUUID()}.json`);
    await writeFile(candidateFile, `${JSON.stringify(candidate)}\n`, "utf8");
    const pipeline = [
      "exec",
      `--json --shell ${quoteLobsterArg(`cat ${candidateFile}`)}`,
      "| clawd.invoke",
      "--tool llm-task",
      "--action json",
      `--args-json ${quoteLobsterArg(JSON.stringify(args))}`,
      "--each --item-key input",
      "| json",
    ].join(" ");
    try {
      const result = await execFileAsync("lobster", [pipeline], {
        cwd: this.workspaceDir,
        timeout: this.llmTimeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          CLAWD_URL: this.openclawUrl,
          ...(this.openclawToken === undefined ? {} : { CLAWD_TOKEN: this.openclawToken }),
        },
      }).catch((error) => {
        const stdout = typeof error.stdout === "string" ? error.stdout : "";
        const stderr = typeof error.stderr === "string" ? error.stderr : "";
        throw new Error(`lobster classification failed: ${stderr || stdout || error.message}`);
      });
      const parsed = parseJsonSafely(result.stdout);
      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      const rawText = typeof first?.output?.text === "string" ? parseJsonSafely(first.output.text) : null;
      const raw = first?.details?.json ?? rawText ?? first?.output?.data ?? first?.data ?? first;
      if (raw === null || typeof raw !== "object") {
        throw new Error("lobster classification returned no structured JSON payload");
      }
      return normalizeLlmResult(raw);
    } finally {
      await rm(candidateFile, { force: true });
    }
  }
}

const resolveToolRuntime = async (instanceId, configPath) => {
  const runtime = new MailSentinelRuntime(instanceId, configPath);
  await runtime.load();
  return runtime;
};

const parseMessage = (summary, readResult) => {
  const message = readResult.message;
  const messageId = normalizeMessageId(message.messageId ?? summary.messageId);
  const from = parseAddressFromList(message.from ?? summary.from);
  const fromAddress = normalizeEmailAddress(from);
  const text = compactText(message.text ?? "");
  return {
    key: buildMessageKey(messageId, message.uid),
    uid: message.uid,
    ...(messageId === undefined ? {} : { messageId }),
    subject: compactText(message.subject ?? summary.subject ?? "(no subject)"),
    normalizedThreadSubject: normalizeThreadSubject(message.subject ?? summary.subject ?? ""),
    from,
    ...(fromAddress === undefined ? {} : { fromAddress }),
    ...(extractDomain(fromAddress) === undefined ? {} : { domain: extractDomain(fromAddress) }),
    ...(typeof message.date === "string" ? { date: message.date } : {}),
    text,
    snippet: text.slice(0, 500),
    headers: normalizeHeaderMap(message.headers),
    amountSignal: parseHighestAmount(`${message.subject ?? ""}\n${text}`),
    deadlineDetected: detectDeadlineSignal(`${message.subject ?? ""}\n${text}`),
  };
};

const buildThreadContext = (state, message) =>
  Object.values(state.messages)
    .filter(
      (entry) =>
        entry.normalizedThreadSubject === message.normalizedThreadSubject &&
        entry.key !== message.key &&
        typeof entry.snippet === "string",
    )
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
    .slice(0, MAX_THREAD_CONTEXT_ENTRIES)
    .map((entry) => ({
      subject: entry.subject,
      from: entry.from,
      snippet: entry.snippet,
      ...(entry.date === undefined ? {} : { date: entry.date }),
    }));

const queueAmberAlert = (state, alertId) => {
  if (!state.digest.pendingAmber.includes(alertId)) {
    state.digest.pendingAmber.push(alertId);
  }
};

const resolvePendingAmberAlerts = (state) => {
  const alertsById = new Map(state.alerts.map((alert) => [alert.alertId, alert]));
  return state.digest.pendingAmber
    .map((alertId) => alertsById.get(alertId))
    .filter((alert) => alert !== undefined && alert.zone === "amber");
};

const flushDigestIfDue = async (runtime, state, scanAt) => {
  const pendingAlerts = resolvePendingAmberAlerts(state);
  if (pendingAlerts.length === 0) {
    return {
      sent: false,
      count: 0,
      alerts: [],
    };
  }
  const lastDigestAt = state.digest.lastDigestAt;
  if (lastDigestAt === undefined) {
    state.digest.lastDigestAt = scanAt;
    return {
      sent: false,
      count: 0,
      alerts: [],
    };
  }
  const dueAt =
    new Date(lastDigestAt).getTime() + parseDurationMs(runtime.digestInterval);
  if (Date.now() < dueAt) {
    return {
      sent: false,
      count: 0,
      alerts: [],
    };
  }
  await runtime.sendMatrixRoomMessage(buildDigestMessage(pendingAlerts, runtime.digestInterval, scanAt));
  state.digest.lastDigestAt = scanAt;
  state.digest.pendingAmber = [];
  for (const alert of pendingAlerts) {
    alert.digestSentAt = scanAt;
  }
  return {
    sent: true,
    count: pendingAlerts.length,
    alerts: pendingAlerts.map((alert) => mapAlertToSummary(alert, "digest")),
  };
};

const buildLlmCandidate = (message, scored, policyResult, state) => ({
  subject: message.subject,
  from: message.from,
  snippet: message.snippet,
  threadContext: buildThreadContext(state, message),
  heuristicSignals: {
    candidateScore: scored.score,
    category: scored.category,
    categoryScores: scored.categoryScores,
    matchedRules: scored.matchedRuleIds,
    reasons: scored.reasons,
  },
  policyHints: policyResult.reasons,
  extractedSignals: {
    deadlineDetected: message.deadlineDetected,
    amountDetected: message.amountSignal !== null,
    amount: message.amountSignal?.amount ?? null,
  },
});

const scan = async (options) => {
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  return await withLockedState(runtime.statePath, async () => {
    const state = await runtime.readState();
    const policy = await runtime.readPolicy();
    const scanAt = nowIso();
    state.lastPollAt = scanAt;

    if (!runtime.imapConfigured) {
      state.lastError = undefined;
      state.consecutiveFailures = 0;
      await runtime.writeState(state);
      return {
        instanceId: runtime.instanceId,
        configured: false,
        lookbackWindow: runtime.lookbackWindow,
        processedMessages: 0,
        newMessages: 0,
        redAlertsSent: 0,
        amberQueued: 0,
        digestsSent: 0,
        remindersSent: 0,
        lastPollAt: scanAt,
        note: "IMAP is not configured yet.",
        alerts: [],
      };
    }

    try {
      const rules = await runtime.readRules();
      const previousLastSeenUid = state.mailbox.lastSeenUid;
      const reminderAlerts = [];
      for (const alert of state.alerts) {
        if (
          alert.zone === "red" &&
          alert.reminderDueAt !== undefined &&
          alert.feedbackState === "pending" &&
          new Date(alert.reminderDueAt).getTime() <= Date.now()
        ) {
          await runtime.sendMatrixRoomMessage(buildRedAlertMessage(alert, "reminder"));
          alert.lastReminderAt = scanAt;
          alert.reminderDueAt = undefined;
          state.lastAlertAt = scanAt;
          reminderAlerts.push(mapAlertToSummary(alert, "reminder"));
        }
      }

      const searchResult = await runtime.searchMail(DEFAULT_IMAP_SEARCH_LIMIT);
      const searchMessages = Array.isArray(searchResult.messages)
        ? searchResult.messages.slice().sort((left, right) => left.uid - right.uid)
        : [];
      const warnings = [];
      let redAlertsSent = 0;
      let amberQueued = 0;
      const alerts = [...reminderAlerts];

      for (const summary of searchMessages) {
        if (typeof summary.size === "number" && summary.size > DEFAULT_IMAP_READ_MAX_BYTES) {
          warnings.push(`Skipped UID ${String(summary.uid)} because it exceeds the IMAP read limit.`);
          continue;
        }
        let readResult;
        try {
          readResult = await runtime.readMail(summary.uid);
        } catch (error) {
          warnings.push(
            `Skipped UID ${String(summary.uid)} because it could not be read: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        const parsed = parseMessage(summary, readResult);
        const knownMessage = state.messages[parsed.key];
        const shouldConsider =
          knownMessage === undefined &&
          (state.mailbox.lastSeenUid === undefined || parsed.uid > state.mailbox.lastSeenUid);
        state.messages[parsed.key] = {
          key: parsed.key,
          uid: parsed.uid,
          ...(parsed.messageId === undefined ? {} : { messageId: parsed.messageId }),
          subject: parsed.subject,
          normalizedThreadSubject: parsed.normalizedThreadSubject,
          from: parsed.from,
          ...(parsed.fromAddress === undefined ? {} : { fromAddress: parsed.fromAddress }),
          ...(parsed.domain === undefined ? {} : { domain: parsed.domain }),
          ...(parsed.date === undefined ? {} : { date: parsed.date }),
          snippet: parsed.snippet,
          firstSeenAt: knownMessage?.firstSeenAt ?? scanAt,
          lastSeenAt: scanAt,
          ...(knownMessage?.alertId === undefined ? {} : { alertId: knownMessage.alertId }),
        };
        if (!shouldConsider) {
          continue;
        }

        const scored = scoreMessage(parsed, state, rules);
        if (!scored.candidate) {
          state.zoneHistory.push({
            at: scanAt,
            messageKey: parsed.key,
            zone: "gray",
            reason: "candidate threshold not reached",
          });
          continue;
        }

        const policyResult = evaluatePolicy(parsed, scored, policy, new Date(scanAt));
        let llmResult = null;
        try {
          llmResult = await runtime.classifyCandidate(buildLlmCandidate(parsed, scored, policyResult, state));
        } catch (error) {
          warnings.push(
            `Semantic review failed for UID ${String(parsed.uid)}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        const zoneDecision = determineZone({
          scored,
          policyResult,
          llmResult,
          rules,
        });
        state.zoneHistory.push({
          at: scanAt,
          messageKey: parsed.key,
          zone: zoneDecision.zone,
          reason: zoneDecision.reasons[0] ?? "zone decided",
        });
        if (zoneDecision.zone === "gray") {
          continue;
        }

        const alert = {
          alertId: randomUUID(),
          messageKey: parsed.key,
          uid: parsed.uid,
          ...(parsed.messageId === undefined ? {} : { messageId: parsed.messageId }),
          zone: zoneDecision.zone,
          category: scored.category,
          subject: parsed.subject,
          from: parsed.from,
          ...(parsed.fromAddress === undefined ? {} : { fromAddress: parsed.fromAddress }),
          ...(parsed.domain === undefined ? {} : { domain: parsed.domain }),
          why:
            zoneDecision.reasons[0] === undefined
              ? "matched Mail Sentinel relevance rules"
              : zoneDecision.reasons.slice(0, 2).join("; "),
          sentAt: scanAt,
          score: scored.score,
          adjustedScore: zoneDecision.adjustedScore,
          categoryScores: scored.categoryScores,
          reasons: scored.reasons,
          matchedRuleIds: scored.matchedRuleIds,
          feedbackState: "pending",
          policyModifiers: policyResult.reasons,
          llmResult,
          confidence: llmResult?.confidence ?? 0,
        };
        state.alerts.push(alert);
        state.messages[parsed.key].alertId = alert.alertId;
        alerts.push(mapAlertToSummary(alert, "new-alert"));
        if (alert.zone === "red") {
          await runtime.sendMatrixRoomMessage(buildRedAlertMessage(alert, "new-alert"));
          redAlertsSent += 1;
          state.lastAlertAt = scanAt;
        } else {
          queueAmberAlert(state, alert.alertId);
          amberQueued += 1;
        }
      }

      const digestResult = await flushDigestIfDue(runtime, state, scanAt);
      if (digestResult.sent) {
        state.lastAlertAt = scanAt;
      }

      state.mailbox.lastSeenUid = Math.max(
        state.mailbox.lastSeenUid ?? 0,
        ...searchMessages.map((message) => message.uid),
      );
      state.lastImapSuccessAt = scanAt;
      state.lastError = undefined;
      state.consecutiveFailures = 0;
      await runtime.writeState(state);
      return {
        instanceId: runtime.instanceId,
        configured: true,
        lookbackWindow: runtime.lookbackWindow,
        processedMessages: searchMessages.length,
        newMessages: searchMessages.filter((message) => (previousLastSeenUid ?? 0) < message.uid).length,
        redAlertsSent,
        amberQueued,
        digestsSent: digestResult.sent ? 1 : 0,
        remindersSent: reminderAlerts.length,
        lastPollAt: scanAt,
        ...(warnings.length === 0 ? {} : { note: warnings[0] }),
        alerts,
      };
    } catch (error) {
      state.lastError = {
        code: "MAIL_SENTINEL_SCAN_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      };
      state.consecutiveFailures += 1;
      await runtime.writeState(state);
      throw error;
    }
  });
};

const derivePolicyFromFeedback = (alert, action) => {
  if (typeof alert.fromAddress !== "string" || alert.fromAddress.length === 0) {
    return null;
  }
  if (action === "always-like-this") {
    return {
      id: randomUUID(),
      type: "sender",
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
      type: "sender",
      entry: {
        id: randomUUID(),
        match: alert.fromAddress,
        maxZone: alert.zone === "red" ? "amber" : "gray",
        reason: `Derived from reduce feedback for ${alert.fromAddress}`,
      },
    };
  }
  return null;
};

const addPolicyEntry = (policy, type, entry) => {
  const normalized = normalizePolicy(policy);
  if (type === "sender") {
    normalized.senderPolicies.push(entry);
  } else if (type === "domain") {
    normalized.domainPolicies.push(entry);
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

const applyFeedback = async (options) => {
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  return await withLockedState(runtime.statePath, async () => {
    const state = await runtime.readState();
    const alert =
      typeof options.alertId === "string"
        ? state.alerts.find((entry) => entry.alertId === options.alertId)
        : options.latest === true
          ? sortAlertsNewestFirst(state.alerts)[0]
          : undefined;
    if (alert === undefined) {
      throw new Error("No matching Mail Sentinel alert was found");
    }

    const appliedAt = nowIso();
    let note = "Feedback recorded.";
    let nextReminderAt;
    let policyId;
    if (options.action === "important") {
      alert.feedbackState = "important";
      alert.feedbackAt = appliedAt;
      alert.reminderDueAt = undefined;
      applyLearningAdjustment(state.learning.senderWeights, alert.fromAddress, 2);
      applyLearningAdjustment(state.learning.domainWeights, alert.domain, 1);
      for (const ruleId of alert.matchedRuleIds) {
        applyLearningAdjustment(state.learning.ruleAdjustments, ruleId, 1);
      }
      note = "Alert marked as important.";
    } else if (options.action === "not-important") {
      alert.feedbackState = "not-important";
      alert.feedbackAt = appliedAt;
      alert.reminderDueAt = undefined;
      applyLearningAdjustment(state.learning.senderWeights, alert.fromAddress, -2);
      applyLearningAdjustment(state.learning.domainWeights, alert.domain, -1);
      for (const ruleId of alert.matchedRuleIds) {
        applyLearningAdjustment(state.learning.ruleAdjustments, ruleId, -1, RULE_ADJUSTMENT_FLOOR);
      }
      note = "Alert marked as not important.";
    } else if (options.action === "less-often") {
      alert.feedbackState = "less-often";
      alert.feedbackAt = appliedAt;
      alert.reminderDueAt = undefined;
      applyLearningAdjustment(state.learning.senderWeights, alert.fromAddress, -4);
      applyLearningAdjustment(state.learning.domainWeights, alert.domain, -2);
      for (const ruleId of alert.matchedRuleIds) {
        applyLearningAdjustment(state.learning.ruleAdjustments, ruleId, -1, RULE_ADJUSTMENT_FLOOR);
      }
      note = "Future alerts from this sender will be down-weighted.";
    } else if (options.action === "remind-later") {
      const delay = options.delay ?? runtime.defaultReminderDelay;
      nextReminderAt = new Date(Date.now() + parseDurationMs(delay)).toISOString();
      alert.reminderDueAt = nextReminderAt;
      note = `Reminder scheduled for ${nextReminderAt}.`;
    } else if (options.action === "always-like-this" || options.action === "reduce") {
      const policy = await runtime.readPolicy();
      const derived = derivePolicyFromFeedback(alert, options.action);
      if (derived === null) {
        throw new Error("This alert does not contain enough sender information to derive a policy");
      }
      policyId = derived.entry.id;
      await runtime.writePolicy(addPolicyEntry(policy, derived.type, derived.entry));
      note =
        options.action === "always-like-this"
          ? "Sender policy created to keep this handling pattern."
          : "Sender policy created to reduce similar future signals.";
      if (options.action === "reduce") {
        applyLearningAdjustment(state.learning.senderWeights, alert.fromAddress, -2);
        applyLearningAdjustment(state.learning.domainWeights, alert.domain, -1);
      }
      alert.feedbackState = options.action;
      alert.feedbackAt = appliedAt;
    } else {
      throw new Error(`Unsupported action '${String(options.action)}'`);
    }

    state.feedback.push({
      alertId: alert.alertId,
      action: options.action,
      at: appliedAt,
      ...(nextReminderAt === undefined ? {} : { delay: options.delay ?? runtime.defaultReminderDelay }),
      ...(policyId === undefined ? {} : { policyId }),
    });
    await runtime.writeState(state);
    return {
      instanceId: runtime.instanceId,
      alertId: alert.alertId,
      action: options.action,
      changed: true,
      note,
      ...(nextReminderAt === undefined ? {} : { nextReminderAt }),
      ...(policyId === undefined ? {} : { policyId }),
    };
  });
};

const listAlerts = async (options) => {
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  const state = await runtime.readState();
  const limit = clampLimit(options.limit, 20);
  const alerts = sortAlertsNewestFirst(state.alerts)
    .filter((alert) => alert.zone !== "gray")
    .filter((alert) => options.view === "recent" || isSameLocalDay(alert.sentAt, new Date()))
    .slice(0, limit)
    .map((alert) => mapAlertToSummary(alert));
  return {
    instanceId: runtime.instanceId,
    view: options.view,
    count: alerts.length,
    alerts,
  };
};

const digest = async (options) => {
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  const state = await runtime.readState();
  const limit = clampLimit(options.limit, 20);
  const queuedSource = resolvePendingAmberAlerts(state);
  const fallbackSource = sortAlertsNewestFirst(state.alerts).filter(
    (alert) => alert.zone === "amber" && isSameLocalDay(alert.sentAt, new Date()),
  );
  const queued = (queuedSource.length > 0 ? queuedSource : fallbackSource)
    .slice(0, limit)
    .map((alert) => mapAlertToSummary(alert, "digest"));
  return {
    instanceId: runtime.instanceId,
    count: queued.length,
    alerts: queued,
  };
};

const policyList = async (options) => {
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  const policy = await runtime.readPolicy();
  const policies = flattenPolicies(policy);
  return {
    instanceId: runtime.instanceId,
    count: policies.length,
    policies,
  };
};

const policyAdd = async (options) => {
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  const policy = await runtime.readPolicy();
  if (typeof options.type !== "string" || options.type.length === 0) {
    throw new Error("Expected --type <sender|domain|category|content|time|mute>");
  }
  if (["sender", "domain", "mute"].includes(options.type) && typeof options.match !== "string") {
    throw new Error(`Policy type '${options.type}' requires --match <pattern>`);
  }
  if (options.type === "category" && typeof options.category !== "string") {
    throw new Error("Policy type 'category' requires --category <name>");
  }
  if (options.type === "time" && typeof options.schedule !== "string") {
    throw new Error("Policy type 'time' requires --schedule <HH:MM-HH:MM>");
  }
  if (options.type === "content" && typeof options.pattern !== "string") {
    throw new Error("Policy type 'content' requires --pattern <regex>");
  }
  const entry = {
    id: randomUUID(),
    ...(typeof options.match === "string" ? { match: options.match } : {}),
    ...(typeof options.pattern === "string" ? { pattern: options.pattern } : {}),
    ...(typeof options.category === "string" ? { category: options.category } : {}),
    ...(typeof options.schedule === "string" ? { schedule: options.schedule } : {}),
    ...(typeof options.minZone === "string" ? { minZone: options.minZone } : {}),
    ...(typeof options.maxZone === "string" ? { maxZone: options.maxZone } : {}),
    ...(typeof options.reason === "string" ? { reason: options.reason } : {}),
    ...(options.boost === undefined ? {} : { boost: Number(options.boost) }),
    ...(options.amountThreshold === undefined
      ? {}
      : { amountThreshold: Number(options.amountThreshold) }),
    ...(options.type === "mute" ? { action: "mute" } : {}),
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

const policyImportantSender = async (options) => {
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  if (typeof options.query !== "string" || compactText(options.query).length === 0) {
    throw new Error("Expected --query <sender name or email>");
  }
  try {
    const result = await withLockedState(runtime.statePath, async () => {
      const state = await runtime.readState();
      const policy = await runtime.readPolicy();
      const matches = findSenderCandidates(state, options.query);
      if (matches.length === 0) {
        return {
          instanceId: runtime.instanceId,
          changed: false,
          status: "not-found",
          note: `I could not match '${options.query}' to a known sender yet. Please use the email address directly if needed.`,
          matches: [],
        };
      }
      const resolved = pickResolvedSender(matches);
      if (resolved === null) {
        return {
          instanceId: runtime.instanceId,
          changed: false,
          status: "ambiguous",
          note: `I found multiple sender matches for '${options.query}'. Please pick the exact address.`,
          matches: matches.slice(0, 5).map(summarizeSenderCandidate),
        };
      }
      const upserted = upsertSenderPolicy(policy, {
        match: resolved.fromAddress,
        minZone: "amber",
        clearMaxZone: true,
        reason: `Direct sender importance from '${options.query}'`,
      });
      if (upserted.changed) {
        await runtime.writePolicy(upserted.policy);
      }
      return {
        instanceId: runtime.instanceId,
        changed: upserted.changed,
        status: upserted.created ? "created" : upserted.changed ? "updated" : "unchanged",
        note: upserted.changed
          ? `Mails from ${resolved.fromAddress} will now be treated as at least amber.`
          : `Mails from ${resolved.fromAddress} were already treated as at least amber.`,
        matches: [summarizeSenderCandidate(resolved)],
        policy: {
          type: "sender",
          ...upserted.entry,
        },
      };
    });
    if (options.announce === true) {
      await runtime.sendMatrixRoomMessage(formatPolicyActionResult(result));
    }
    return result;
  } catch (error) {
    if (options.announce === true) {
      await runtime.sendMatrixRoomMessage(
        `Mail Sentinel konnte die Sender-Praferenz nicht anwenden: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw error;
  }
};

const policyRemove = async (options) => {
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  const policy = await runtime.readPolicy();
  if (typeof options.id !== "string" || options.id.length === 0) {
    throw new Error("Expected --id <policy-id>");
  }
  const normalized = normalizePolicy(policy);
  const strip = (entries) => entries.filter((entry) => entry.id !== options.id);
  const next = {
    ...normalized,
    senderPolicies: strip(normalized.senderPolicies),
    domainPolicies: strip(normalized.domainPolicies),
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
    id: options.id,
  };
};

const printOutput = (result, options, formatter) => {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatter(result)}\n`);
};

const main = async () => {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("Expected a command: scan, digest, feedback, list-alerts, or policy");
  }
  if (typeof options.instance !== "string" || options.instance.length === 0) {
    throw new Error("Expected --instance <id>");
  }

  if (command === "scan") {
    printOutput(await scan(options), options, formatScanResult);
    return;
  }
  if (command === "digest") {
    printOutput(await digest(options), options, formatDigestResult);
    return;
  }
  if (command === "feedback") {
    if (typeof options.action !== "string") {
      throw new Error(
        "Expected --action <important|not-important|less-often|remind-later|always-like-this|reduce>",
      );
    }
    if ((options.latest === true) === (typeof options.alertId === "string")) {
      throw new Error("Use either --latest or --alert-id");
    }
    printOutput(await applyFeedback(options), options, formatFeedbackResult);
    return;
  }
  if (command === "list-alerts") {
    if (options.view !== "today" && options.view !== "recent") {
      throw new Error("Expected --view today or --view recent");
    }
    printOutput(await listAlerts(options), options, formatListAlertsResult);
    return;
  }
  if (command === "policy") {
    if (options.subcommand === "list") {
      printOutput(await policyList(options), options, formatPolicyResult);
      return;
    }
    if (options.subcommand === "important-sender") {
      printOutput(await policyImportantSender(options), options, formatPolicyActionResult);
      return;
    }
    if (options.subcommand === "add") {
      printOutput(await policyAdd(options), options, (result) => `Policy ${result.policy.id} added.`);
      return;
    }
    if (options.subcommand === "remove") {
      printOutput(
        await policyRemove(options),
        options,
        (result) => (result.changed ? `Policy ${result.id} removed.` : `Policy ${result.id} not found.`),
      );
      return;
    }
    throw new Error("Expected a policy subcommand: list, important-sender, add, or remove");
  }

  throw new Error(`Unknown command: ${command}`);
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { message } }, null, 2)}\n`,
    );
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exitCode = 1;
});
