#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_CONFIG_PATH = "/etc/sovereign-node/sovereign-node.json5";
const DEFAULT_STATE_PATH = "data/mail-sentinel-state.json";
const DEFAULT_RULES_PATH = "config/default-rules.json";
const DEFAULT_IMAP_INSTANCE_ID = "mail-sentinel-imap";
const DEFAULT_LOOKBACK_WINDOW = "15m";
const DEFAULT_REMINDER_DELAY = "4h";
const DEFAULT_IMAP_SEARCH_LIMIT = 50;
const DEFAULT_IMAP_READ_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_STATE_LOCK_RETRY_DELAY_MS = 50;
const DEFAULT_STATE_LOCK_RETRY_ATTEMPTS = 200;
const DEFAULT_TOOL_EXECUTABLE = "/usr/local/bin/sovereign-tool";
const DEFAULT_AGENT_ID = "mail-sentinel";

const CATEGORY_LABELS = {
  "decision-required": "Decision Required",
  "financial-relevance": "Financial Relevance",
  "risk-escalation": "Risk / Escalation",
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

const compactText = (value) => value.replace(/\s+/g, " ").trim();

const stripSingleTrailingNewline = (value) => value.replace(/\r?\n$/, "");

const ensureTrailingSlash = (value) => (value.endsWith("/") ? value : `${value}/`);

const nowIso = () => new Date().toISOString();

const normalizeThreadSubject = (value) =>
  compactText(value.toLowerCase().replace(/^(re|aw|fw|fwd):\s*/i, ""));

const createDefaultState = () => ({
  version: 1,
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
});

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

const mapAlertToSummary = (alert, kind = "new-alert") => ({
  alertId: alert.alertId,
  kind,
  category: alert.category,
  subject: alert.subject,
  from: alert.from,
  why: alert.why,
  sentAt: kind === "reminder" ? (alert.lastReminderAt ?? alert.sentAt) : alert.sentAt,
  ...(alert.messageId === undefined ? {} : { messageId: alert.messageId }),
  ...(alert.feedbackState === "pending" ? {} : { feedbackState: alert.feedbackState }),
});

const formatAlertLine = (alert) =>
  `- [${alert.alertId}] ${CATEGORY_LABELS[alert.category]} | ${alert.from} | ${alert.subject}`;

const formatScanResult = (result) => {
  if (!result.configured) {
    return result.note ?? "IMAP is not configured yet.";
  }
  const lines = [
    `Mail Sentinel scan: ${String(result.newMessages)} new message(s), ${String(result.alertsSent)} alert(s), ${String(result.remindersSent)} reminder(s).`,
  ];
  if (result.alerts.length > 0) {
    lines.push(...result.alerts.map((alert) => formatAlertLine(alert)));
  }
  return lines.join("\n");
};

const formatFeedbackResult = (result) =>
  result.nextReminderAt === undefined
    ? `${result.note} Alert ${result.alertId}.`
    : `${result.note} Alert ${result.alertId} will be revisited at ${result.nextReminderAt}.`;

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

const applyLearningAdjustment = (target, key, delta) => {
  if (typeof key !== "string" || key.length === 0) {
    return;
  }
  const next = (target[key] ?? 0) + delta;
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
  return state;
};

const parseArgs = (argv) => {
  const args = [...argv];
  const command = args.shift();
  const options = {
    json: false,
  };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--latest") {
      options.latest = true;
      continue;
    }
    if (token === "--instance" || token === "--config-path" || token === "--alert-id" || token === "--action" || token === "--delay" || token === "--view" || token === "--limit") {
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
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
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
    this.lookbackWindow = tool.config?.lookbackWindow ?? DEFAULT_LOOKBACK_WINDOW;
    this.defaultReminderDelay = tool.config?.defaultReminderDelay ?? DEFAULT_REMINDER_DELAY;
    this.imapInstanceId = tool.config?.imapInstanceId ?? DEFAULT_IMAP_INSTANCE_ID;
    this.matrix = {
      adminBaseUrl: this.runtimeConfig.matrix?.adminBaseUrl,
      roomId: this.runtimeConfig.matrix?.alertRoom?.roomId,
      accessToken: await resolveSecretRefValue(agent.matrix?.accessTokenSecretRef),
    };
    this.imapConfigured = this.runtimeConfig.imap?.status === "configured";
  }

  async readRules() {
    const rules = await readJsonFile(this.rulesPath, null);
    if (rules === null || typeof rules !== "object") {
      throw new Error(`Mail Sentinel rules at ${this.rulesPath} are invalid`);
    }
    return {
      version: 1,
      thresholds: {
        alert: Number(rules.thresholds?.alert ?? 4),
        category: Number(rules.thresholds?.category ?? 4),
      },
      defaultReminderDelay: typeof rules.defaultReminderDelay === "string" ? rules.defaultReminderDelay : undefined,
      senderWeights: rules.senderWeights ?? {},
      domainWeights: rules.domainWeights ?? {},
      rules: Array.isArray(rules.rules) ? rules.rules : [],
    };
  }

  async readState() {
    const state = await readJsonFile(this.statePath, createDefaultState());
    return {
      ...createDefaultState(),
      ...state,
      mailbox: {
        ...createDefaultState().mailbox,
        ...(state.mailbox ?? {}),
      },
      messages: state.messages ?? {},
      alerts: Array.isArray(state.alerts) ? state.alerts : [],
      feedback: Array.isArray(state.feedback) ? state.feedback : [],
      learning: {
        senderWeights: state.learning?.senderWeights ?? {},
        domainWeights: state.learning?.domainWeights ?? {},
        ruleAdjustments: state.learning?.ruleAdjustments ?? {},
      },
    };
  }

  async writeState(state) {
    await writeJsonFile(this.statePath, pruneState(state));
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
}

const buildRuleMatches = (message, state, rules) => {
  const matches = [];
  const senderAdjustment =
    (rules.senderWeights[message.fromAddress ?? ""] ?? 0) +
    (state.learning.senderWeights[message.fromAddress ?? ""] ?? 0);
  if (senderAdjustment !== 0 && message.fromAddress !== undefined) {
    matches.push({
      ruleId: `sender:${message.fromAddress}`,
      reason: senderAdjustment > 0 ? "sender has been rated as important before" : "sender has been down-weighted by feedback",
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
      reason: domainAdjustment > 0 ? "sender domain has been rated as important before" : "sender domain has been down-weighted by feedback",
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
  const relevant =
    score >= rules.thresholds.alert && categoryScores[category] >= rules.thresholds.category;
  return {
    relevant,
    score,
    category,
    categoryScores,
    reasons: summarizeReasons(matches),
    matchedRuleIds: matches.map((entry) => entry.ruleId),
  };
};

const buildAlertMessage = (alert, kind) => {
  const title = kind === "reminder" ? "Mail Sentinel Reminder" : "Mail Sentinel Alert";
  const lines = [
    `${title} [${alert.alertId}]`,
    `Kategorie: ${CATEGORY_LABELS[alert.category]}`,
    `Betreff: ${alert.subject}`,
    `Absender: ${alert.from}`,
    `Warum wichtig: ${alert.why}`,
    "Feedback: antworte mit 'War wichtig', 'Nicht wichtig', 'Nicht mehr so oft melden' oder 'Spater erinnern'.",
  ];
  if (alert.messageId !== undefined) {
    lines.push(`Mail-ID: ${alert.messageId}`);
  }
  return lines.join("\n");
};

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
  return {
    key: buildMessageKey(messageId, message.uid),
    uid: message.uid,
    ...(messageId === undefined ? {} : { messageId }),
    subject: compactText(message.subject ?? summary.subject ?? "(no subject)"),
    from,
    ...(fromAddress === undefined ? {} : { fromAddress }),
    ...(extractDomain(fromAddress) === undefined ? {} : { domain: extractDomain(fromAddress) }),
    ...(typeof message.date === "string" ? { date: message.date } : {}),
    text: compactText(message.text ?? ""),
  };
};

const scan = async (options) => {
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  return await withLockedState(runtime.statePath, async () => {
    const state = await runtime.readState();
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
        alertsSent: 0,
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
          alert.reminderDueAt !== undefined &&
          alert.feedbackState === "pending" &&
          new Date(alert.reminderDueAt).getTime() <= Date.now()
        ) {
          await runtime.sendMatrixRoomMessage(buildAlertMessage(alert, "reminder"));
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
      let alertsSent = 0;
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
          from: parsed.from,
          ...(parsed.fromAddress === undefined ? {} : { fromAddress: parsed.fromAddress }),
          ...(parsed.domain === undefined ? {} : { domain: parsed.domain }),
          ...(parsed.date === undefined ? {} : { date: parsed.date }),
          firstSeenAt: knownMessage?.firstSeenAt ?? scanAt,
          lastSeenAt: scanAt,
          ...(knownMessage?.alertId === undefined ? {} : { alertId: knownMessage.alertId }),
        };
        if (!shouldConsider) {
          continue;
        }
        const scored = scoreMessage(parsed, state, rules);
        if (!scored.relevant) {
          continue;
        }
        const alert = {
          alertId: randomUUID(),
          messageKey: parsed.key,
          uid: parsed.uid,
          ...(parsed.messageId === undefined ? {} : { messageId: parsed.messageId }),
          category: scored.category,
          subject: parsed.subject,
          from: parsed.from,
          ...(parsed.fromAddress === undefined ? {} : { fromAddress: parsed.fromAddress }),
          ...(parsed.domain === undefined ? {} : { domain: parsed.domain }),
          why: scored.reasons[0] === undefined ? "matched Mail Sentinel relevance rules" : scored.reasons.slice(0, 2).join("; "),
          sentAt: scanAt,
          score: scored.score,
          categoryScores: scored.categoryScores,
          reasons: scored.reasons,
          matchedRuleIds: scored.matchedRuleIds,
          feedbackState: "pending",
        };
        await runtime.sendMatrixRoomMessage(buildAlertMessage(alert, "new-alert"));
        alertsSent += 1;
        state.lastAlertAt = scanAt;
        state.alerts.push(alert);
        state.messages[parsed.key].alertId = alert.alertId;
        alerts.push(mapAlertToSummary(alert, "new-alert"));
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
        newMessages: searchMessages.filter(
          (message) => (previousLastSeenUid ?? 0) < message.uid,
        ).length,
        alertsSent,
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
        applyLearningAdjustment(state.learning.ruleAdjustments, ruleId, -1);
      }
      note = "Alert marked as not important.";
    } else if (options.action === "less-often") {
      alert.feedbackState = "less-often";
      alert.feedbackAt = appliedAt;
      alert.reminderDueAt = undefined;
      applyLearningAdjustment(state.learning.senderWeights, alert.fromAddress, -4);
      applyLearningAdjustment(state.learning.domainWeights, alert.domain, -2);
      for (const ruleId of alert.matchedRuleIds) {
        applyLearningAdjustment(state.learning.ruleAdjustments, ruleId, -1);
      }
      note = "Future alerts from this sender will be down-weighted.";
    } else if (options.action === "remind-later") {
      const delay = options.delay ?? runtime.defaultReminderDelay;
      nextReminderAt = new Date(Date.now() + parseDurationMs(delay)).toISOString();
      alert.reminderDueAt = nextReminderAt;
      note = `Reminder scheduled for ${nextReminderAt}.`;
    } else {
      throw new Error(`Unsupported action '${String(options.action)}'`);
    }

    state.feedback.push({
      alertId: alert.alertId,
      action: options.action,
      at: appliedAt,
      ...(nextReminderAt === undefined ? {} : { delay: options.delay ?? runtime.defaultReminderDelay }),
    });
    await runtime.writeState(state);
    return {
      instanceId: runtime.instanceId,
      alertId: alert.alertId,
      action: options.action,
      changed: true,
      note,
      ...(nextReminderAt === undefined ? {} : { nextReminderAt }),
    };
  });
};

const listAlerts = async (options) => {
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  const state = await runtime.readState();
  const limit = clampLimit(options.limit, 20);
  const alerts = sortAlertsNewestFirst(state.alerts)
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
    throw new Error("Expected a command: scan, feedback, or list-alerts");
  }
  if (typeof options.instance !== "string" || options.instance.length === 0) {
    throw new Error("Expected --instance <id>");
  }

  if (command === "scan") {
    const result = await scan(options);
    printOutput(result, options, formatScanResult);
    return;
  }
  if (command === "feedback") {
    if (typeof options.action !== "string") {
      throw new Error("Expected --action <important|not-important|less-often|remind-later>");
    }
    if ((options.latest === true) === (typeof options.alertId === "string")) {
      throw new Error("Use either --latest or --alert-id");
    }
    const result = await applyFeedback(options);
    printOutput(result, options, formatFeedbackResult);
    return;
  }
  if (command === "list-alerts") {
    if (options.view !== "today" && options.view !== "recent") {
      throw new Error("Expected --view today or --view recent");
    }
    const result = await listAlerts(options);
    printOutput(result, options, formatListAlertsResult);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
