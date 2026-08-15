import { randomUUID } from "node:crypto";
import { buildExcerpt } from "../alerts/evidence.js";
import {
  buildDigestMessage,
  buildRedAlertMessage,
  DIGEST_VISIBLE_LIMIT,
  mapAlertToSummary,
} from "../alerts/format.js";
import { mintShortRef } from "../alerts/short-ref.js";
import type { MailSentinelRuntime } from "../config/runtime.js";
import {
  checkToolAvailability,
  createToolUnavailableError,
  isToolUnavailableError,
  resolveToolRuntime,
  TOOL_UNAVAILABLE_ERROR_CODE,
} from "../config/runtime.js";
import { DEFAULT_IMAP_READ_MAX_BYTES, DEFAULT_IMAP_SEARCH_LIMIT } from "../constants.js";
import { deriveDegradationState } from "../health/degradation.js";
import { announceDegradationIfChanged } from "../health/notice.js";
import { parseMessage } from "../imap/parse.js";
import { evaluatePolicy } from "../policy/engine.js";
import { detectBulkSignals } from "../scoring/bulk.js";
import { scoreMessage } from "../scoring/heuristics.js";
import { buildLlmCandidate, buildUserFacingWhy, determineZone } from "../scoring/llm.js";
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
import { announceBuildIfChanged } from "./announce-build.js";

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
  await runtime.sendMatrixRoomMessage(buildDigestMessage(pendingAlerts, runtime.digestInterval));
  state.digest.lastDigestAt = scanAt;
  state.digest.pendingAmber = [];
  // Persist the order the user actually saw (the visible slice the digest
  // renders) so positional feedback resolves against this digest, not a
  // later re-render with shifted numbering.
  state.digest.lastDigestAlertIds = pendingAlerts
    .slice(0, DIGEST_VISIBLE_LIMIT)
    .map((alert) => alert.alertId);
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
  /**
   * The IMAP query the scan actually issued (`since:<date>`, derived from
   * `lookbackWindow`). Absent when IMAP is not configured. Lets an operator or
   * an e2e prove the search was bounded rather than a mailbox-wide `ALL`
   * (bots#142).
   */
  imapSearchQuery?: string;
  processedMessages: number;
  newMessages: number;
  redAlertsSent: number;
  amberQueued: number;
  digestsSent: number;
  remindersSent: number;
  lastPollAt: string;
  note?: string;
  /**
   * Total non-fatal warnings this scan produced (F-13). `note` still carries
   * only the first one, so a scan that skipped 40 messages no longer reports
   * the same as one that skipped a single message.
   */
  warningCount?: number;
  alerts: AlertSummary[];
}

export const scan = async (
  options: Pick<CommandOptions, "instance" | "configPath">,
): Promise<ScanCommandResult> => {
  if (options.instance === undefined) {
    throw new Error("Expected --instance <id>");
  }
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  // Announce a changed build before the scan body, and outside the state lock
  // (it locks its own record). It runs even when IMAP is unconfigured, because
  // an operator verifying an update needs the notice regardless — and it never
  // throws, so it cannot stop a scan.
  await announceBuildIfChanged(runtime);
  return withLockedState(runtime.statePath, async () => {
    const state = await runtime.readState();
    const policy = await runtime.readPolicy();
    const scanAt = nowIso();
    state.lastPollAt = scanAt;

    if (!runtime.imapConfigured) {
      state.lastError = undefined;
      state.consecutiveFailures = 0;
      // Nothing was scanned, so nothing is degraded. Clearing the counters here
      // stops a node that had IMAP removed from sitting on a stale "degraded"
      // record forever, and lets the recovery notice fire once.
      state.lastScanLlmFailures = 0;
      state.lastScanCandidates = 0;
      state.lastScanWarnings = 0;
      state.degradationState = "healthy";
      await runtime.writeState(state);
      await announceDegradationIfChanged(runtime, "healthy");
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

    // Preflight (#324): a Pro install can ship without the sovereign-tool
    // binary, and a scan without it can NEVER succeed — so it must not take
    // three timer ticks to degrade, and it must never be misnamed as a mailbox
    // failure. This runs after the unconfigured-IMAP short-circuit on purpose:
    // an unconfigured host keeps today's behaviour.
    const availability = await checkToolAvailability();
    if (!availability.ok) {
      state.lastError = {
        code: TOOL_UNAVAILABLE_ERROR_CODE,
        message: availability.reason,
        // The condition clears itself the moment the tool is installed or the
        // override is corrected; the next timer tick then scans normally.
        retryable: true,
      };
      // Deliberately NOT incrementing consecutiveFailures: those count mailbox
      // scans that threw, and letting a missing binary push them toward the
      // scans-failing threshold would mislabel an install defect as a mailbox
      // outage in every counter-based surface (doctor, workspace-state checks).
      const degradation = deriveDegradationState({
        consecutiveFailures: state.consecutiveFailures,
        lastScanLlmFailures: state.lastScanLlmFailures ?? 0,
        lastScanCandidates: state.lastScanCandidates ?? 0,
        toolUnavailable: true,
      });
      state.degradationState = degradation;
      await runtime.writeState(state);
      await announceDegradationIfChanged(runtime, degradation);
      // Rethrow like the outer catch does: the CLI turns this into a JSON
      // error payload and a non-zero exit code. There is no path where the
      // tool is missing and the scan reports ok.
      throw createToolUnavailableError(availability.reason);
    }

    try {
      const rules = await runtime.readRules();
      let previousLastSeenUid = state.mailbox.lastSeenUid;
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
      const observedUidValidity = searchResult.uidValidity;
      if (observedUidValidity !== undefined) {
        const previousUidValidity = state.mailbox.uidValidity;
        if (previousUidValidity !== undefined && previousUidValidity !== observedUidValidity) {
          warnings.push(
            `IMAP UIDVALIDITY changed from ${previousUidValidity} to ${observedUidValidity}; resetting lastSeenUid to re-scan the mailbox.`,
          );
          state.mailbox.lastSeenUid = undefined;
          previousLastSeenUid = undefined;
        }
        state.mailbox.uidValidity = observedUidValidity;
      }
      let redAlertsSent = 0;
      let amberQueued = 0;
      // F-01: a failing semantic reviewer never reaches the outer catch, so it
      // leaves `consecutiveFailures` at 0 and looks identical to a healthy scan.
      // These two counters are the only evidence that survives the loop.
      let llmFailures = 0;
      let llmCandidates = 0;
      const alerts: AlertSummary[] = [...reminderAlerts];
      // Watermark only ever advances past mail we actually reckoned with —
      // messages processed this scan or already seen in a prior one. Messages
      // skipped here without being read (too large, unreadable) must NOT push it
      // forward, or their UID would gate every lower-UID unprocessed message out
      // forever (silent, permanent mail loss). Seeded from the prior watermark so
      // it never moves backward.
      let highestConsideredUid = state.mailbox.lastSeenUid ?? 0;

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
          // A tool that disappeared mid-scan (after the preflight and the
          // search succeeded) must not be downgraded to a per-message warning:
          // the scan would then finish "ok" with a quiet-inbox result while
          // scanning is actually impossible. Escalate to the outer catch,
          // which maps it to the tool-unavailable degradation.
          if (isToolUnavailableError(error)) {
            throw error;
          }
          warnings.push(
            `Skipped UID ${String(summary.uid)} because it could not be read: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }
        const parsed = parseMessage(summary, readResult);
        // The message was read successfully, so it is one we have reckoned with —
        // either already known (processed in a prior scan) or a new one we are
        // about to consider below. Either way its UID may hold the watermark.
        highestConsideredUid = Math.max(highestConsideredUid, parsed.uid);
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
          toAddresses: parsed.toAddresses,
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
        llmCandidates += 1;
        try {
          llmResult = await runtime.classifyCandidate(
            buildLlmCandidate(parsed, scored, policyResult, state),
          );
        } catch (error) {
          llmFailures += 1;
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
          bulk: detectBulkSignals(parsed, rules.bulk),
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

        const alertId = randomUUID();
        // Copy a capped excerpt onto the alert now, from the local snippet only,
        // so the alert is self-contained and survives pruning (#102). Omitted
        // cleanly when the message had no usable snippet.
        const excerpt = buildExcerpt(parsed.snippet);
        const alert: StoredAlert = {
          alertId,
          // Mint a stable short handle, lengthening past the default only if a
          // shorter prefix would collide with an existing live alert's ref.
          shortRef: mintShortRef(
            alertId,
            state.alerts
              .map((existing) => existing.shortRef)
              .filter((ref): ref is string => typeof ref === "string"),
          ),
          messageKey: parsed.key,
          uid: parsed.uid,
          ...(parsed.messageId === undefined ? {} : { messageId: parsed.messageId }),
          zone: zoneDecision.zone,
          category: scored.category,
          subject: parsed.subject,
          from: parsed.from,
          ...(parsed.fromAddress === undefined ? {} : { fromAddress: parsed.fromAddress }),
          ...(parsed.domain === undefined ? {} : { domain: parsed.domain }),
          toAddresses: parsed.toAddresses,
          why: buildUserFacingWhy(zoneDecision, llmResult),
          ...(excerpt === undefined ? {} : { excerpt }),
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

      // Advance only to the highest UID we actually reckoned with this scan, not
      // the max of every searched UID — a skipped (too-large/unreadable) message
      // at a high UID must not bury lower-UID unprocessed mail behind the
      // watermark. `highestConsideredUid` is seeded from the prior value, so this
      // never moves the watermark backward.
      state.mailbox.lastSeenUid = highestConsideredUid;
      state.lastImapSuccessAt = scanAt;
      state.lastError = undefined;
      state.consecutiveFailures = 0;
      // Record what this scan actually observed *before* the state is written,
      // so `doctor` reads the same counters the notice below is derived from.
      state.lastScanLlmFailures = llmFailures;
      state.lastScanCandidates = llmCandidates;
      state.lastScanWarnings = warnings.length;
      const degradation = deriveDegradationState({
        consecutiveFailures: state.consecutiveFailures,
        lastScanLlmFailures: llmFailures,
        lastScanCandidates: llmCandidates,
      });
      state.degradationState = degradation;
      await runtime.writeState(state);
      // Outside the send-bearing loop but still inside the state lock, matching
      // how the digest and alert sends already work. It never throws.
      await announceDegradationIfChanged(runtime, degradation);
      return {
        instanceId: runtime.instanceId,
        configured: true,
        lookbackWindow: runtime.lookbackWindow,
        imapSearchQuery: searchResult.query,
        processedMessages: searchMessages.length,
        newMessages: searchMessages.filter((message) => (previousLastSeenUid ?? 0) < message.uid)
          .length,
        redAlertsSent,
        amberQueued,
        digestsSent: digestResult.sent ? 1 : 0,
        remindersSent: reminderAlerts.length,
        lastPollAt: scanAt,
        ...(warnings.length === 0
          ? {}
          : { note: warnings[0] as string, warningCount: warnings.length }),
        alerts,
      };
    } catch (error) {
      // A tool that vanished mid-scan (preflight passed, then searchMail or
      // readMail hit ENOENT) gets the same honest treatment as the preflight:
      // its own error code, retryable, no mailbox-failure counter increment.
      const toolUnavailable = isToolUnavailableError(error);
      state.lastError = {
        code: toolUnavailable ? TOOL_UNAVAILABLE_ERROR_CODE : "MAIL_SENTINEL_SCAN_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: toolUnavailable,
      };
      if (!toolUnavailable) {
        state.consecutiveFailures += 1;
      }
      // The notice has to run here too, or `scans-failing` — the state that
      // means no mail is being retrieved at all — could never be announced.
      const degradation = deriveDegradationState({
        consecutiveFailures: state.consecutiveFailures,
        lastScanLlmFailures: state.lastScanLlmFailures ?? 0,
        lastScanCandidates: state.lastScanCandidates ?? 0,
        toolUnavailable,
      });
      state.degradationState = degradation;
      await runtime.writeState(state);
      await announceDegradationIfChanged(runtime, degradation);
      throw error;
    }
  });
};
