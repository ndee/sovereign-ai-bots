import { randomUUID } from "node:crypto";
import { buildDigestMessage, buildRedAlertMessage, mapAlertToSummary } from "../alerts/format.js";
import type { MailSentinelRuntime } from "../config/runtime.js";
import { resolveToolRuntime } from "../config/runtime.js";
import { DEFAULT_IMAP_READ_MAX_BYTES, DEFAULT_IMAP_SEARCH_LIMIT } from "../constants.js";
import { parseMessage } from "../imap/parse.js";
import { evaluatePolicy } from "../policy/engine.js";
import { scoreMessage } from "../scoring/heuristics.js";
import { buildLlmCandidate, determineZone } from "../scoring/llm.js";
import { withLockedState } from "../state/io.js";
import { queueAmberAlert, resolvePendingAmberAlerts } from "../state/thread.js";
import type {
  AlertSummary,
  CommandOptions,
  LlmResult,
  MailSentinelState,
  StoredAlert,
} from "../types.js";
import { nowIso, parseDurationMs } from "../util/time.js";

interface DigestFlushResult {
  sent: boolean;
  count: number;
  alerts: AlertSummary[];
}

export const flushDigestIfDue = async (
  runtime: MailSentinelRuntime,
  state: MailSentinelState,
  scanAt: string,
): Promise<DigestFlushResult> => {
  const pendingAlerts = resolvePendingAmberAlerts(state);
  if (pendingAlerts.length === 0) {
    return { sent: false, count: 0, alerts: [] };
  }
  const lastDigestAt = state.digest.lastDigestAt;
  if (lastDigestAt === undefined) {
    state.digest.lastDigestAt = scanAt;
    return { sent: false, count: 0, alerts: [] };
  }
  const dueAt = new Date(lastDigestAt).getTime() + parseDurationMs(runtime.digestInterval);
  if (Date.now() < dueAt) {
    return { sent: false, count: 0, alerts: [] };
  }
  await runtime.sendMatrixRoomMessage(
    buildDigestMessage(pendingAlerts, runtime.digestInterval, scanAt),
  );
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

export interface ScanCommandResult {
  instanceId: string;
  configured: boolean;
  lookbackWindow: string;
  processedMessages: number;
  newMessages: number;
  redAlertsSent: number;
  amberQueued: number;
  digestsSent: number;
  remindersSent: number;
  lastPollAt: string;
  note?: string;
  alerts: AlertSummary[];
}

export const scan = async (
  options: Pick<CommandOptions, "instance" | "configPath">,
): Promise<ScanCommandResult> => {
  if (options.instance === undefined) {
    throw new Error("Expected --instance <id>");
  }
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  return withLockedState(runtime.statePath, async () => {
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
      const reminderAlerts: AlertSummary[] = [];
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
      const warnings: string[] = [];
      let redAlertsSent = 0;
      let amberQueued = 0;
      const alerts: AlertSummary[] = [...reminderAlerts];

      for (const summary of searchMessages) {
        if (typeof summary.size === "number" && summary.size > DEFAULT_IMAP_READ_MAX_BYTES) {
          warnings.push(
            `Skipped UID ${String(summary.uid)} because it exceeds the IMAP read limit.`,
          );
          continue;
        }
        let readResult: Awaited<ReturnType<MailSentinelRuntime["readMail"]>>;
        try {
          readResult = await runtime.readMail(summary.uid);
        } catch (error) {
          warnings.push(
            `Skipped UID ${String(summary.uid)} because it could not be read: ${
              error instanceof Error ? error.message : String(error)
            }`,
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
        const policyResult = evaluatePolicy(parsed, scored, policy, new Date(scanAt));
        if (
          !scored.candidate &&
          policyResult.zoneFloor === null &&
          scored.score + policyResult.scoreModifier < rules.thresholds.candidate
        ) {
          state.zoneHistory.push({
            at: scanAt,
            messageKey: parsed.key,
            zone: "gray",
            reason: "candidate threshold not reached",
          });
          continue;
        }
        let llmResult: LlmResult | null = null;
        try {
          llmResult = await runtime.classifyCandidate(
            buildLlmCandidate(parsed, scored, policyResult, state),
          );
        } catch (error) {
          warnings.push(
            `Semantic review failed for UID ${String(parsed.uid)}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }

        const zoneDecision = determineZone({
          scored,
          policyResult,
          llmResult,
          rules,
        });
        // determineZone always populates at least one reason.
        state.zoneHistory.push({
          at: scanAt,
          messageKey: parsed.key,
          zone: zoneDecision.zone,
          reason: zoneDecision.reasons[0] as string,
        });
        if (zoneDecision.zone === "gray") {
          continue;
        }

        const alert: StoredAlert = {
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
          // determineZone always populates at least one reason.
          why: zoneDecision.reasons.slice(0, 2).join("; "),
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
        const storedMessage = state.messages[parsed.key];
        if (storedMessage !== undefined) {
          storedMessage.alertId = alert.alertId;
        }
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
        newMessages: searchMessages.filter((message) => (previousLastSeenUid ?? 0) < message.uid)
          .length,
        redAlertsSent,
        amberQueued,
        digestsSent: digestResult.sent ? 1 : 0,
        remindersSent: reminderAlerts.length,
        lastPollAt: scanAt,
        ...(warnings.length === 0 ? {} : { note: warnings[0] as string }),
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
