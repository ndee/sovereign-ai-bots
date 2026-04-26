import type {
  AccountsResult,
  AssetsResult,
  DocumentsResult,
  DocumentTypesResult,
  HelpResult,
  ImportResult,
  LiabilitiesResult,
  MissingDataResult,
  MonthlyDigestResult,
  MonthOverviewResult,
  NetWorthResult,
  NextStepResult,
  ParseResultOutput,
  ParsingIssuesResult,
  RecurringResult,
  ShowDocumentResult,
  SummaryResult,
  TopCategoriesResult,
  TransactionsResult,
  WeeklyReviewResult,
  WhatChangedResult,
} from "./commands.js";
import { DOCUMENT_KIND_LABELS } from "./constants.js";
import { formatAmount } from "./util.js";

const indent = (line: string): string => `  ${line}`;

const dataConfidenceLine = (documentCount: number): string => {
  if (documentCount === 0) {
    return "Data confidence: no documents parsed for this period.";
  }
  if (documentCount === 1) {
    return "Data confidence: limited, based on 1 parsed document.";
  }
  return `Data confidence: good, based on ${String(documentCount)} parsed documents.`;
};

export const formatHelp = (result: HelpResult): string => {
  const lines = ["Wealth Alignment commands:", ""];
  for (const command of result.commands) {
    lines.push(`- ${command.name}: ${command.description}`);
    lines.push(indent(command.usage));
  }
  lines.push("", result.description);
  return lines.join("\n");
};

export const formatDocumentTypes = (result: DocumentTypesResult): string => {
  const lines = ["Supported document types:"];
  for (const entry of result.supported) {
    lines.push(`- ${entry.kind} — ${entry.label}`);
  }
  return lines.join("\n");
};

export const formatImport = (result: ImportResult): string => {
  const lines = [
    `Document registered: ${result.document.id}`,
    `Type: ${DOCUMENT_KIND_LABELS[result.document.document_type]}${result.inferred ? " (inferred)" : ""}`,
    `Status: ${result.document.parse_status}`,
  ];
  if (result.document.source_path !== undefined) {
    lines.push(`Source: ${result.document.source_path}`);
  }
  lines.push("Next step: run `parse --id " + result.document.id + "` to extract records.");
  return lines.join("\n");
};

export const formatDocuments = (result: DocumentsResult): string => {
  if (result.documents.length === 0) {
    return "No documents have been registered yet.";
  }
  const lines = [`Documents (${String(result.documents.length)}):`];
  for (const doc of result.documents) {
    const range =
      doc.date_range_start !== undefined && doc.date_range_end !== undefined
        ? ` ${doc.date_range_start} → ${doc.date_range_end}`
        : "";
    const institution = doc.institution !== undefined ? ` ${doc.institution}` : "";
    lines.push(
      `- ${doc.id} ${DOCUMENT_KIND_LABELS[doc.document_type]}${institution}${range} [${doc.parse_status}]`,
    );
  }
  return lines.join("\n");
};

export const formatShowDocument = (result: ShowDocumentResult): string => {
  const lines = [
    `Document: ${result.document.id}`,
    `Type: ${DOCUMENT_KIND_LABELS[result.document.document_type]}`,
    `Status: ${result.document.parse_status}`,
  ];
  if (result.document.institution !== undefined) {
    lines.push(`Institution: ${result.document.institution}`);
  }
  if (
    result.document.date_range_start !== undefined &&
    result.document.date_range_end !== undefined
  ) {
    lines.push(
      `Date range: ${result.document.date_range_start} to ${result.document.date_range_end}`,
    );
  }
  lines.push(
    `Transactions extracted: ${String(result.transactionCount)}`,
    `Assets extracted: ${String(result.assetCount)}`,
    `Liabilities extracted: ${String(result.liabilityCount)}`,
  );
  if (result.account !== undefined) {
    lines.push(`Account: ${result.account.name} (${result.account.type})`);
  }
  if (result.document.parse_warnings !== undefined && result.document.parse_warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of result.document.parse_warnings) {
      lines.push(indent(warning));
    }
  }
  return lines.join("\n");
};

export const formatParse = (result: ParseResultOutput): string => {
  const lines = [
    `Document parsed: ${DOCUMENT_KIND_LABELS[result.document.document_type]}`,
    `Document ID: ${result.document.id}`,
  ];
  if (result.document.institution !== undefined) {
    lines.push(`Institution: ${result.document.institution}`);
  }
  if (
    result.document.date_range_start !== undefined &&
    result.document.date_range_end !== undefined
  ) {
    lines.push(
      `Date range: ${result.document.date_range_start} to ${result.document.date_range_end}`,
    );
  }
  lines.push(
    `Transactions extracted: ${String(result.extracted.transactions)}`,
    `Assets extracted: ${String(result.extracted.assets)}`,
    `Liabilities extracted: ${String(result.extracted.liabilities)}`,
    `Status: ${result.document.parse_status}`,
  );
  if (result.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of result.warnings) {
      lines.push(indent(warning));
    }
  }
  return lines.join("\n");
};

export const formatAccounts = (result: AccountsResult): string => {
  if (result.accounts.length === 0) {
    return "No accounts tracked yet.";
  }
  const lines = [`Accounts (${String(result.accounts.length)}):`];
  for (const account of result.accounts) {
    const balance =
      account.current_balance === undefined
        ? ""
        : ` balance ${formatAmount(account.current_balance, account.currency)}`;
    const institution = account.institution === undefined ? "" : ` ${account.institution}`;
    lines.push(`- ${account.name} (${account.type})${institution}${balance}`);
  }
  return lines.join("\n");
};

export const formatTransactions = (result: TransactionsResult): string => {
  if (result.transactions.length === 0) {
    return result.yearMonth === undefined
      ? "No transactions tracked yet."
      : `No transactions for ${result.yearMonth}.`;
  }
  const header =
    result.yearMonth === undefined
      ? `Transactions (${String(result.transactions.length)}):`
      : `Transactions for ${result.yearMonth} (${String(result.transactions.length)}):`;
  const lines = [header];
  const slice = result.transactions.slice(0, 25);
  for (const transaction of slice) {
    lines.push(
      `- ${transaction.date} ${transaction.direction.toUpperCase()} ${formatAmount(transaction.amount, transaction.currency)} | ${transaction.category} | ${transaction.description}`,
    );
  }
  if (result.transactions.length > slice.length) {
    lines.push(`... and ${String(result.transactions.length - slice.length)} more.`);
  }
  return lines.join("\n");
};

export const formatIncome = (result: MonthOverviewResult): string =>
  [
    `Income for ${result.yearMonth}:`,
    `Total: ${formatAmount(result.totals.income, result.totals.currency)}`,
    "",
    dataConfidenceLine(result.documentCount),
  ].join("\n");

export const formatExpenses = (result: MonthOverviewResult): string => {
  const lines = [
    `Expenses for ${result.yearMonth}:`,
    `Total: ${formatAmount(result.totals.expenses, result.totals.currency)}`,
  ];
  if (result.topCategories.length > 0) {
    lines.push("Top categories:");
    for (const [index, category] of result.topCategories.entries()) {
      lines.push(
        `${String(index + 1)}. ${category.category} — ${formatAmount(category.total, result.totals.currency)}`,
      );
    }
  }
  lines.push("", dataConfidenceLine(result.documentCount));
  return lines.join("\n");
};

export const formatCashflow = (result: MonthOverviewResult): string =>
  [
    `Cashflow for ${result.yearMonth}:`,
    `Income: ${formatAmount(result.totals.income, result.totals.currency)}`,
    `Expenses: ${formatAmount(result.totals.expenses, result.totals.currency)}`,
    `Net cashflow: ${formatAmount(result.totals.netCashflow, result.totals.currency)}`,
    "",
    dataConfidenceLine(result.documentCount),
  ].join("\n");

export const formatNetWorth = (result: NetWorthResult): string => {
  const lines = [
    "Estimated net worth:",
    `Assets: ${formatAmount(result.summary.assetTotal, result.summary.currency)}`,
    `Liabilities: ${formatAmount(result.summary.liabilityTotal, result.summary.currency)}`,
    `Net worth: ${formatAmount(result.summary.netWorth, result.summary.currency)}`,
  ];
  if (result.note !== undefined) {
    lines.push("", `Note: ${result.note}`);
  }
  return lines.join("\n");
};

export const formatAssets = (result: AssetsResult): string => {
  if (result.assets.length === 0) {
    return "No asset records yet.";
  }
  const lines = [
    `Assets (${String(result.assets.length)}, total ${formatAmount(result.total, result.currency)}):`,
  ];
  for (const asset of result.assets) {
    lines.push(
      `- ${asset.label} (${asset.type}) ${formatAmount(asset.value, asset.currency)} as of ${asset.as_of_date}`,
    );
  }
  return lines.join("\n");
};

export const formatLiabilities = (result: LiabilitiesResult): string => {
  if (result.liabilities.length === 0) {
    return "No liability records yet.";
  }
  const lines = [
    `Liabilities (${String(result.liabilities.length)}, total ${formatAmount(result.total, result.currency)}):`,
  ];
  for (const liability of result.liabilities) {
    lines.push(
      `- ${liability.label} (${liability.type}) ${formatAmount(liability.outstanding_balance, liability.currency)} as of ${liability.as_of_date}`,
    );
  }
  return lines.join("\n");
};

export const formatWhatChanged = (result: WhatChangedResult): string =>
  [
    `Change between ${result.previousMonth} and ${result.yearMonth}:`,
    `Income delta: ${formatAmount(result.incomeDelta, result.current.currency)}`,
    `Expenses delta: ${formatAmount(result.expensesDelta, result.current.currency)}`,
    `Net cashflow delta: ${formatAmount(result.netCashflowDelta, result.current.currency)}`,
  ].join("\n");

export const formatSummary = (result: SummaryResult): string => {
  const lines = [
    "Wealth Alignment summary:",
    `Documents: ${String(result.documentCount)} (pending ${String(result.parsingPending)}, needs review ${String(result.parsingNeedsReview)}, failed ${String(result.parsingFailed)})`,
    `Accounts: ${String(result.accountCount)}`,
    `Transactions: ${String(result.transactionCount)}`,
    `Assets: ${String(result.assetCount)} | Liabilities: ${String(result.liabilityCount)}`,
    `Net worth: ${formatAmount(result.netWorth.netWorth, result.netWorth.currency)} (assets ${formatAmount(result.netWorth.assetTotal, result.netWorth.currency)}, liabilities ${formatAmount(result.netWorth.liabilityTotal, result.netWorth.currency)})`,
    `Current month (${result.currentMonth.yearMonth}): income ${formatAmount(result.currentMonth.income, result.currentMonth.currency)}, expenses ${formatAmount(result.currentMonth.expenses, result.currentMonth.currency)}, net ${formatAmount(result.currentMonth.netCashflow, result.currentMonth.currency)}`,
  ];
  if (result.recentSnapshots.length > 0) {
    lines.push("Recent snapshots:");
    for (const snapshot of result.recentSnapshots) {
      lines.push(
        indent(
          `${snapshot.year_month}: net ${formatAmount(snapshot.net_cashflow, snapshot.currency)}`,
        ),
      );
    }
  }
  return lines.join("\n");
};

export const formatWeeklyReview = (result: WeeklyReviewResult): string => {
  const lines = [
    "Weekly money review:",
    `Window: ${result.windowStart} to ${result.windowEnd}`,
    `Documents added: ${String(result.documentsAdded.length)}`,
    `New transactions: ${String(result.newTransactions.length)}`,
  ];
  if (result.notableExpenses.length > 0) {
    lines.push("Notable expenses:");
    for (const transaction of result.notableExpenses) {
      lines.push(
        indent(
          `${transaction.date} ${formatAmount(transaction.amount, transaction.currency)} ${transaction.description}`,
        ),
      );
    }
  }
  if (result.missingData.length > 0) {
    lines.push("Missing or uncertain data:");
    for (const entry of result.missingData) {
      lines.push(indent(entry));
    }
  }
  lines.push(`Next step: ${result.nextStep}`);
  return lines.join("\n");
};

export const formatMonthlyDigest = (result: MonthlyDigestResult): string => {
  const lines = [
    `Monthly money digest for ${result.yearMonth}:`,
    `Income: ${formatAmount(result.totals.income, result.totals.currency)}`,
    `Expenses: ${formatAmount(result.totals.expenses, result.totals.currency)}`,
    `Net cashflow: ${formatAmount(result.totals.netCashflow, result.totals.currency)}`,
  ];
  if (result.topCategories.length > 0) {
    lines.push("Top expense categories:");
    for (const [index, category] of result.topCategories.entries()) {
      lines.push(
        `${String(index + 1)}. ${category.category} — ${formatAmount(category.total, result.totals.currency)}`,
      );
    }
  }
  if (result.recurring.length > 0) {
    lines.push("Recurring expenses:");
    for (const entry of result.recurring.slice(0, 5)) {
      lines.push(
        indent(
          `${entry.description} avg ${formatAmount(entry.averageAmount, entry.currency)} (${String(entry.occurrences)}x)`,
        ),
      );
    }
  }
  if (result.netWorth.hasAssets || result.netWorth.hasLiabilities) {
    lines.push(
      `Net worth: ${formatAmount(result.netWorth.netWorth, result.netWorth.currency)} (assets ${formatAmount(result.netWorth.assetTotal, result.netWorth.currency)}, liabilities ${formatAmount(result.netWorth.liabilityTotal, result.netWorth.currency)})`,
    );
  } else {
    lines.push("Net worth: incomplete — no asset or liability data parsed yet.");
  }
  if (result.missingData.length > 0) {
    lines.push("Missing data:");
    for (const entry of result.missingData) {
      lines.push(indent(entry));
    }
  }
  lines.push(`Next step: ${result.nextStep}`);
  return lines.join("\n");
};

export const formatRecurring = (result: RecurringResult): string => {
  if (result.recurring.length === 0) {
    return "No recurring expenses detected yet.";
  }
  const lines = [`Recurring expenses (${String(result.recurring.length)}):`];
  for (const entry of result.recurring) {
    lines.push(
      `- ${entry.description} (${entry.category}) avg ${formatAmount(entry.averageAmount, entry.currency)} (${String(entry.occurrences)}x)`,
    );
  }
  return lines.join("\n");
};

export const formatTopCategories = (result: TopCategoriesResult): string => {
  if (result.categories.length === 0) {
    return `No expense categories for ${result.yearMonth}.`;
  }
  const lines = [`Biggest expense categories for ${result.yearMonth}:`];
  for (const [index, category] of result.categories.entries()) {
    lines.push(
      `${String(index + 1)}. ${category.category} — ${formatAmount(category.total, result.currency)} (${String(category.count)} entries)`,
    );
  }
  return lines.join("\n");
};

export const formatNextStep = (result: NextStepResult): string => {
  const lines = ["Suggested next step:", result.step];
  if (result.missing.length > 0) {
    lines.push("", "Missing data:");
    for (const entry of result.missing) {
      lines.push(indent(entry));
    }
  }
  return lines.join("\n");
};

export const formatMissingData = (result: MissingDataResult): string => {
  if (result.missing.length === 0) {
    return `No missing data detected for ${result.yearMonth}.`;
  }
  const lines = [`Missing data for ${result.yearMonth}:`];
  for (const entry of result.missing) {
    lines.push(`- ${entry}`);
  }
  return lines.join("\n");
};

export const formatParsingIssues = (result: ParsingIssuesResult): string => {
  if (result.documents.length === 0) {
    return "No parsing issues. All documents are parsed.";
  }
  const lines = [`Parsing issues (${String(result.documents.length)}):`];
  for (const doc of result.documents) {
    lines.push(`- ${doc.id} ${DOCUMENT_KIND_LABELS[doc.document_type]} [${doc.parse_status}]`);
    if (doc.parse_warnings !== undefined) {
      for (const warning of doc.parse_warnings) {
        lines.push(indent(warning));
      }
    }
  }
  return lines.join("\n");
};
