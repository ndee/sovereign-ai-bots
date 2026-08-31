import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import { getDiagnostics } from "./commands/status.js";
import { version } from "./commands/version.js";
import { executeOperatorCommand, type ParsedOperatorCommand, UNKNOWN_TEXT } from "./dispatch.js";
import {
  acquireDiagnosticsSlot,
  CONCURRENT_TEXT,
  type GuardDecision,
  RATE_LIMITED_TEXT,
} from "./guard.js";
import { runServe } from "./serve.js";

/**
 * CLI entry point for the Node Operator binary.
 *
 * `serve` runs the deterministic Matrix daemon (the normal production mode,
 * as a systemd service). Every other command goes through the same
 * deterministic dispatch layer the daemon uses — fixed internal functions
 * only, no LLM anywhere, no shell, no dynamic executable selection.
 */

export const COMMANDS = [
  "status",
  "health",
  "explain",
  "support",
  "help",
  "version",
  "verify",
  "serve",
] as const;

export type ParsedInvocation = {
  command: string | undefined;
  argument: string | undefined;
  json: boolean;
};

/**
 * Minimal, closed argument grammar: one command, at most one positional
 * argument, `--json`, and an ignored `--instance <id>` so rendered
 * invocations stay uniform with other bots.
 */
export const parseInvocation = (argv: readonly string[]): ParsedInvocation => {
  const args = [...argv];
  const command = args.shift();
  const parsed: ParsedInvocation = { command, argument: undefined, json: false };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--json") {
      parsed.json = true;
      continue;
    }
    if (token === "--instance") {
      args.shift();
      continue;
    }
    if (typeof token === "string" && !token.startsWith("--") && parsed.argument === undefined) {
      parsed.argument = token;
    }
  }
  return parsed;
};

const print = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

const printJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

export const UNKNOWN_COMMAND_TEXT = UNKNOWN_TEXT;

/** Map a CLI invocation onto the shared deterministic dispatch model. */
const toOperatorCommand = (invocation: ParsedInvocation): ParsedOperatorCommand => {
  switch (invocation.command) {
    case "status":
    case "health":
    case "support":
    case "help":
    case "version":
      return { command: invocation.command };
    case "explain":
      return { command: "explain", code: invocation.argument ?? "" };
    case "verify":
      return { command: "verify", nonce: invocation.argument ?? "" };
    default:
      return { command: "unknown" };
  }
};

export const runCli = async (argv: readonly string[]): Promise<void> => {
  const invocation = parseInvocation(argv);

  // The production mode: the deterministic Matrix daemon. Runs until the
  // service manager stops it.
  if (invocation.command === "serve") {
    await runServe();
    return;
  }

  // `version --json` feeds the updater's runtime-identity verification and
  // must work with zero configuration.
  if (invocation.command === "version" && invocation.json) {
    printJson(version());
    return;
  }

  // `status/health --json` emit the validated diagnostics model for machine
  // consumers; guarded like their text forms.
  if ((invocation.command === "status" || invocation.command === "health") && invocation.json) {
    const slot: GuardDecision = await acquireDiagnosticsSlot();
    if (!slot.ok) {
      print(slot.reason === "concurrent" ? CONCURRENT_TEXT : RATE_LIMITED_TEXT);
      process.exitCode = 1;
      return;
    }
    try {
      const result = await getDiagnostics();
      printJson(result.kind === "ok" ? result.diagnostics : { unavailable: true });
      return;
    } finally {
      await slot.release();
    }
  }

  const outcome = await executeOperatorCommand(toOperatorCommand(invocation));
  print(outcome.text);
  if (outcome.exitCode !== 0) {
    process.exitCode = outcome.exitCode;
  }
};

// Entry point guard: only run when invoked as a script, not when imported by
// tests. The tsup build bundles this file into a single script, so
// import.meta.url matches the invoked file on real runs.
export const isMainModule = (): boolean => {
  const entry = process.argv[1];
  if (typeof entry !== "string") {
    return false;
  }
  return import.meta.url === pathToFileURL(resolvePath(entry)).href;
};

/* v8 ignore start -- entry-point guard only fires when the compiled script is
   invoked directly by node; unit tests always import the module so this branch
   is unreachable in the test runner. */
if (isMainModule()) {
  runCli(process.argv.slice(2)).catch(() => {
    // Never emit an exception trace into chat-adjacent output — a fixed
    // sentence carries everything a partner can act on.
    process.stdout.write("Something went wrong running that command. Try again in a minute.\n");
    process.exitCode = 1;
  });
}
/* v8 ignore stop */
