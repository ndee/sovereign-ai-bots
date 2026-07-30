import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Execution guard for diagnostic commands: bounded rate limiting plus
 * single-flight concurrency, persisted in a small state file inside the
 * agent workspace.
 *
 * The binary is a stateless CLI invoked per command, so throttling state
 * must live on disk. The guard is deliberately best-effort — a lost race
 * between two concurrent invocations costs one extra diagnostics run, while
 * a crashed run must never wedge the bot, so in-flight markers expire on
 * their own. Per-sender limits cannot live here (the binary never sees the
 * Matrix sender; sender authorization is enforced by the gateway allowlist
 * and room membership) — this guard bounds TOTAL execution frequency so a
 * chatty room or a looping agent cannot turn diagnostics into a DoS.
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

const readState = async (path: string): Promise<GuardState> => {
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
    // Missing or corrupt state must never block a command permanently.
    return { recentRuns: [] };
  }
};

const writeState = async (path: string, state: GuardState): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state)}\n`, "utf8");
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
  const state = await readState(path);

  if (state.runningSince !== undefined && nowMs - state.runningSince < CONCURRENT_RUN_EXPIRY_MS) {
    return { ok: false, reason: "concurrent" };
  }

  const windowStart = nowMs - RATE_LIMIT_WINDOW_MS;
  const recentRuns = state.recentRuns.filter((at) => at > windowStart);
  if (recentRuns.length >= RATE_LIMIT_MAX_RUNS) {
    return { ok: false, reason: "rate-limited" };
  }

  recentRuns.push(nowMs);
  try {
    await writeState(path, { runningSince: nowMs, recentRuns });
  } catch {
    // An unwritable workspace throttles nothing but must not break the
    // command — availability of diagnostics beats the throttle.
  }

  return {
    ok: true,
    release: async () => {
      try {
        const current = await readState(path);
        await writeState(path, { recentRuns: current.recentRuns });
      } catch {
        // Expiry self-heals a failed release.
      }
    },
  };
};

/** Test helper: drop guard state entirely. */
export const clearGuardState = async (path: string): Promise<void> => {
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
