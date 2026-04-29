import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import {
  checkinAdd,
  checkinLatest,
  checkinList,
  resistanceAdd,
  resistanceList,
  resistanceResolve,
  reviewWeekly,
  stepComplete,
  stepList,
  stepNext,
  wishAdd,
  wishArchive,
  wishComplete,
  wishList,
  wishPause,
  wishShow,
} from "./commands.js";
import { parseArgs } from "./config/args.js";
import {
  formatCheckinAdd,
  formatCheckinLatest,
  formatCheckinList,
  formatResistanceAdd,
  formatResistanceList,
  formatResistanceResolve,
  formatReviewWeekly,
  formatStepComplete,
  formatStepList,
  formatStepNext,
  formatWishAdd,
  formatWishList,
  formatWishShow,
  printOutput,
} from "./format.js";
import type { CommandOptions } from "./types.js";

const requireSubcommand = (options: CommandOptions, command: string): string => {
  if (typeof options.subcommand !== "string" || options.subcommand.length === 0) {
    throw new Error(`Expected a ${command} subcommand`);
  }
  return options.subcommand;
};

const runWish = async (options: CommandOptions): Promise<void> => {
  const sub = requireSubcommand(options, "wish");
  if (sub === "add") {
    printOutput(await wishAdd(options), options, formatWishAdd);
    return;
  }
  if (sub === "list") {
    printOutput(await wishList(options), options, formatWishList);
    return;
  }
  if (sub === "show") {
    printOutput(await wishShow(options), options, formatWishShow);
    return;
  }
  if (sub === "archive") {
    printOutput(await wishArchive(options), options, formatWishShow);
    return;
  }
  if (sub === "complete") {
    printOutput(await wishComplete(options), options, formatWishShow);
    return;
  }
  if (sub === "pause") {
    printOutput(await wishPause(options), options, formatWishShow);
    return;
  }
  throw new Error(`Unknown wish subcommand: ${sub}`);
};

const runCheckin = async (options: CommandOptions): Promise<void> => {
  const sub = requireSubcommand(options, "checkin");
  if (sub === "add") {
    printOutput(await checkinAdd(options), options, formatCheckinAdd);
    return;
  }
  if (sub === "list") {
    printOutput(await checkinList(options), options, formatCheckinList);
    return;
  }
  if (sub === "latest") {
    printOutput(await checkinLatest(options), options, formatCheckinLatest);
    return;
  }
  throw new Error(`Unknown checkin subcommand: ${sub}`);
};

const runResistance = async (options: CommandOptions): Promise<void> => {
  const sub = requireSubcommand(options, "resistance");
  if (sub === "add") {
    printOutput(await resistanceAdd(options), options, formatResistanceAdd);
    return;
  }
  if (sub === "list") {
    printOutput(await resistanceList(options), options, formatResistanceList);
    return;
  }
  if (sub === "resolve") {
    printOutput(await resistanceResolve(options), options, formatResistanceResolve);
    return;
  }
  throw new Error(`Unknown resistance subcommand: ${sub}`);
};

const runStep = async (options: CommandOptions): Promise<void> => {
  const sub = requireSubcommand(options, "step");
  if (sub === "next") {
    printOutput(await stepNext(options), options, formatStepNext);
    return;
  }
  if (sub === "list") {
    printOutput(await stepList(options), options, formatStepList);
    return;
  }
  if (sub === "complete") {
    printOutput(await stepComplete(options), options, formatStepComplete);
    return;
  }
  throw new Error(`Unknown step subcommand: ${sub}`);
};

const runReview = async (options: CommandOptions): Promise<void> => {
  const sub = requireSubcommand(options, "review");
  if (sub === "weekly") {
    printOutput(await reviewWeekly(options), options, formatReviewWeekly);
    return;
  }
  throw new Error(`Unknown review subcommand: ${sub}`);
};

export const runCli = async (argv: readonly string[]): Promise<void> => {
  const { command, options } = parseArgs(argv);
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("Expected a command: wish, checkin, resistance, step, or review");
  }
  if (command === "wish") return runWish(options);
  if (command === "checkin") return runCheckin(options);
  if (command === "resistance") return runResistance(options);
  if (command === "step") return runStep(options);
  if (command === "review") return runReview(options);
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
