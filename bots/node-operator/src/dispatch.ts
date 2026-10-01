import { explainCode, formatExplainResult } from "./commands/explain.js";
import { formatHealth, formatStatus, getDiagnostics } from "./commands/status.js";
import { formatHelpResult, formatSupportResult } from "./commands/support.js";
import { formatVerifyResult, NONCE_PATTERN, verifyChallenge } from "./commands/verify.js";
import { formatVersionResult, version } from "./commands/version.js";
import {
  acquireDiagnosticsSlot,
  CONCURRENT_TEXT,
  type GuardDecision,
  RATE_LIMITED_TEXT,
} from "./guard.js";

/**
 * The deterministic operational command layer.
 *
 * This module — not any model — decides what executes. `parseOperatorMessage`
 * implements a closed, bounded grammar over the raw message text;
 * `executeOperatorCommand` maps each parsed command to a fixed internal
 * function (diagnostics run the node CLI via fixed-argv execFile — no shell,
 * no dynamic executable selection, no interpolation). Natural language that
 * is not an exact command receives fixed help text; nothing is inferred.
 *
 * Both entry points share this layer: the CLI (`node-operator.js <cmd>`) and
 * the Matrix daemon (`node-operator.js serve`).
 */

/** Bound on message text considered for parsing at all. */
export const MAX_MESSAGE_LENGTH = 1_000;

export type ParsedOperatorCommand =
  | { command: "status" | "health" | "support" | "help" | "version" }
  | { command: "explain"; code: string }
  | { command: "verify"; nonce: string }
  | { command: "unknown" };

/**
 * Parse a room/CLI message into a command — exact matches only.
 *
 * An optional leading mention of the bot ("@node-operator:domain:", the
 * localpart form, or a display-name prefix ending in ":") is stripped first,
 * because clients prepend it mechanically. Everything after that must match
 * the closed grammar exactly (commands case-insensitive, arguments bounded);
 * anything else is `unknown`.
 */
export const parseOperatorMessage = (
  raw: unknown,
  botUserId: string | undefined,
): ParsedOperatorCommand => {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_MESSAGE_LENGTH) {
    return { command: "unknown" };
  }
  let text = raw.trim();
  if (botUserId !== undefined && botUserId.length > 0) {
    const localpart = botUserId.startsWith("@") ? botUserId.slice(1).split(":")[0] : undefined;
    for (const prefix of [
      `${botUserId}:`,
      `${botUserId}`,
      ...(localpart === undefined ? [] : [`@${localpart}:`, `${localpart}:`]),
    ]) {
      if (text.startsWith(prefix)) {
        text = text.slice(prefix.length).trim();
        break;
      }
    }
  }

  const simple = /^(status|health|support|help|version)$/iu.exec(text);
  if (simple?.[1] !== undefined) {
    return {
      command: simple[1].toLowerCase() as "status" | "health" | "support" | "help" | "version",
    };
  }
  const explain = /^explain\s+(\S{1,64})$/iu.exec(text);
  if (explain?.[1] !== undefined) {
    return { command: "explain", code: explain[1] };
  }
  const verify = /^verify\s+([A-Fa-f0-9]{16,64})$/u.exec(text);
  if (verify?.[1] !== undefined && NONCE_PATTERN.test(verify[1].toLowerCase())) {
    return { command: "verify", nonce: verify[1].toLowerCase() };
  }
  return { command: "unknown" };
};

export type CommandOutcome = {
  text: string;
  /** Non-zero signals a failed/unknown command to CLI callers. */
  exitCode: 0 | 1;
  /** The Matrix reply must carry a reply relation to the triggering event. */
  replyRelatesToTrigger: boolean;
};

export const UNKNOWN_TEXT = ["I don't know that command.", "", formatHelpResult()].join("\n");

/**
 * Execute a parsed command via fixed internal functions only. Total: every
 * outcome is a fixed or schema-validated text, never an exception.
 */
export const executeOperatorCommand = async (
  parsed: ParsedOperatorCommand,
): Promise<CommandOutcome> => {
  switch (parsed.command) {
    case "help":
      return { text: formatHelpResult(), exitCode: 0, replyRelatesToTrigger: false };
    case "support":
      return { text: formatSupportResult(), exitCode: 0, replyRelatesToTrigger: false };
    case "version":
      return { text: formatVersionResult(version()), exitCode: 0, replyRelatesToTrigger: false };
    case "verify": {
      const result = verifyChallenge(parsed.nonce);
      return {
        text: formatVerifyResult(result),
        exitCode: result.kind === "confirmed" ? 0 : 1,
        // The core verifier requires the exact echo as a REPLY to the
        // challenge event.
        replyRelatesToTrigger: result.kind === "confirmed",
      };
    }
    case "status":
    case "health":
    case "explain": {
      const slot: GuardDecision = await acquireDiagnosticsSlot();
      if (!slot.ok) {
        return {
          text: slot.reason === "concurrent" ? CONCURRENT_TEXT : RATE_LIMITED_TEXT,
          exitCode: 1,
          replyRelatesToTrigger: false,
        };
      }
      try {
        if (parsed.command === "explain") {
          const result = await explainCode(parsed.code);
          return {
            text: formatExplainResult(result),
            exitCode: result.kind === "explained" || result.kind === "unavailable" ? 0 : 1,
            replyRelatesToTrigger: false,
          };
        }
        const result = await getDiagnostics();
        return {
          text: parsed.command === "status" ? formatStatus(result) : formatHealth(result),
          exitCode: 0,
          replyRelatesToTrigger: false,
        };
      } finally {
        await slot.release();
      }
    }
    default:
      return { text: UNKNOWN_TEXT, exitCode: 1, replyRelatesToTrigger: false };
  }
};
