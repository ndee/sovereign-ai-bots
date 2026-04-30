import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import { parseArgs } from "./args.js";
import {
  documentTypes,
  help,
  importDocument,
  listAccounts,
  listAssets,
  listDocuments,
  listLiabilities,
  listTransactions,
  monthlyDigest,
  nextStep,
  parseDocument,
  reparseDocument,
  showCashflow,
  showDocument,
  showExpenses,
  showIncome,
  showMissingData,
  showNetWorth,
  showParsingIssues,
  showRecurring,
  showTopCategories,
  summary,
  weeklyReview,
  whatChanged,
} from "./commands.js";
import { printOutput } from "./format.js";
import {
  formatAccounts,
  formatAssets,
  formatCashflow,
  formatDocuments,
  formatDocumentTypes,
  formatExpenses,
  formatHelp,
  formatImport,
  formatIncome,
  formatLiabilities,
  formatMissingData,
  formatMonthlyDigest,
  formatNetWorth,
  formatNextStep,
  formatParse,
  formatParsingIssues,
  formatRecurring,
  formatShowDocument,
  formatSummary,
  formatTopCategories,
  formatTransactions,
  formatWeeklyReview,
  formatWhatChanged,
} from "./formatters.js";
import type { CommandOptions } from "./types.js";

const requireInstance = (options: CommandOptions): void => {
  if (typeof options.instance !== "string" || options.instance.length === 0) {
    throw new Error("Expected --instance <id>");
  }
};

export const runCli = async (argv: readonly string[]): Promise<void> => {
  const { command, options } = parseArgs(argv);
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("Expected a command. Run `help` for the list.");
  }
  if (command === "help") {
    printOutput(help(), options, formatHelp);
    return;
  }
  if (command === "document-types") {
    printOutput(documentTypes(), options, formatDocumentTypes);
    return;
  }
  requireInstance(options);
  if (command === "import") {
    printOutput(await importDocument(options), options, formatImport);
    return;
  }
  if (command === "documents") {
    printOutput(await listDocuments(options), options, formatDocuments);
    return;
  }
  if (command === "show-document") {
    printOutput(await showDocument(options), options, formatShowDocument);
    return;
  }
  if (command === "parse") {
    printOutput(await parseDocument(options), options, formatParse);
    return;
  }
  if (command === "reparse") {
    printOutput(await reparseDocument(options), options, formatParse);
    return;
  }
  if (command === "accounts") {
    printOutput(await listAccounts(options), options, formatAccounts);
    return;
  }
  if (command === "transactions") {
    printOutput(await listTransactions(options), options, formatTransactions);
    return;
  }
  if (command === "income") {
    printOutput(await showIncome(options), options, formatIncome);
    return;
  }
  if (command === "expenses") {
    printOutput(await showExpenses(options), options, formatExpenses);
    return;
  }
  if (command === "cashflow") {
    printOutput(await showCashflow(options), options, formatCashflow);
    return;
  }
  if (command === "net-worth") {
    printOutput(await showNetWorth(options), options, formatNetWorth);
    return;
  }
  if (command === "assets") {
    printOutput(await listAssets(options), options, formatAssets);
    return;
  }
  if (command === "liabilities") {
    printOutput(await listLiabilities(options), options, formatLiabilities);
    return;
  }
  if (command === "what-changed") {
    printOutput(await whatChanged(options), options, formatWhatChanged);
    return;
  }
  if (command === "summary") {
    printOutput(await summary(options), options, formatSummary);
    return;
  }
  if (command === "weekly-review") {
    printOutput(await weeklyReview(options), options, formatWeeklyReview);
    return;
  }
  if (command === "monthly-digest") {
    printOutput(await monthlyDigest(options), options, formatMonthlyDigest);
    return;
  }
  if (command === "recurring") {
    printOutput(await showRecurring(options), options, formatRecurring);
    return;
  }
  if (command === "top-categories") {
    printOutput(await showTopCategories(options), options, formatTopCategories);
    return;
  }
  if (command === "next-step") {
    printOutput(await nextStep(options), options, formatNextStep);
    return;
  }
  if (command === "missing-data") {
    printOutput(await showMissingData(options), options, formatMissingData);
    return;
  }
  if (command === "parsing-issues") {
    printOutput(await showParsingIssues(options), options, formatParsingIssues);
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
