import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import {
  formatDigestResult,
  formatFeedbackResult,
  formatScanResult,
  formatSourcesResult,
  formatStatusResult,
  printOutput,
} from "./alerts.js";
import { applyFeedback, digest, scan, sources, status } from "./commands.js";
import { parseArgs } from "./config/args.js";
import type { CommandOptions } from "./types.js";

export const runCli = async (argv: readonly string[]): Promise<void> => {
  const { command, options } = parseArgs(argv);
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("Expected a command: scan, digest, feedback, status, or sources");
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
  if (command === "status") {
    printOutput(await status(options), options, formatStatusResult);
    return;
  }
  if (command === "feedback") {
    if (typeof options.action !== "string") {
      throw new Error(
        "Expected --action <more-like-this|less-like-this|always-alert|digest-only|not-relevant>",
      );
    }
    if ((options.latest === true) === (typeof options.signalId === "string")) {
      throw new Error("Use either --latest or --signal-id");
    }
    printOutput(await applyFeedback(options), options, formatFeedbackResult);
    return;
  }
  if (command === "sources") {
    printOutput(await sources(options), options, formatSourcesResult);
    return;
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

export const isMainModule = (): boolean => {
  const entry = process.argv[1];
  if (typeof entry !== "string") {
    return false;
  }
  return import.meta.url === pathToFileURL(resolvePath(entry)).href;
};

/* v8 ignore start -- exercised only when invoked directly via the compiled bundle. */
if (isMainModule()) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    reportError(error, process.argv);
  });
}

/* v8 ignore stop */

export type { CommandOptions };
