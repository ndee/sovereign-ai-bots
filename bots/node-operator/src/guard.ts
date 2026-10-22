import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Execution guard for diagnostic commands: bounded rate limiting plus
 * single-flight concurrency.
 *
 * The limiter is enforced IN MEMORY first — the authoritative state lives in
 * this process, so the bot is never unbounded, not even when the workspace
 * is unwritable. The on-disk state is a best-effort continuity layer for
 * short-lived CLI invocations and across daemon restarts; when persistence
 * fails, a one-time diagnostic note goes to stderr (an internal health
 * signal, never into chat) and the in-memory bounds keep applying.
 *
 * Per-sender limits do not live here: the sender is authorized upstream by
 * the explicit operator allowlist, and this guard bounds TOTAL execution
 * frequency so even an authorized-but-looping client cannot turn
 * diagnostics into a DoS.
 */

/** Max diagnostic executions per window. */
export const RATE_LIMIT_MAX_RUNS = 6;
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** An in-flight marker older than this is a crashed run, not a live one. */
export const CONCURRENT_RUN_EXPIRY_MS = 90_000;

export type GuardDecision =
  | { ok: true; release: () => Promise<void> }
  | { ok: false; reason: "concurrent" | "rate-limited" };

type GuardState = {
  runningSince?: number;
  recentRuns: number[];
};

/** Authoritative per-path state for this process. */
const memoryStates = new Map<string, GuardState>();

/** One-time "persistence unavailable" stderr note per path. */
const persistenceWarned = new Set<string>();

/**
 * The guard file lives beside the running binary's workspace
 * (`<workspace>/bin/node-operator.js` → `<workspace>/data/…`), overridable
 * for tests. Never derived from any user input.
 */
export const resolveGuardPath = (
  env: Record<string, string | undefined> = process.env,
  argv1: string | undefined = process.argv[1],
): string => {
  const override = env.NODE_OPERATOR_GUARD_PATH?.trim();
  if (override !== undefined && override.startsWith("/")) {
    return override;
  }
  const binDir = typeof argv1 === "string" && argv1.length > 0 ? dirname(resolve(argv1)) : ".";
  return join(binDir, "..", "data", "node-operator-guard.json");
};

const readPersistedState = async (path: string): Promise<GuardState> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return { recentRuns: [] };
    }
    const record = parsed as { runningSince?: unknown; recentRuns?: unknown };
    return {
      ...(typeof record.runningSince === "number" && Number.isFinite(record.runningSince)
        ? { runningSince: record.runningSince }
        : {}),
      recentRuns: Array.isArray(record.recentRuns)
        ? record.recentRuns.filter(
            (entry): entry is number => typeof entry === "number" && Number.isFinite(entry),
          )
        : [],
    };
  } catch {
    // Missing or corrupt persisted state must never block a command.
    return { recentRuns: [] };
  }
};

const persistState = async (path: string, state: GuardState): Promise<void> => {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(state)}\n`, "utf8");
  } catch {
    // The IN-MEMORY state keeps enforcing the bounds; persistence is only
    // continuity. Emit the internal health signal exactly once per path.
    if (!persistenceWarned.has(path)) {
      persistenceWarned.add(path);
      process.stderr.write(
        "node-operator: throttle state is not persistent (workspace unwritable); in-memory limits remain active\n",
      );
    }
  }
};

const loadState = async (path: string): Promise<GuardState> => {
  const memory = memoryStates.get(path);
  if (memory !== undefined) {
    return memory;
  }
  const seeded = await readPersistedState(path);
  memoryStates.set(path, seeded);
  return seeded;
};

/**
 * Try to start a diagnostics run. Returns a `release` callback the caller
 * must invoke when done; failing to call it self-heals after
 * CONCURRENT_RUN_EXPIRY_MS.
 */
export const acquireDiagnosticsSlot = async (
  path: string = resolveGuardPath(),
  nowMs: number = Date.now(),
): Promise<GuardDecision> => {
  const state = await loadState(path);

  if (state.runningSince !== undefined && nowMs - state.runningSince < CONCURRENT_RUN_EXPIRY_MS) {
    return { ok: false, reason: "concurrent" };
  }

  const windowStart = nowMs - RATE_LIMIT_WINDOW_MS;
  const recentRuns = state.recentRuns.filter((at) => at > windowStart);
  if (recentRuns.length >= RATE_LIMIT_MAX_RUNS) {
    // Keep the pruned window in memory so the map cannot grow unbounded.
    memoryStates.set(path, { ...state, recentRuns });
    return { ok: false, reason: "rate-limited" };
  }

  recentRuns.push(nowMs);
  const nextState: GuardState = { runningSince: nowMs, recentRuns };
  memoryStates.set(path, nextState);
  await persistState(path, nextState);

  return {
    ok: true,
    release: async () => {
      const current = memoryStates.get(path) ?? { recentRuns };
      const released: GuardState = { recentRuns: current.recentRuns };
      memoryStates.set(path, released);
      await persistState(path, released);
    },
  };
};

/** Test helper: drop guard state entirely (memory and disk). */
export const clearGuardState = async (path: string): Promise<void> => {
  memoryStates.delete(path);
  persistenceWarned.delete(path);
  try {
    await unlink(path);
  } catch {
    // Already absent.
  }
};

export const CONCURRENT_TEXT =
  "I'm already running a check — one moment, the result is on its way.";

export const RATE_LIMITED_TEXT =
  "I've run several checks in the last minute. Give it a moment and ask again.";
