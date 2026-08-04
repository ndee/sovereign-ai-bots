import type { ToolExecutableSource } from "../config/runtime.js";
import { checkToolAvailability, resolveToolRuntime } from "../config/runtime.js";
import type { CommandOptions, StateErrorInfo } from "../types.js";

/**
 * Operational readiness of this Mail Sentinel instance (#324).
 *
 * `version` answers "which code is live"; `status` answers "can that code
 * actually scan mail right now". It exists because a Pro install can ship
 * without the sovereign-tool binary, and until this command the only way to
 * find that out was to wait for a timer tick and read the failure out of the
 * state file.
 *
 * It is a status REPORT, not a probe: the command exits 0 whether or not the
 * instance is ready, and carries the verdict in the `ready` field. It exposes
 * operational metadata only — the tool path, the degradation counters, the
 * last recorded error — never mailbox data or credentials.
 */
export interface StatusCommandResult {
  readonly ready: boolean;
  /** Present only when not ready: the operator-facing reason. */
  readonly reason?: string;
  readonly toolExecutable: string;
  /** `override` when SOVEREIGN_TOOL_EXECUTABLE is set, else `default`. */
  readonly toolExecutableSource: ToolExecutableSource;
  readonly degradationState: string;
  readonly consecutiveFailures: number;
  readonly lastPollAt?: string;
  readonly lastError?: StateErrorInfo;
}

export const status = async (
  options: Pick<CommandOptions, "instance" | "configPath">,
): Promise<StatusCommandResult> => {
  if (options.instance === undefined) {
    throw new Error("Expected --instance <id>");
  }
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  const availability = await checkToolAvailability();
  const state = await runtime.readState();
  return {
    ready: availability.ok,
    ...(availability.ok ? {} : { reason: availability.reason }),
    toolExecutable: availability.executable,
    toolExecutableSource: availability.source,
    // A state file that predates the degradation machinery simply has no
    // recorded state; report the baseline rather than an empty field.
    degradationState: state.degradationState ?? "healthy",
    consecutiveFailures: state.consecutiveFailures,
    ...(state.lastPollAt === undefined ? {} : { lastPollAt: state.lastPollAt }),
    ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
  };
};

/** Calm, operator-facing rendering, mirroring the `version` command's shape. */
export const formatStatusResult = (result: StatusCommandResult): string => {
  const lines = [
    result.ready ? "Mail Sentinel is ready." : "Mail Sentinel is not ready.",
    `Tool executable: ${result.toolExecutable} (${result.toolExecutableSource})`,
    `Degradation state: ${result.degradationState}`,
    `Consecutive failures: ${String(result.consecutiveFailures)}`,
  ];
  if (result.lastPollAt !== undefined) {
    lines.push(`Last poll: ${result.lastPollAt}`);
  }
  if (result.lastError !== undefined) {
    lines.push(`Last error: ${result.lastError.code}: ${result.lastError.message}`);
  }
  if (result.reason !== undefined) {
    lines.push(result.reason);
  }
  return lines.join("\n");
};
