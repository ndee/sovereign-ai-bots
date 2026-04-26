import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import {
  DEFAULT_CURRENCY,
  DOCUMENT_KIND_LABELS,
  MAX_RAW_TEXT_BYTES,
  SUPPORTED_DOCUMENT_KINDS,
} from "./constants.js";
import type { ParseResult } from "./parser.js";
import { inferDocumentKind, parseDocumentText } from "./parser.js";
import type { WealthRuntime } from "./runtime.js";
import { resolveRuntime } from "./runtime.js";
import type {
  CategoryTotal,
  MonthlyTotals,
  NetWorthSummary,
  RecurringExpense,
} from "./snapshot.js";
import {
  annotateRecurringFlags,
  generateMonthlySnapshot,
  monthlyTotals,
  netWorthSummary,
  recurringExpenses,
  topExpenseCategories,
  transactionsForMonth,
  upsertSnapshot,
} from "./snapshot.js";
import type {
  AccountRecord,
  AccountType,
  AssetRecord,
  CommandOptions,
  DocumentKind,
  DocumentRecord,
  LiabilityRecord,
  MonthlySnapshot,
  TransactionRecord,
  WealthState,
} from "./types.js";
import {
  currentYearMonth,
  isYearMonth,
  nowIso,
  previousYearMonth,
  resolveRelativeToBase,
  yearMonthOf,
} from "./util.js";

const requireInstance = (options: Pick<CommandOptions, "instance">): string => {
  if (typeof options.instance !== "string" || options.instance.length === 0) {
    throw new Error("Expected --instance <id>");
  }
  return options.instance;
};

const ensureRuntime = async (
  options: Pick<CommandOptions, "instance" | "configPath">,
): Promise<WealthRuntime> => {
  const instance = requireInstance(options);
  return resolveRuntime(instance, options.configPath);
};

const ensureMonth = (options: Pick<CommandOptions, "month">): string => {
  const value = options.month ?? currentYearMonth();
  if (!isYearMonth(value)) {
    throw new Error(`Invalid --month value: ${value} (expected YYYY-MM)`);
  }
  return value;
};

const parseDocumentKind = (value: string | undefined): DocumentKind => {
  if (value === undefined) {
    return "unknown";
  }
  if ((SUPPORTED_DOCUMENT_KINDS as string[]).includes(value)) {
    return value as DocumentKind;
  }
  if (value === "unknown") {
    return "unknown";
  }
  throw new Error(
    `Unsupported document kind: ${value}. Supported kinds: ${SUPPORTED_DOCUMENT_KINDS.join(", ")}.`,
  );
};

const findDocument = (state: WealthState, id: string): DocumentRecord => {
  const document = state.documents.find((entry) => entry.id === id);
  if (document === undefined) {
    throw new Error(`Document not found: ${id}`);
  }
  return document;
};

const upsertAccountFromParse = (
  state: WealthState,
  parse: ParseResult,
  document: DocumentRecord,
): AccountRecord | undefined => {
  if (parse.account_name === undefined) {
    return undefined;
  }
  const accountType: AccountType =
    document.document_type === "credit_card_statement" ? "credit_card" : "bank";
  const existing = state.accounts.find(
    (entry) =>
      entry.name === parse.account_name &&
      entry.institution === parse.institution &&
      entry.currency === parse.currency,
  );
  if (existing !== undefined) {
    if (parse.account_balance !== undefined) {
      existing.current_balance = parse.account_balance;
    }
    if (parse.date_range_end !== undefined) {
      existing.last_statement_date = parse.date_range_end;
    }
    return existing;
  }
  const account: AccountRecord = {
    id: `acct-${randomUUID().slice(0, 8)}`,
    name: parse.account_name,
    institution: parse.institution,
    type: accountType,
    currency: parse.currency,
    current_balance: parse.account_balance,
    last_statement_date: parse.date_range_end,
    status: "active",
  };
  state.accounts.push(account);
  return account;
};

const removeRecordsForDocument = (state: WealthState, documentId: string): void => {
  state.transactions = state.transactions.filter((entry) => entry.document_id !== documentId);
  state.assets = state.assets.filter((entry) => entry.source_document_id !== documentId);
  state.liabilities = state.liabilities.filter((entry) => entry.source_document_id !== documentId);
};

const applyParseResult = (
  state: WealthState,
  document: DocumentRecord,
  parse: ParseResult,
): { transactions: number; assets: number; liabilities: number } => {
  removeRecordsForDocument(state, document.id);
  document.parse_status = parse.status;
  document.parse_warnings = parse.warnings.length > 0 ? parse.warnings : undefined;
  document.institution = parse.institution ?? document.institution;
  document.date_range_start = parse.date_range_start ?? document.date_range_start;
  document.date_range_end = parse.date_range_end ?? document.date_range_end;
  if (
    document.document_type === "unknown" &&
    document.source_path !== undefined &&
    document.extracted_text !== undefined
  ) {
    document.document_type = inferDocumentKind(document.source_path, document.extracted_text);
  }
  const account = upsertAccountFromParse(state, parse, document);
  for (const draft of parse.transactions) {
    const transaction: TransactionRecord = {
      id: `txn-${randomUUID().slice(0, 8)}`,
      document_id: document.id,
      account_id: account?.id,
      date: draft.date,
      amount: draft.amount,
      currency: draft.currency,
      direction: draft.direction,
      category: draft.category,
      description: draft.description,
      counterparty: draft.counterparty,
      confidence: draft.confidence,
    };
    state.transactions.push(transaction);
    state.counters.transactions += 1;
  }
  for (const draft of parse.assets) {
    const asset: AssetRecord = {
      id: `ast-${randomUUID().slice(0, 8)}`,
      label: draft.label,
      type: draft.type,
      value: draft.value,
      currency: draft.currency,
      as_of_date: draft.as_of_date,
      source_document_id: document.id,
      notes: draft.notes,
    };
    state.assets.push(asset);
  }
  for (const draft of parse.liabilities) {
    const liability: LiabilityRecord = {
      id: `lia-${randomUUID().slice(0, 8)}`,
      label: draft.label,
      type: draft.type,
      outstanding_balance: draft.outstanding_balance,
      currency: draft.currency,
      as_of_date: draft.as_of_date,
      source_document_id: document.id,
      notes: draft.notes,
    };
    state.liabilities.push(liability);
  }
  state.lastParseAt = nowIso();
  annotateRecurringFlags(state);
  // Refresh affected snapshots.
  const months = new Set<string>();
  for (const transaction of state.transactions.filter(
    (entry) => entry.document_id === document.id,
  )) {
    const month = yearMonthOf(transaction.date);
    if (month !== undefined) {
      months.add(month);
    }
  }
  for (const month of months) {
    upsertSnapshot(state, generateMonthlySnapshot(state, month));
  }
  return {
    transactions: parse.transactions.length,
    assets: parse.assets.length,
    liabilities: parse.liabilities.length,
  };
};

export interface HelpResult {
  bot: "wealth-alignment";
  description: string;
  commands: Array<{ name: string; usage: string; description: string }>;
}

export const help = (): HelpResult => ({
  bot: "wealth-alignment",
  description:
    "Private local-first financial clarity. Drop documents into the inbox, then ask for overviews, snapshots, and digests.",
  commands: [
    { name: "help", usage: "help", description: "Show available commands." },
    {
      name: "document-types",
      usage: "document-types",
      description: "List supported document kinds.",
    },
    {
      name: "import",
      usage: "import --path <file> [--kind <kind>] [--institution <name>] [--notes <text>]",
      description: "Register a document already placed in the inbox directory.",
    },
    {
      name: "documents",
      usage: "documents",
      description: "List registered documents with parse status.",
    },
    {
      name: "show-document",
      usage: "show-document --id <document-id>",
      description: "Show a single document and its parsed totals.",
    },
    {
      name: "parse",
      usage: "parse --id <document-id>",
      description: "Parse an imported document.",
    },
    {
      name: "reparse",
      usage: "reparse --id <document-id>",
      description: "Re-read the source file and re-extract structured records.",
    },
    { name: "accounts", usage: "accounts", description: "List known accounts." },
    {
      name: "transactions",
      usage: "transactions [--month YYYY-MM]",
      description: "List transactions, optionally for a specific month.",
    },
    {
      name: "income",
      usage: "income [--month YYYY-MM]",
      description: "Show monthly income.",
    },
    {
      name: "expenses",
      usage: "expenses [--month YYYY-MM]",
      description: "Show monthly expenses with top categories.",
    },
    {
      name: "cashflow",
      usage: "cashflow [--month YYYY-MM]",
      description: "Show monthly net cashflow.",
    },
    { name: "net-worth", usage: "net-worth", description: "Show estimated net worth." },
    { name: "assets", usage: "assets", description: "List known assets." },
    { name: "liabilities", usage: "liabilities", description: "List known liabilities." },
    {
      name: "what-changed",
      usage: "what-changed [--month YYYY-MM]",
      description: "Compare a month against the previous month.",
    },
    {
      name: "summary",
      usage: "summary",
      description: "Compact financial overview across all loaded data.",
    },
    {
      name: "weekly-review",
      usage: "weekly-review",
      description: "Last-7-day review with documents added, transactions, and one next step.",
    },
    {
      name: "monthly-digest",
      usage: "monthly-digest [--month YYYY-MM]",
      description:
        "Monthly digest with totals, top categories, recurring expenses, and a next step.",
    },
    {
      name: "recurring",
      usage: "recurring",
      description: "Show recurring expenses detected across loaded transactions.",
    },
    {
      name: "top-categories",
      usage: "top-categories [--month YYYY-MM]",
      description: "Show biggest expense categories for a month.",
    },
    {
      name: "next-step",
      usage: "next-step",
      description: "Suggest the next concrete review step based on missing/uncertain data.",
    },
    {
      name: "missing-data",
      usage: "missing-data",
      description: "List specific gaps (missing income, missing liabilities, etc.).",
    },
    {
      name: "parsing-issues",
      usage: "parsing-issues",
      description: "List documents that failed to parse or need review.",
    },
  ],
});

export interface DocumentTypesResult {
  supported: Array<{ kind: DocumentKind; label: string }>;
}

export const documentTypes = (): DocumentTypesResult => ({
  supported: SUPPORTED_DOCUMENT_KINDS.map((kind) => ({
    kind,
    label: DOCUMENT_KIND_LABELS[kind],
  })),
});

const safeReadText = async (filePath: string): Promise<string> => {
  const stats = await stat(filePath);
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }
  if (stats.size > MAX_RAW_TEXT_BYTES) {
    const buffer = await readFile(filePath);
    return buffer.subarray(0, MAX_RAW_TEXT_BYTES).toString("utf8");
  }
  return readFile(filePath, "utf8");
};

export interface ImportResult {
  document: DocumentRecord;
  inferred: boolean;
}

export const importDocument = async (options: CommandOptions): Promise<ImportResult> => {
  const runtime = await ensureRuntime(options);
  if (typeof options.path !== "string" || options.path.length === 0) {
    throw new Error("Expected --path <file>");
  }
  const resolved = resolveRelativeToBase(options.path, runtime.inboxPath);
  const text = await safeReadText(resolved);
  const requestedKind = parseDocumentKind(options.kind);
  const inferred = requestedKind === "unknown";
  const finalKind = inferred ? inferDocumentKind(resolved, text) : requestedKind;
  const document: DocumentRecord = {
    id: `doc-${randomUUID().slice(0, 8)}`,
    source_type: "file",
    document_type: finalKind,
    uploaded_at: nowIso(),
    institution: options.institution,
    raw_text: text,
    extracted_text: text,
    parse_status: "pending",
    notes: options.notes,
    source_path: resolved,
  };
  const state = await runtime.readState();
  state.documents.push(document);
  state.counters.documents += 1;
  state.lastImportAt = document.uploaded_at;
  await runtime.writeState(state);
  return { document, inferred };
};

export interface DocumentsResult {
  documents: DocumentRecord[];
}

export const listDocuments = async (options: CommandOptions): Promise<DocumentsResult> => {
  const runtime = await ensureRuntime(options);
  const state = await runtime.readState();
  return {
    documents: state.documents
      .slice()
      .sort((left, right) => right.uploaded_at.localeCompare(left.uploaded_at)),
  };
};

export interface ShowDocumentResult {
  document: DocumentRecord;
  account?: AccountRecord | undefined;
  transactionCount: number;
  assetCount: number;
  liabilityCount: number;
}

export const showDocument = async (options: CommandOptions): Promise<ShowDocumentResult> => {
  const runtime = await ensureRuntime(options);
  if (typeof options.id !== "string") {
    throw new Error("Expected --id <document-id>");
  }
  const state = await runtime.readState();
  const document = findDocument(state, options.id);
  const transactions = state.transactions.filter((entry) => entry.document_id === document.id);
  const accountId = transactions[0]?.account_id;
  const account =
    accountId === undefined ? undefined : state.accounts.find((entry) => entry.id === accountId);
  return {
    document,
    account,
    transactionCount: transactions.length,
    assetCount: state.assets.filter((entry) => entry.source_document_id === document.id).length,
    liabilityCount: state.liabilities.filter((entry) => entry.source_document_id === document.id)
      .length,
  };
};

export interface ParseResultOutput {
  document: DocumentRecord;
  extracted: { transactions: number; assets: number; liabilities: number };
  warnings: string[];
}

export const parseDocument = async (options: CommandOptions): Promise<ParseResultOutput> => {
  const runtime = await ensureRuntime(options);
  if (typeof options.id !== "string") {
    throw new Error("Expected --id <document-id>");
  }
  const state = await runtime.readState();
  const document = findDocument(state, options.id);
  const text = document.extracted_text ?? document.raw_text ?? "";
  const parse = parseDocumentText(document, text);
  const counts = applyParseResult(state, document, parse);
  await runtime.writeState(state);
  return { document, extracted: counts, warnings: parse.warnings };
};

export const reparseDocument = async (options: CommandOptions): Promise<ParseResultOutput> => {
  const runtime = await ensureRuntime(options);
  if (typeof options.id !== "string") {
    throw new Error("Expected --id <document-id>");
  }
  const state = await runtime.readState();
  const document = findDocument(state, options.id);
  if (document.source_path !== undefined) {
    try {
      const text = await safeReadText(document.source_path);
      document.raw_text = text;
      document.extracted_text = text;
    } catch (error) {
      document.parse_status = "failed";
      document.parse_warnings = [`Could not re-read source file: ${(error as Error).message}`];
      await runtime.writeState(state);
      return {
        document,
        extracted: { transactions: 0, assets: 0, liabilities: 0 },
        warnings: document.parse_warnings,
      };
    }
  }
  const text = document.extracted_text ?? document.raw_text ?? "";
  const parse = parseDocumentText(document, text);
  const counts = applyParseResult(state, document, parse);
  await runtime.writeState(state);
  return { document, extracted: counts, warnings: parse.warnings };
};

export interface AccountsResult {
  accounts: AccountRecord[];
}

export const listAccounts = async (options: CommandOptions): Promise<AccountsResult> => {
  const runtime = await ensureRuntime(options);
  const state = await runtime.readState();
  return {
    accounts: state.accounts.slice().sort((left, right) => left.name.localeCompare(right.name)),
  };
};

export interface TransactionsResult {
  yearMonth?: string | undefined;
  transactions: TransactionRecord[];
}

export const listTransactions = async (options: CommandOptions): Promise<TransactionsResult> => {
  const runtime = await ensureRuntime(options);
  const state = await runtime.readState();
  if (typeof options.month === "string") {
    const month = ensureMonth(options);
    return { yearMonth: month, transactions: transactionsForMonth(state, month) };
  }
  return {
    transactions: state.transactions
      .slice()
      .sort((left, right) => right.date.localeCompare(left.date)),
  };
};

export interface MonthOverviewResult {
  yearMonth: string;
  totals: MonthlyTotals;
  topCategories: CategoryTotal[];
  documentCount: number;
}

const monthOverview = (state: WealthState, yearMonth: string): MonthOverviewResult => {
  const totals = monthlyTotals(state, yearMonth);
  const topCategories = topExpenseCategories(totals);
  const documentCount = state.documents.filter((document) => {
    const start = document.date_range_start;
    const end = document.date_range_end;
    if (start !== undefined && end !== undefined) {
      const startMonth = yearMonthOf(start);
      const endMonth = yearMonthOf(end);
      if (startMonth !== undefined && endMonth !== undefined) {
        return yearMonth >= startMonth && yearMonth <= endMonth;
      }
    }
    return yearMonthOf(document.uploaded_at) === yearMonth;
  }).length;
  return { yearMonth, totals, topCategories, documentCount };
};

export const showIncome = async (options: CommandOptions): Promise<MonthOverviewResult> => {
  const runtime = await ensureRuntime(options);
  const state = await runtime.readState();
  return monthOverview(state, ensureMonth(options));
};

export const showExpenses = async (options: CommandOptions): Promise<MonthOverviewResult> => {
  const runtime = await ensureRuntime(options);
  const state = await runtime.readState();
  return monthOverview(state, ensureMonth(options));
};

export const showCashflow = async (options: CommandOptions): Promise<MonthOverviewResult> => {
  const runtime = await ensureRuntime(options);
  const state = await runtime.readState();
  return monthOverview(state, ensureMonth(options));
};

export interface NetWorthResult {
  summary: NetWorthSummary;
  note?: string | undefined;
}

export const showNetWorth = async (options: CommandOptions): Promise<NetWorthResult> => {
  const runtime = await ensureRuntime(options);
  const state = await runtime.readState();
  const summary = netWorthSummary(state);
  const notes: string[] = [];
  if (!summary.hasAssets) {
    notes.push("No asset records have been parsed yet.");
  }
  if (!summary.hasLiabilities) {
    notes.push("No liability records have been parsed yet.");
  }
  return { summary, note: notes.length === 0 ? undefined : notes.join(" ") };
};

export interface AssetsResult {
  assets: AssetRecord[];
  total: number;
  currency: string;
}

export const listAssets = async (options: CommandOptions): Promise<AssetsResult> => {
  const runtime = await ensureRuntime(options);
  const state = await runtime.readState();
  const summary = netWorthSummary(state);
  return { assets: state.assets, total: summary.assetTotal, currency: summary.currency };
};

export interface LiabilitiesResult {
  liabilities: LiabilityRecord[];
  total: number;
  currency: string;
}

export const listLiabilities = async (options: CommandOptions): Promise<LiabilitiesResult> => {
  const runtime = await ensureRuntime(options);
  const state = await runtime.readState();
  const summary = netWorthSummary(state);
  return {
    liabilities: state.liabilities,
    total: summary.liabilityTotal,
    currency: summary.currency,
  };
};

export interface WhatChangedResult {
  yearMonth: string;
  previousMonth: string;
  current: MonthlyTotals;
  previous: MonthlyTotals;
  incomeDelta: number;
  expensesDelta: number;
  netCashflowDelta: number;
}

export const whatChanged = async (options: CommandOptions): Promise<WhatChangedResult> => {
  const runtime = await ensureRuntime(options);
  const state = await runtime.readState();
  const yearMonth = ensureMonth(options);
  const previousMonth = previousYearMonth(yearMonth);
  const current = monthlyTotals(state, yearMonth);
  const previous = monthlyTotals(state, previousMonth);
  return {
    yearMonth,
    previousMonth,
    current,
    previous,
    incomeDelta: Math.round((current.income - previous.income) * 100) / 100,
    expensesDelta: Math.round((current.expenses - previous.expenses) * 100) / 100,
    netCashflowDelta: Math.round((current.netCashflow - previous.netCashflow) * 100) / 100,
  };
};

export interface SummaryResult {
  documentCount: number;
  transactionCount: number;
  accountCount: number;
  assetCount: number;
  liabilityCount: number;
  parsingPending: number;
  parsingFailed: number;
  parsingNeedsReview: number;
  recentSnapshots: MonthlySnapshot[];
  netWorth: NetWorthSummary;
  currentMonth: MonthlyTotals;
}

export const summary = async (options: CommandOptions): Promise<SummaryResult> => {
  const runtime = await ensureRuntime(options);
  const state = await runtime.readState();
  const month = currentYearMonth();
  const totals = monthlyTotals(state, month);
  const summaryNetWorth = netWorthSummary(state, totals.currency);
  return {
    documentCount: state.documents.length,
    transactionCount: state.transactions.length,
    accountCount: state.accounts.length,
    assetCount: state.assets.length,
    liabilityCount: state.liabilities.length,
    parsingPending: state.documents.filter((entry) => entry.parse_status === "pending").length,
    parsingFailed: state.documents.filter((entry) => entry.parse_status === "failed").length,
    parsingNeedsReview: state.documents.filter((entry) => entry.parse_status === "needs_review")
      .length,
    recentSnapshots: state.snapshots.slice(-6),
    netWorth: summaryNetWorth,
    currentMonth: totals,
  };
};

export interface WeeklyReviewResult {
  windowStart: string;
  windowEnd: string;
  documentsAdded: DocumentRecord[];
  newTransactions: TransactionRecord[];
  notableExpenses: TransactionRecord[];
  missingData: string[];
  nextStep: string;
}

const sevenDaysAgo = (now: Date = new Date()): string => {
  const past = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return past.toISOString();
};

export const weeklyReview = async (options: CommandOptions): Promise<WeeklyReviewResult> => {
  const runtime = await ensureRuntime(options);
  const state = await runtime.readState();
  const windowEnd = nowIso();
  const windowStart = sevenDaysAgo();
  const documentsAdded = state.documents.filter(
    (entry) => entry.uploaded_at >= windowStart && entry.uploaded_at <= windowEnd,
  );
  const documentIds = new Set(documentsAdded.map((entry) => entry.id));
  const newTransactions = state.transactions.filter((entry) => documentIds.has(entry.document_id));
  const notableExpenses = newTransactions
    .filter((entry) => entry.direction === "expense")
    .slice()
    .sort((left, right) => Math.abs(right.amount) - Math.abs(left.amount))
    .slice(0, 3);
  const missing = computeMissingData(state);
  const nextStep = chooseNextStep(state, missing);
  return {
    windowStart,
    windowEnd,
    documentsAdded,
    newTransactions,
    notableExpenses,
    missingData: missing,
    nextStep,
  };
};

export interface MonthlyDigestResult {
  yearMonth: string;
  totals: MonthlyTotals;
  topCategories: CategoryTotal[];
  recurring: RecurringExpense[];
  netWorth: NetWorthSummary;
  nextStep: string;
  missingData: string[];
}

export const monthlyDigest = async (options: CommandOptions): Promise<MonthlyDigestResult> => {
  const runtime = await ensureRuntime(options);
  const state = await runtime.readState();
  const yearMonth = ensureMonth(options);
  const totals = monthlyTotals(state, yearMonth);
  const summaryNetWorth = netWorthSummary(state, totals.currency);
  const missing = computeMissingData(state, yearMonth);
  return {
    yearMonth,
    totals,
    topCategories: topExpenseCategories(totals),
    recurring: recurringExpenses(state),
    netWorth: summaryNetWorth,
    nextStep: chooseNextStep(state, missing, yearMonth),
    missingData: missing,
  };
};

export interface RecurringResult {
  recurring: RecurringExpense[];
}

export const showRecurring = async (options: CommandOptions): Promise<RecurringResult> => {
  const runtime = await ensureRuntime(options);
  const state = await runtime.readState();
  return { recurring: recurringExpenses(state) };
};

export interface TopCategoriesResult {
  yearMonth: string;
  currency: string;
  categories: CategoryTotal[];
}

export const showTopCategories = async (options: CommandOptions): Promise<TopCategoriesResult> => {
  const runtime = await ensureRuntime(options);
  const state = await runtime.readState();
  const month = ensureMonth(options);
  const totals = monthlyTotals(state, month);
  return {
    yearMonth: month,
    currency: totals.currency,
    categories: topExpenseCategories(totals),
  };
};

export const computeMissingData = (
  state: WealthState,
  yearMonth: string = currentYearMonth(),
): string[] => {
  const missing: string[] = [];
  if (state.documents.length === 0) {
    missing.push("No documents have been imported yet.");
    return missing;
  }
  const totals = monthlyTotals(state, yearMonth);
  if (totals.expenses > 0 && totals.income === 0) {
    missing.push("Expenses recorded but no income for the current month.");
  }
  if (totals.income > 0 && totals.expenses === 0) {
    missing.push("Income recorded but no expense documents for the current month.");
  }
  if (state.assets.length === 0) {
    missing.push("No asset records yet.");
  }
  if (state.liabilities.length === 0) {
    missing.push("No liability records yet.");
  }
  const ccDocs = state.documents.filter((entry) => entry.document_type === "credit_card_statement");
  if (
    ccDocs.length > 0 &&
    state.documents.every((entry) => entry.document_type !== "bank_statement")
  ) {
    missing.push("Credit card statements present but no linked bank account is tracked.");
  }
  const needsReview = state.documents.filter(
    (entry) => entry.parse_status === "needs_review" || entry.parse_status === "failed",
  );
  if (needsReview.length > 0) {
    missing.push(`${String(needsReview.length)} document(s) need review or failed to parse.`);
  }
  return missing;
};

export const chooseNextStep = (
  state: WealthState,
  missingData: readonly string[],
  yearMonth: string = currentYearMonth(),
): string => {
  if (state.documents.length === 0) {
    return "Drop a finance document into the inbox and run `import` to register it.";
  }
  const pending = state.documents.find((entry) => entry.parse_status === "pending");
  if (pending !== undefined) {
    return `Run \`parse --id ${pending.id}\` to extract structured records from the next pending document.`;
  }
  const failed = state.documents.find((entry) => entry.parse_status === "failed");
  if (failed !== undefined) {
    return `Document ${failed.id} failed to parse. Reparse or replace the source file.`;
  }
  const needsReview = state.documents.find((entry) => entry.parse_status === "needs_review");
  if (needsReview !== undefined) {
    return `Document ${needsReview.id} needs review. Reparse with a more specific --kind or fix the source file.`;
  }
  if (state.liabilities.length === 0) {
    return "Add liability data — net worth is incomplete without it.";
  }
  if (state.assets.length === 0) {
    return "Add asset / account summary data — net worth is incomplete without it.";
  }
  const totals = monthlyTotals(state, yearMonth);
  if (totals.expenses > 0 && totals.income === 0) {
    return "Review missing income documents for the current month.";
  }
  if (missingData.length > 0) {
    /* v8 ignore next -- length>0 guarantees missingData[0] is defined */
    return `Review the listed missing data items: ${missingData[0] ?? ""}`;
  }
  return "Run `monthly-digest` to review the latest month and confirm everything looks expected.";
};

export interface MissingDataResult {
  yearMonth: string;
  missing: string[];
}

export const showMissingData = async (options: CommandOptions): Promise<MissingDataResult> => {
  const runtime = await ensureRuntime(options);
  const state = await runtime.readState();
  const yearMonth = options.month ?? currentYearMonth();
  return { yearMonth, missing: computeMissingData(state, yearMonth) };
};

export interface NextStepResult {
  step: string;
  missing: string[];
}

export const nextStep = async (options: CommandOptions): Promise<NextStepResult> => {
  const runtime = await ensureRuntime(options);
  const state = await runtime.readState();
  const missing = computeMissingData(state);
  return { step: chooseNextStep(state, missing), missing };
};

export interface ParsingIssuesResult {
  documents: DocumentRecord[];
}

export const showParsingIssues = async (options: CommandOptions): Promise<ParsingIssuesResult> => {
  const runtime = await ensureRuntime(options);
  const state = await runtime.readState();
  return {
    documents: state.documents.filter(
      (entry) => entry.parse_status === "failed" || entry.parse_status === "needs_review",
    ),
  };
};

// Re-export useful constants for testing.
export const __internals = {
  applyParseResult,
  fallbackCurrency: DEFAULT_CURRENCY,
};
