import { describe, expect, it } from "vitest";

import { documentTypes, help } from "./commands.js";
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

describe("wealth-alignment/formatters", () => {
  it("formats help and document types", () => {
    const helpText = formatHelp(help());
    expect(helpText).toContain("Wealth Alignment commands");
    expect(formatDocumentTypes(documentTypes())).toContain("bank_statement");
  });

  it("formats import output", () => {
    const text = formatImport({
      document: {
        id: "doc-1",
        source_type: "file",
        document_type: "bank_statement",
        uploaded_at: "2026-04-15T00:00:00Z",
        parse_status: "pending",
        source_path: "/tmp/file.txt",
      },
      inferred: true,
      extractionMethod: "raw_text",
      extractionWarnings: ["heads up"],
    });
    expect(text).toContain("Document registered: doc-1");
    expect(text).toContain("(inferred)");
    expect(text).toContain("/tmp/file.txt");
    expect(text).toContain("Extraction:");
    expect(text).toContain("heads up");

    const explicit = formatImport({
      document: {
        id: "doc-2",
        source_type: "file",
        document_type: "invoice",
        uploaded_at: "2026-04-15T00:00:00Z",
        parse_status: "pending",
      },
      inferred: false,
      extractionMethod: "fallback",
      extractionWarnings: [],
    });
    expect(explicit).not.toContain("(inferred)");
    expect(explicit).not.toContain("Source:");
    expect(explicit).toContain("no extractor");
  });

  it("formats document listings", () => {
    expect(formatDocuments({ documents: [] })).toContain("No documents");
    const text = formatDocuments({
      documents: [
        {
          id: "doc-1",
          source_type: "file",
          document_type: "bank_statement",
          uploaded_at: "2026-04-15T00:00:00Z",
          parse_status: "parsed",
          institution: "Example Bank",
          date_range_start: "2026-04-01",
          date_range_end: "2026-04-30",
        },
        {
          id: "doc-2",
          source_type: "file",
          document_type: "invoice",
          uploaded_at: "2026-04-15T00:00:00Z",
          parse_status: "parsed",
        },
      ],
    });
    expect(text).toContain("doc-1");
    expect(text).toContain("Example Bank");
    expect(text).toContain("doc-2");
  });

  it("formats show-document with warnings", () => {
    const text = formatShowDocument({
      document: {
        id: "doc-1",
        source_type: "file",
        document_type: "credit_card_statement",
        uploaded_at: "2026-04-01T00:00:00Z",
        parse_status: "needs_review",
        institution: "Visa",
        date_range_start: "2026-04-01",
        date_range_end: "2026-04-30",
        parse_warnings: ["x"],
      },
      account: {
        id: "a",
        name: "Card ending 1234",
        type: "credit_card",
        currency: "EUR",
        status: "active",
      },
      transactionCount: 0,
      assetCount: 0,
      liabilityCount: 0,
    });
    expect(text).toContain("Visa");
    expect(text).toContain("Card ending 1234");
    expect(text).toContain("Warnings:");
  });

  it("formats parse results with warnings", () => {
    const text = formatParse({
      document: {
        id: "doc-1",
        source_type: "file",
        document_type: "bank_statement",
        uploaded_at: "2026-04-01T00:00:00Z",
        parse_status: "parsed",
        institution: "Bank",
        date_range_start: "2026-04-01",
        date_range_end: "2026-04-30",
      },
      extracted: { transactions: 5, assets: 0, liabilities: 0 },
      warnings: ["sample warning"],
    });
    expect(text).toContain("Document parsed:");
    expect(text).toContain("sample warning");
  });

  it("formats account, asset, liability lists", () => {
    expect(formatAccounts({ accounts: [] })).toContain("No accounts");
    expect(
      formatAccounts({
        accounts: [
          {
            id: "a",
            name: "Checking",
            type: "bank",
            currency: "EUR",
            status: "active",
            current_balance: 100,
            institution: "X",
          },
          {
            id: "b",
            name: "Wallet",
            type: "cash",
            currency: "EUR",
            status: "active",
          },
        ],
      }),
    ).toContain("Checking");
    expect(formatAssets({ assets: [], total: 0, currency: "EUR" })).toContain("No asset");
    expect(
      formatAssets({
        assets: [
          {
            id: "a",
            label: "Savings",
            type: "deposit",
            value: 100,
            currency: "EUR",
            as_of_date: "2026-04-01",
          },
        ],
        total: 100,
        currency: "EUR",
      }),
    ).toContain("Savings");
    expect(formatLiabilities({ liabilities: [], total: 0, currency: "EUR" })).toContain(
      "No liability",
    );
    expect(
      formatLiabilities({
        liabilities: [
          {
            id: "l",
            label: "Loan",
            type: "loan",
            outstanding_balance: 100,
            currency: "EUR",
            as_of_date: "2026-04-01",
          },
        ],
        total: 100,
        currency: "EUR",
      }),
    ).toContain("Loan");
  });

  it("formats transactions with empty and large lists", () => {
    expect(formatTransactions({ transactions: [] })).toContain("No transactions");
    expect(formatTransactions({ transactions: [], yearMonth: "2026-04" })).toContain("2026-04");
    const transactions = Array.from({ length: 30 }, (_, index) => ({
      id: `t${String(index)}`,
      document_id: "d",
      date: "2026-04-01",
      amount: index,
      currency: "EUR",
      direction: "expense" as const,
      category: "x",
      description: `entry ${String(index)}`,
    }));
    const text = formatTransactions({ transactions });
    expect(text).toContain("more.");
    const monthly = formatTransactions({ transactions, yearMonth: "2026-04" });
    expect(monthly).toContain("Transactions for 2026-04");
  });

  it("formats month overview helpers", () => {
    const totals = {
      yearMonth: "2026-04",
      currency: "EUR",
      income: 1000,
      expenses: 500,
      transfers: 0,
      netCashflow: 500,
      transactions: [],
    };
    expect(
      formatIncome({ yearMonth: "2026-04", totals, topCategories: [], documentCount: 0 }),
    ).toContain("Income for 2026-04");
    expect(
      formatExpenses({
        yearMonth: "2026-04",
        totals,
        topCategories: [{ category: "Food", total: 100, count: 1 }],
        documentCount: 1,
      }),
    ).toContain("Food");
    expect(
      formatCashflow({ yearMonth: "2026-04", totals, topCategories: [], documentCount: 2 }),
    ).toContain("Net cashflow");
  });

  it("formats net worth with and without notes", () => {
    expect(
      formatNetWorth({
        summary: {
          currency: "EUR",
          assetTotal: 100,
          liabilityTotal: 50,
          netWorth: 50,
          assets: [],
          liabilities: [],
          hasAssets: true,
          hasLiabilities: true,
        },
      }),
    ).toContain("Estimated net worth");
    expect(
      formatNetWorth({
        summary: {
          currency: "EUR",
          assetTotal: 0,
          liabilityTotal: 0,
          netWorth: 0,
          assets: [],
          liabilities: [],
          hasAssets: false,
          hasLiabilities: false,
        },
        note: "Incomplete.",
      }),
    ).toContain("Incomplete.");
  });

  it("formats what-changed and summary", () => {
    expect(
      formatWhatChanged({
        yearMonth: "2026-04",
        previousMonth: "2026-03",
        current: {
          yearMonth: "2026-04",
          currency: "EUR",
          income: 0,
          expenses: 0,
          transfers: 0,
          netCashflow: 0,
          transactions: [],
        },
        previous: {
          yearMonth: "2026-03",
          currency: "EUR",
          income: 0,
          expenses: 0,
          transfers: 0,
          netCashflow: 0,
          transactions: [],
        },
        incomeDelta: 0,
        expensesDelta: 0,
        netCashflowDelta: 0,
      }),
    ).toContain("Change between");

    expect(
      formatSummary({
        documentCount: 1,
        transactionCount: 5,
        accountCount: 1,
        assetCount: 0,
        liabilityCount: 0,
        parsingPending: 0,
        parsingFailed: 0,
        parsingNeedsReview: 0,
        recentSnapshots: [
          {
            id: "snap-2026-04",
            year_month: "2026-04",
            income_total: 0,
            expense_total: 0,
            transfer_total: 0,
            net_cashflow: 100,
            generated_at: "2026-04-30T00:00:00Z",
            currency: "EUR",
            document_count: 1,
            transaction_count: 1,
          },
        ],
        netWorth: {
          currency: "EUR",
          assetTotal: 0,
          liabilityTotal: 0,
          netWorth: 0,
          assets: [],
          liabilities: [],
          hasAssets: false,
          hasLiabilities: false,
        },
        currentMonth: {
          yearMonth: "2026-04",
          currency: "EUR",
          income: 0,
          expenses: 0,
          transfers: 0,
          netCashflow: 0,
          transactions: [],
        },
      }),
    ).toContain("Recent snapshots");
  });

  it("formats weekly review and monthly digest with all branches", () => {
    expect(
      formatWeeklyReview({
        windowStart: "a",
        windowEnd: "b",
        documentsAdded: [
          {
            id: "d",
            source_type: "file",
            document_type: "bank_statement",
            uploaded_at: "2026-04-01T00:00:00Z",
            parse_status: "parsed",
          },
        ],
        newTransactions: [],
        notableExpenses: [
          {
            id: "t",
            document_id: "d",
            date: "2026-04-01",
            amount: 1000,
            currency: "EUR",
            direction: "expense",
            category: "x",
            description: "y",
          },
        ],
        missingData: ["one"],
        nextStep: "do x",
      }),
    ).toContain("Notable expenses");

    expect(
      formatMonthlyDigest({
        yearMonth: "2026-04",
        totals: {
          yearMonth: "2026-04",
          currency: "EUR",
          income: 1,
          expenses: 1,
          transfers: 0,
          netCashflow: 0,
          transactions: [],
        },
        topCategories: [{ category: "Food", total: 1, count: 1 }],
        recurring: [
          {
            description: "Netflix",
            category: "Subscriptions",
            occurrences: 3,
            averageAmount: 12.99,
            currency: "EUR",
          },
        ],
        netWorth: {
          currency: "EUR",
          assetTotal: 100,
          liabilityTotal: 50,
          netWorth: 50,
          assets: [],
          liabilities: [],
          hasAssets: true,
          hasLiabilities: true,
        },
        nextStep: "do x",
        missingData: ["one"],
      }),
    ).toContain("Recurring expenses");

    const incomplete = formatMonthlyDigest({
      yearMonth: "2026-04",
      totals: {
        yearMonth: "2026-04",
        currency: "EUR",
        income: 0,
        expenses: 0,
        transfers: 0,
        netCashflow: 0,
        transactions: [],
      },
      topCategories: [],
      recurring: [],
      netWorth: {
        currency: "EUR",
        assetTotal: 0,
        liabilityTotal: 0,
        netWorth: 0,
        assets: [],
        liabilities: [],
        hasAssets: false,
        hasLiabilities: false,
      },
      nextStep: "do x",
      missingData: [],
    });
    expect(incomplete).toContain("Net worth: incomplete");
  });

  it("formats recurring, top categories, next step, missing data, parsing issues", () => {
    expect(formatRecurring({ recurring: [] })).toContain("No recurring");
    expect(
      formatRecurring({
        recurring: [
          {
            description: "Netflix",
            category: "Subscriptions",
            occurrences: 3,
            averageAmount: 12.99,
            currency: "EUR",
          },
        ],
      }),
    ).toContain("Netflix");

    expect(
      formatTopCategories({ yearMonth: "2026-04", currency: "EUR", categories: [] }),
    ).toContain("No expense categories");
    expect(
      formatTopCategories({
        yearMonth: "2026-04",
        currency: "EUR",
        categories: [{ category: "Food", total: 100, count: 2 }],
      }),
    ).toContain("Food");

    expect(formatNextStep({ step: "do x", missing: [] })).toContain("Suggested next step");
    expect(formatNextStep({ step: "do x", missing: ["m"] })).toContain("Missing data");

    expect(formatMissingData({ yearMonth: "2026-04", missing: [] })).toContain("No missing data");
    expect(formatMissingData({ yearMonth: "2026-04", missing: ["a", "b"] })).toContain("- a");

    expect(formatParsingIssues({ documents: [] })).toContain("No parsing issues");
    expect(
      formatParsingIssues({
        documents: [
          {
            id: "d",
            source_type: "file",
            document_type: "bank_statement",
            uploaded_at: "2026-04-01T00:00:00Z",
            parse_status: "failed",
            parse_warnings: ["bad"],
          },
        ],
      }),
    ).toContain("bad");
  });
});
