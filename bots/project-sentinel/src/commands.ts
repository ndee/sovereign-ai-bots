import { randomUUID } from "node:crypto";

import { buildDigestMessage, buildRedAlertMessage } from "./alerts.js";
import { resolveToolRuntime } from "./config/runtime.js";
import { DEFAULT_DIGEST_INTERVAL } from "./constants.js";
import { applyFeedbackToPolicy, effectiveDigestInterval, evaluateSignal } from "./policy.js";
import { fetchSourceSignals } from "./sources.js";
import { migrateState, normalizeUserPolicy, pruneState, withLockedState } from "./state.js";
import type {
  CommandOptions,
  DeliveredSignal,
  FeedbackAction,
  ProjectSentinelState,
  SourceConfigDocument,
  SourcesSubcommand,
} from "./types.js";
import { nowIso, parseDurationMs } from "./util.js";

const sortSignalsNewestFirst = <T extends Pick<DeliveredSignal, "sentAt">>(
  signals: readonly T[],
): T[] => signals.slice().sort((left, right) => right.sentAt.localeCompare(left.sentAt));

const pendingDigestSignals = (state: ProjectSentinelState): DeliveredSignal[] => {
  const queued = new Set(state.digestQueue);
  return sortSignalsNewestFirst(
    state.deliveredSignals.filter(
      (signal) =>
        signal.route === "amber" &&
        queued.has(signal.signalId) &&
        signal.digestSentAt === undefined,
    ),
  );
};

/* v8 ignore start -- internal queue maintenance is exercised indirectly via scan/digest outcomes */
const removeQueuedSignalsForFingerprint = (
  state: ProjectSentinelState,
  fingerprint: string,
): void => {
  const queued = new Set(
    state.deliveredSignals
      .filter((signal) => signal.fingerprint === fingerprint && signal.route === "amber")
      .map((signal) => signal.signalId),
  );
  state.digestQueue = state.digestQueue.filter((signalId) => !queued.has(signalId));
};

const flushDigestIfDue = async (
  runtime: Awaited<ReturnType<typeof resolveToolRuntime>>,
  config: SourceConfigDocument,
  state: ProjectSentinelState,
  scanAt: string,
): Promise<{ sent: boolean; alerts: DeliveredSignal[] }> => {
  const signals = pendingDigestSignals(state);
  if (signals.length === 0) {
    return { sent: false, alerts: [] };
  }
  const interval = effectiveDigestInterval(
    config,
    runtime.digestInterval ?? DEFAULT_DIGEST_INTERVAL,
  );
  if (state.lastDigestAt === undefined) {
    state.lastDigestAt = scanAt;
    return { sent: false, alerts: [] };
  }
  const dueAt = new Date(state.lastDigestAt).getTime() + parseDurationMs(interval);
  if (Date.now() < dueAt) {
    return { sent: false, alerts: [] };
  }
  await runtime.sendMatrixRoomMessage(buildDigestMessage(signals, interval, scanAt));
  state.lastDigestAt = scanAt;
  state.lastAlertAt = scanAt;
  state.digestQueue = [];
  for (const signal of signals) {
    signal.digestSentAt = scanAt;
    const seen = state.seenSignals[signal.fingerprint];
    if (seen !== undefined) {
      seen.lastDigestAt = scanAt;
    }
  }
  return { sent: true, alerts: signals };
};
/* v8 ignore stop */

export interface ScanCommandResult {
  instanceId: string;
  configured: boolean;
  processedSources: number;
  processedSignals: number;
  newSignals: number;
  redAlertsSent: number;
  amberQueued: number;
  digestsSent: number;
  lastScanAt: string;
  note?: string;
  alerts: DeliveredSignal[];
}

export const scan = async (
  options: Pick<CommandOptions, "instance" | "configPath">,
): Promise<ScanCommandResult> => {
  if (options.instance === undefined) {
    throw new Error("Expected --instance <id>");
  }
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  return withLockedState(runtime.statePath, async () => {
    const state = migrateState(await runtime.readState());
    const policy = normalizeUserPolicy(await runtime.readPolicy());
    const config = await runtime.readSources();
    const scanAt = nowIso();
    const activeProfiles = config.profiles.filter((profile) => profile.enabled);
    const enabledSources = config.sources.filter((source) => source.enabled);
    state.lastScanAt = scanAt;
    if (activeProfiles.length === 0 || enabledSources.length === 0) {
      state.lastError = undefined;
      state.consecutiveFailures = 0;
      await runtime.writeState(pruneState(state));
      return {
        instanceId: runtime.instanceId,
        configured: false,
        processedSources: 0,
        processedSignals: 0,
        newSignals: 0,
        redAlertsSent: 0,
        amberQueued: 0,
        digestsSent: 0,
        lastScanAt: scanAt,
        note:
          activeProfiles.length === 0
            ? "No active Project Sentinel project profiles are enabled."
            : "No Project Sentinel sources are enabled.",
        alerts: [],
      };
    }

    try {
      let processedSignals = 0;
      let newSignals = 0;
      let redAlertsSent = 0;
      let amberQueued = 0;
      const alerts: DeliveredSignal[] = [];
      const warnings: string[] = [];

      for (const source of enabledSources) {
        try {
          const result = await fetchSourceSignals(source);
          state.sourceStatus[source.id] = {
            lastScanAt: scanAt,
            lastRedAt: state.sourceStatus[source.id]?.lastRedAt,
            consecutiveFailures: 0,
          };
          if (result.warning !== undefined) {
            warnings.push(result.warning);
          }
          processedSignals += result.signals.length;
          for (const signal of result.signals) {
            const existing = state.seenSignals[signal.fingerprint];
            state.seenSignals[signal.fingerprint] = {
              fingerprint: signal.fingerprint,
              contentFingerprint: signal.contentFingerprint,
              sourceId: signal.sourceId,
              title: signal.title,
              url: signal.url,
              publishedAt: signal.publishedAt,
              updatedAt: signal.updatedAt,
              lastSeenAt: scanAt,
              ...(existing?.lastRoute === undefined ? {} : { lastRoute: existing.lastRoute }),
              ...(existing?.lastAlertAt === undefined ? {} : { lastAlertAt: existing.lastAlertAt }),
              ...(existing?.lastDigestAt === undefined
                ? {}
                : { lastDigestAt: existing.lastDigestAt }),
            };
            /* v8 ignore next -- dedupe short-circuit is asserted at the command-result level */
            if (existing?.contentFingerprint === signal.contentFingerprint) {
              continue;
            }
            newSignals += 1;
            const decision = evaluateSignal(signal, config, policy, state);
            removeQueuedSignalsForFingerprint(state, signal.fingerprint);
            const seenSignal = state.seenSignals[signal.fingerprint];
            if (seenSignal !== undefined) {
              seenSignal.lastRoute = decision.route;
            }
            if (decision.route === "gray") {
              continue;
            }
            const delivered: DeliveredSignal = {
              signalId: randomUUID(),
              fingerprint: signal.fingerprint,
              kind: existing === undefined ? "new-signal" : "updated-signal",
              route: decision.route,
              lane: decision.lane,
              lanes: decision.lanes,
              sourceId: signal.sourceId,
              sourceName: signal.sourceName,
              sourceType: signal.sourceType,
              trustTier: signal.trustTier,
              title: signal.title,
              url: signal.url,
              summary: signal.summary,
              why: decision.why,
              confidence: decision.confidence,
              score: decision.score,
              projectId: decision.projectId,
              publishedAt: signal.publishedAt,
              updatedAt: signal.updatedAt,
              sentAt: scanAt,
            };
            state.deliveredSignals.push(delivered);
            alerts.push(delivered);
            if (delivered.route === "red") {
              await runtime.sendMatrixRoomMessage(buildRedAlertMessage(delivered));
              redAlertsSent += 1;
              state.lastAlertAt = scanAt;
              state.sourceStatus[source.id] = {
                ...state.sourceStatus[source.id],
                lastRedAt: scanAt,
                lastScanAt: scanAt,
                consecutiveFailures: 0,
              };
              if (seenSignal !== undefined) {
                seenSignal.lastAlertAt = scanAt;
              }
            } else if (!state.digestQueue.includes(delivered.signalId)) {
              state.digestQueue.push(delivered.signalId);
              amberQueued += 1;
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          state.sourceStatus[source.id] = {
            ...state.sourceStatus[source.id],
            lastScanAt: scanAt,
            consecutiveFailures: (state.sourceStatus[source.id]?.consecutiveFailures ?? 0) + 1,
            lastError: message,
          };
          warnings.push(`Source ${source.id} failed: ${message}`);
        }
      }

      const digestResult = await flushDigestIfDue(runtime, config, state, scanAt);
      state.lastError = undefined;
      state.consecutiveFailures = 0;
      await runtime.writeState(pruneState(state));
      return {
        instanceId: runtime.instanceId,
        configured: true,
        processedSources: enabledSources.length,
        processedSignals,
        newSignals,
        redAlertsSent,
        amberQueued,
        digestsSent: digestResult.sent ? 1 : 0,
        lastScanAt: scanAt,
        ...(warnings.length === 0 ? {} : { note: warnings[0] }),
        alerts,
      };
    } catch (error) {
      state.lastError = {
        code: "PROJECT_SENTINEL_SCAN_FAILED",
        /* v8 ignore next -- non-Error throws are normalized defensively */
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      };
      state.consecutiveFailures += 1;
      await runtime.writeState(pruneState(state));
      throw error;
    }
  });
};

export interface DigestCommandResult {
  alerts: DeliveredSignal[];
}

export const digest = async (
  options: Pick<CommandOptions, "instance" | "configPath">,
): Promise<DigestCommandResult> => {
  if (options.instance === undefined) {
    throw new Error("Expected --instance <id>");
  }
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  const state = migrateState(await runtime.readState());
  return {
    alerts: pendingDigestSignals(state),
  };
};

export interface StatusCommandResult {
  configured: boolean;
  activeProfiles: number;
  enabledSources: number;
  trackedSignals: number;
  pendingAmber: number;
  lastScanAt?: string;
  lastAlertAt?: string;
  lastError?: string;
}

export const status = async (
  options: Pick<CommandOptions, "instance" | "configPath">,
): Promise<StatusCommandResult> => {
  if (options.instance === undefined) {
    throw new Error("Expected --instance <id>");
  }
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  const state = migrateState(await runtime.readState());
  const config = await runtime.readSources();
  const activeProfiles = config.profiles.filter((profile) => profile.enabled).length;
  const enabledSources = config.sources.filter((source) => source.enabled).length;
  return {
    configured: activeProfiles > 0 && enabledSources > 0,
    activeProfiles,
    enabledSources,
    trackedSignals: Object.keys(state.seenSignals).length,
    pendingAmber: pendingDigestSignals(state).length,
    ...(state.lastScanAt === undefined ? {} : { lastScanAt: state.lastScanAt }),
    ...(state.lastAlertAt === undefined ? {} : { lastAlertAt: state.lastAlertAt }),
    ...(state.lastError?.message === undefined ? {} : { lastError: state.lastError.message }),
  };
};

export interface SourcesCommandResult {
  note?: string;
  sources: SourceConfigDocument["sources"];
}

const resolveSourcesSubcommand = (subcommand: string | undefined): SourcesSubcommand => {
  if (subcommand === undefined || subcommand === "list") {
    return "list";
  }
  if (subcommand === "enable" || subcommand === "disable") {
    return subcommand;
  }
  throw new Error("Expected a sources subcommand: list, enable, or disable");
};

export const sources = async (
  options: Pick<CommandOptions, "instance" | "configPath" | "subcommand" | "id">,
): Promise<SourcesCommandResult> => {
  if (options.instance === undefined) {
    throw new Error("Expected --instance <id>");
  }
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  const document = await runtime.readSources();
  const subcommand = resolveSourcesSubcommand(options.subcommand);
  if (subcommand === "list") {
    return {
      sources: document.sources.slice().sort((left, right) => left.id.localeCompare(right.id)),
    };
  }
  if (typeof options.id !== "string" || options.id.length === 0) {
    throw new Error("Expected --id <source-id>");
  }
  const target = document.sources.find((source) => source.id === options.id);
  if (target === undefined) {
    return {
      note: `Project Sentinel source ${options.id} was not found.`,
      sources: document.sources.slice().sort((left, right) => left.id.localeCompare(right.id)),
    };
  }
  target.enabled = subcommand === "enable";
  await runtime.writeSources(document);
  return {
    note: `Project Sentinel source ${target.id} ${target.enabled ? "enabled" : "disabled"}.`,
    sources: document.sources.slice().sort((left, right) => left.id.localeCompare(right.id)),
  };
};

export interface FeedbackCommandResult {
  instanceId: string;
  signalId: string;
  action: FeedbackAction;
  note: string;
}

export const applyFeedback = async (
  options: Pick<CommandOptions, "instance" | "configPath" | "signalId" | "latest" | "action">,
): Promise<FeedbackCommandResult> => {
  if (options.instance === undefined) {
    throw new Error("Expected --instance <id>");
  }
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  return withLockedState(runtime.statePath, async () => {
    const state = migrateState(await runtime.readState());
    const signal =
      typeof options.signalId === "string"
        ? state.deliveredSignals.find((entry) => entry.signalId === options.signalId)
        : options.latest === true
          ? sortSignalsNewestFirst(state.deliveredSignals)[0]
          : undefined;
    if (signal === undefined) {
      throw new Error("No matching Project Sentinel signal was found");
    }
    const action = options.action;
    if (
      action !== "more-like-this" &&
      action !== "less-like-this" &&
      action !== "always-alert" &&
      action !== "digest-only" &&
      action !== "not-relevant"
    ) {
      throw new Error(
        "Expected --action <more-like-this|less-like-this|always-alert|digest-only|not-relevant>",
      );
    }
    const policy = normalizeUserPolicy(await runtime.readPolicy());
    const appliedAt = nowIso();
    const result = applyFeedbackToPolicy(policy, signal, action);
    signal.feedbackState = action;
    signal.lastFeedbackAt = appliedAt;
    if (action === "not-relevant") {
      state.digestQueue = state.digestQueue.filter((entry) => entry !== signal.signalId);
    }
    state.feedback.push({
      signalId: signal.signalId,
      fingerprint: signal.fingerprint,
      sourceId: signal.sourceId,
      lane: signal.lane,
      action,
      at: appliedAt,
    });
    await runtime.writePolicy(result.policy);
    await runtime.writeState(pruneState(state));
    return {
      instanceId: runtime.instanceId,
      signalId: signal.signalId,
      action,
      note: result.note,
    };
  });
};
