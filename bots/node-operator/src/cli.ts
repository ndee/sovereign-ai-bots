import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import { explainCode, formatExplainResult } from "./commands/explain.js";
import { formatHealth, formatStatus, getDiagnostics } from "./commands/status.js";
import { formatHelpResult, formatSupportResult } from "./commands/support.js";
import { formatVersionResult, version } from "./commands/version.js";

/**
 * Deterministic command router for the Node Operator bot binary.
 *
 * The Matrix agent's exec allowlist grants exactly this binary; every command
 * here is read-only, takes at most one strictly-validated argument, and
 * renders fixed partner-safe text. There is deliberately no passthrough to
 * `sovereign-node` subcommands — the trusted bridge in `node-cli.ts` owns the
 * only argv that ever reaches the node CLI.
 *
 * Free text an operator types can influence exactly one thing: the SAN code
 * given to `explain`, which is regex-validated before any use and never
 * echoed back when invalid.
 */

export const COMMANDS = ["status", "health", "explain", "support", "help", "version"] as const;

export type ParsedInvocation = {
  command: string | undefined;
  argument: string | undefined;
  json: boolean;
};

/**
 * Minimal, closed argument grammar: one command, at most one positional
 * argument (for `explain`), `--json`, and an ignored `--instance <id>` so the
 * rendered tool-template invocations stay uniform with other bots.
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

export const UNKNOWN_COMMAND_TEXT = ["I don't know that command.", "", formatHelpResult()].join(
  "\n",
);

export const runCli = async (argv: readonly string[]): Promise<void> => {
  const { command, argument, json } = parseInvocation(argv);

  // `version` answers before anything else on purpose: it reports the running
  // build identity and must work even when the node CLI is unreachable, which
  // is exactly when an operator needs to know what code is live.
  if (command === "version") {
    const result = version();
    if (json) {
      printJson(result);
      return;
    }
    print(formatVersionResult(result));
    return;
  }

  if (command === "status" || command === "health") {
    const result = await getDiagnostics();
    if (json) {
      printJson(result.kind === "ok" ? result.diagnostics : { unavailable: true });
      return;
    }
    print(command === "status" ? formatStatus(result) : formatHealth(result));
    return;
  }

  if (command === "explain") {
    const result = await explainCode(argument);
    print(formatExplainResult(result));
    if (result.kind === "invalid-input" || result.kind === "unknown-code") {
      // Non-zero so the agent loop knows the lookup did not succeed and can
      // re-prompt, mirroring mail-sentinel's ambiguity convention.
      process.exitCode = 1;
    }
    return;
  }

  if (command === "support") {
    print(formatSupportResult());
    return;
  }

  if (command === "help") {
    print(formatHelpResult());
    return;
  }

  print(UNKNOWN_COMMAND_TEXT);
  process.exitCode = 1;
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
    // Never emit an exception trace into a tool transcript that is relayed to
    // chat — a fixed sentence carries everything a partner can act on.
    process.stdout.write("Something went wrong running that command. Try again in a minute.\n");
    process.exitCode = 1;
  });
}
/* v8 ignore stop */
