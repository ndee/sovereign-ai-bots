import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import {
  formatDigestResult,
  formatFeedbackResult,
  formatListAlertsResult,
  formatPolicyActionResult,
  formatPolicyResult,
  formatScanResult,
  printOutput,
} from "./alerts/output.js";
import { digest } from "./commands/digest.js";
import { applyFeedback } from "./commands/feedback.js";
import { listAlerts } from "./commands/list-alerts.js";
import { policyAdd, policyImportantSender, policyList, policyRemove } from "./commands/policy.js";
import { scan } from "./commands/scan.js";
import { parseArgs } from "./config/args.js";
import type { CommandOptions } from "./types.js";

export const runCli = async (argv: readonly string[]): Promise<void> => {
  const { command, options } = parseArgs(argv);
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("Expected a command: scan, digest, feedback, list-alerts, or policy");
  }
  if (typeof options.instance !== "string" || options.instance.length === 0) {
    throw new Error("Expected --instance <id>");
  }

  if (command === "scan") {
    printOutput(await scan(options), options, formatScanResult);
    return;
  }
  if (command === "digest") {
    printOutput(await digest(options), options, formatDigestResult);
    return;
  }
  if (command === "feedback") {
    if (typeof options.action !== "string") {
      throw new Error(
        "Expected --action <important|not-important|less-often|remind-later|always-like-this|reduce|digest-only>",
      );
    }
    if ((options.latest === true) === (typeof options.alertId === "string")) {
      throw new Error("Use either --latest or --alert-id");
    }
    printOutput(await applyFeedback(options), options, formatFeedbackResult);
    return;
  }
  if (command === "list-alerts") {
    if (options.view !== "today" && options.view !== "recent") {
      throw new Error("Expected --view today or --view recent");
    }
    printOutput(await listAlerts(options), options, formatListAlertsResult);
    return;
  }
  if (command === "policy") {
    if (options.subcommand === "list") {
      printOutput(await policyList(options), options, formatPolicyResult);
      return;
    }
    if (options.subcommand === "important-sender") {
      printOutput(await policyImportantSender(options), options, formatPolicyActionResult);
      return;
    }
    if (options.subcommand === "add") {
      printOutput(
        await policyAdd(options),
        options,
        (result) => `Policy ${result.policy.id} added.`,
      );
      return;
    }
    if (options.subcommand === "remove") {
      printOutput(await policyRemove(options), options, (result) =>
        result.changed ? `Policy ${result.id} removed.` : `Policy ${result.id} not found.`,
      );
      return;
    }
    throw new Error("Expected a policy subcommand: list, important-sender, add, or remove");
  }

  throw new Error(`Unknown command: ${command}`);
};

export const reportError = (error: unknown, argv: readonly string[]): void => {
  const message = error instanceof Error ? error.message : String(error);
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { message } }, null, 2)}\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exitCode = 1;
};

// Entry point guard: only run main() when invoked as a script, not when
// imported by tests. The tsup build bundles this file into a single script,
// so import.meta.url will match the invoked file on real runs.
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
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    reportError(error, process.argv);
  });
}

/* v8 ignore stop */

export type { CommandOptions };
