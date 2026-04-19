import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  DEFAULT_STATE_LOCK_RETRY_ATTEMPTS,
  DEFAULT_STATE_LOCK_RETRY_DELAY_MS,
  DEFAULT_STATE_LOCK_STALE_MS,
  MAX_PENDING_AMBER,
  MAX_SEEN_SIGNALS,
  MAX_STORED_FEEDBACK,
  MAX_STORED_SIGNALS,
} from "./constants.js";
import type { ProjectSentinelState, SentinelLane, SentinelRoute, UserPolicy } from "./types.js";
import { stripSingleTrailingNewline } from "./util.js";

const normalizeRoute = (value: unknown): SentinelRoute | undefined => {
  if (value === "gray" || value === "amber" || value === "red") {
    return value;
  }
  return undefined;
};

export const readJsonFile = async <T>(filePath: string, fallback: T): Promise<T> => {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(stripSingleTrailingNewline(raw)) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
};

export const writeJsonFile = async (filePath: string, value: unknown): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
};

export const withLockedState = async <T>(
  statePath: string,
  action: () => Promise<T>,
): Promise<T> => {
  const lockPath = `${statePath}.lock`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < DEFAULT_STATE_LOCK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(dirname(lockPath), { recursive: true });
      handle = await open(lockPath, "wx");
      break;
    } catch (error) {
      /* v8 ignore next 3 -- unexpected fs errors are delegated directly */
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > DEFAULT_STATE_LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
        /* v8 ignore next 3 -- the lock file can disappear between open and stat */
      } catch {
        continue;
      }
      await new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, DEFAULT_STATE_LOCK_RETRY_DELAY_MS);
      });
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

export const createDefaultUserPolicy = (): UserPolicy => ({
  version: 1,
  sourceWeights: {},
  laneWeights: {
    matrix: 0,
    openclaw: 0,
    mail_stack: 0,
    ops_security: 0,
    local_first_ai: 0,
  },
  sourceOverrides: {},
  mutedFingerprints: [],
});

/* v8 ignore start -- defensive policy normalization for operator-edited JSON */
export const normalizeUserPolicy = (value: unknown): UserPolicy => {
  const source = (value ?? {}) as Partial<UserPolicy>;
  const defaults = createDefaultUserPolicy();
  const normalizedOverrides = Object.fromEntries(
    Object.entries(source.sourceOverrides ?? {}).flatMap(([key, entry]) => {
      const minRoute = normalizeRoute(entry?.minRoute);
      const maxRoute = normalizeRoute(entry?.maxRoute);
      if (minRoute === undefined && maxRoute === undefined) {
        return [];
      }
      return [
        [
          key,
          {
            ...(minRoute === undefined ? {} : { minRoute }),
            ...(maxRoute === undefined ? {} : { maxRoute }),
          },
        ],
      ];
    }),
  );
  const normalizedLaneWeights = Object.fromEntries(
    Object.entries(defaults.laneWeights).map(([key, fallback]) => [
      key,
      Number((source.laneWeights as Record<string, unknown> | undefined)?.[key] ?? fallback),
    ]),
  ) as Record<SentinelLane, number>;
  return {
    ...defaults,
    version: 1,
    sourceWeights: Object.fromEntries(
      Object.entries(source.sourceWeights ?? {}).map(([key, entry]) => [key, Number(entry)]),
    ),
    laneWeights: normalizedLaneWeights,
    sourceOverrides: normalizedOverrides,
    mutedFingerprints: Array.isArray(source.mutedFingerprints)
      ? source.mutedFingerprints.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
};
/* v8 ignore stop */

export const createDefaultState = (): ProjectSentinelState => ({
  version: 1,
  consecutiveFailures: 0,
  seenSignals: {},
  deliveredSignals: [],
  feedback: [],
  digestQueue: [],
  sourceStatus: {},
});

export const migrateState = (value: unknown): ProjectSentinelState => {
  const source = (value ?? {}) as Partial<ProjectSentinelState>;
  const defaults = createDefaultState();
  return {
    ...defaults,
    ...source,
    version: 1,
    seenSignals: source.seenSignals ?? {},
    deliveredSignals: Array.isArray(source.deliveredSignals) ? source.deliveredSignals : [],
    feedback: Array.isArray(source.feedback) ? source.feedback : [],
    digestQueue: Array.isArray(source.digestQueue)
      ? source.digestQueue.filter((entry): entry is string => typeof entry === "string")
      : [],
    sourceStatus: Object.fromEntries(
      Object.entries(source.sourceStatus ?? {}).map(([key, entry]) => [
        key,
        {
          lastScanAt: entry?.lastScanAt,
          lastRedAt: entry?.lastRedAt,
          consecutiveFailures: Number(entry?.consecutiveFailures ?? 0),
          /* v8 ignore next -- lastError is a passive carry-over field */
          ...(typeof entry?.lastError === "string" ? { lastError: entry.lastError } : {}),
        },
      ]),
    ),
  };
};

export const pruneState = (state: ProjectSentinelState): ProjectSentinelState => {
  const retainedSeenSignals = Object.values(state.seenSignals)
    .sort((left, right) => left.lastSeenAt.localeCompare(right.lastSeenAt))
    .slice(-MAX_SEEN_SIGNALS);
  state.seenSignals = Object.fromEntries(
    retainedSeenSignals.map((entry) => [entry.fingerprint, entry]),
  );
  state.deliveredSignals = state.deliveredSignals
    .slice()
    .sort((left, right) => left.sentAt.localeCompare(right.sentAt))
    .slice(-MAX_STORED_SIGNALS);
  state.feedback = state.feedback
    .slice()
    .sort((left, right) => left.at.localeCompare(right.at))
    .slice(-MAX_STORED_FEEDBACK);
  const validSignalIds = new Set(state.deliveredSignals.map((entry) => entry.signalId));
  state.digestQueue = state.digestQueue
    .filter((entry) => validSignalIds.has(entry))
    .slice(-MAX_PENDING_AMBER);
  return state;
};
