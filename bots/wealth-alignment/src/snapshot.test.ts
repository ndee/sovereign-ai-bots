import { describe, expect, it } from "vitest";
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
import { createDefaultState } from "./state.js";
import type { TransactionRecord, WealthState } from "./types.js";

const txn = (overrides: Partial<TransactionRecord>): TransactionRecord => ({
  id: overrides.id ?? "txn-1",
  document_id: overrides.document_id ?? "doc-1",
  date: overrides.date ?? "2026-04-05",
  amount: overrides.amount ?? 100,
  currency: overrides.currency ?? "EUR",
  direction: overrides.direction ?? "expense",
  category: overrides.category ?? "Uncategorized",
  description: overrides.description ?? "test",
  ...overrides,
});

const buildState = (transactions: TransactionRecord[]): WealthState => {
  const state = createDefaultState();
  state.transactions = transactions;
  return state;
};

describe("wealth-alignment/snapshot", () => {
  it("computes monthly totals", () => {
    const state = buildState([
      txn({ id: "a", direction: "income", amount: 3000, date: "2026-04-01" }),
      txn({ id: "b", direction: "expense", amount: 1000, date: "2026-04-05" }),
      txn({ id: "c", direction: "transfer", amount: 200, date: "2026-04-10" }),
      txn({ id: "d", direction: "expense", amount: 500, date: "2026-03-15" }),
    ]);
    const totals = monthlyTotals(state, "2026-04");
    expect(totals.income).toBe(3000);
    expect(totals.expenses).toBe(1000);
    expect(totals.transfers).toBe(200);
    expect(totals.netCashflow).toBe(2000);
    expect(totals.currency).toBe("EUR");
  });

  it("falls back to the configured default currency when no transactions", () => {
    const state = buildState([]);
    const totals = monthlyTotals(state, "2026-04", "USD");
    expect(totals.currency).toBe("USD");
  });

  it("computes net worth summary", () => {
    const state = createDefaultState();
    state.assets.push({
      id: "a1",
      label: "Savings",
      type: "deposit",
      value: 10000,
      currency: "EUR",
      as_of_date: "2026-04-01",
    });
    state.liabilities.push({
      id: "l1",
      label: "Loan",
      type: "loan",
      outstanding_balance: 4000,
      currency: "EUR",
      as_of_date: "2026-04-01",
    });
    const result = netWorthSummary(state);
    expect(result.assetTotal).toBe(10000);
    expect(result.liabilityTotal).toBe(4000);
    expect(result.netWorth).toBe(6000);
    expect(result.hasAssets).toBe(true);
    expect(result.hasLiabilities).toBe(true);
  });

  it("falls back to default currency when no assets/liabilities", () => {
    const result = netWorthSummary(createDefaultState(), "USD");
    expect(result.currency).toBe("USD");
    expect(result.netWorth).toBe(0);
  });

  it("ranks top expense categories", () => {
    const state = buildState([
      txn({ id: "a", category: "Food", amount: 100, direction: "expense" }),
      txn({ id: "b", category: "Food", amount: 50, direction: "expense" }),
      txn({ id: "c", category: "Housing", amount: 800, direction: "expense" }),
      txn({ id: "d", category: "Income", amount: 2000, direction: "income" }),
    ]);
    const totals = monthlyTotals(state, "2026-04");
    const ranking = topExpenseCategories(totals);
    expect(ranking[0]?.category).toBe("Housing");
    expect(ranking[1]?.category).toBe("Food");
    expect(ranking[1]?.total).toBe(150);
  });

  it("detects recurring expenses across months", () => {
    const state = buildState([
      txn({ id: "a", description: "Netflix subscription", date: "2026-02-01", amount: 12.99 }),
      txn({ id: "b", description: "Netflix subscription", date: "2026-03-01", amount: 12.99 }),
      txn({ id: "c", description: "Netflix subscription", date: "2026-04-01", amount: 12.99 }),
      txn({ id: "d", description: "One-off purchase", date: "2026-04-02", amount: 99 }),
    ]);
    const recurring = recurringExpenses(state);
    expect(recurring.length).toBe(1);
    expect(recurring[0]?.occurrences).toBe(3);
    annotateRecurringFlags(state);
    expect(state.transactions[0]?.recurring_flag).toBe(true);
    expect(state.transactions[3]?.recurring_flag).toBe(false);
  });

  it("ignores transactions with very short descriptions when finding recurring", () => {
    const state = buildState([
      txn({ id: "a", description: "x", date: "2026-02-01", amount: 5 }),
      txn({ id: "b", description: "x", date: "2026-03-01", amount: 5 }),
    ]);
    expect(recurringExpenses(state)).toEqual([]);
  });

  it("filters transactions by month", () => {
    const state = buildState([
      txn({ id: "a", date: "2026-04-01" }),
      txn({ id: "b", date: "2026-03-01" }),
    ]);
    expect(transactionsForMonth(state, "2026-04")).toHaveLength(1);
  });

  it("upserts and replaces snapshots", () => {
    const state = createDefaultState();
    const snapshot = generateMonthlySnapshot(state, "2026-04");
    upsertSnapshot(state, snapshot);
    expect(state.snapshots).toHaveLength(1);
    upsertSnapshot(state, { ...snapshot, income_total: 100 });
    expect(state.snapshots[0]?.income_total).toBe(100);
    upsertSnapshot(state, generateMonthlySnapshot(state, "2026-03"));
    expect(state.snapshots.map((entry) => entry.year_month)).toEqual(["2026-03", "2026-04"]);
  });

  it("counts documents by date range and falls back to upload date", () => {
    const state = createDefaultState();
    state.documents.push({
      id: "d1",
      source_type: "file",
      document_type: "bank_statement",
      uploaded_at: "2026-05-01T00:00:00Z",
      date_range_start: "2026-04-01",
      date_range_end: "2026-04-30",
      parse_status: "parsed",
    });
    state.documents.push({
      id: "d2",
      source_type: "file",
      document_type: "bank_statement",
      uploaded_at: "2026-04-15T00:00:00Z",
      parse_status: "parsed",
    });
    const snapshot = generateMonthlySnapshot(state, "2026-04");
    expect(snapshot.document_count).toBe(2);
  });

  it("includes net worth fields only when data is present", () => {
    const state = createDefaultState();
    const snapshot = generateMonthlySnapshot(state, "2026-04");
    expect(snapshot.net_worth).toBeUndefined();
    expect(snapshot.asset_total).toBeUndefined();
    expect(snapshot.liability_total).toBeUndefined();
    state.assets.push({
      id: "a",
      label: "x",
      type: "cash",
      value: 100,
      currency: "EUR",
      as_of_date: "2026-04-01",
    });
    const withAsset = generateMonthlySnapshot(state, "2026-04");
    expect(withAsset.net_worth).toBe(100);
    expect(withAsset.asset_total).toBe(100);
    expect(withAsset.liability_total).toBeUndefined();
    state.liabilities.push({
      id: "l",
      label: "y",
      type: "loan",
      outstanding_balance: 50,
      currency: "EUR",
      as_of_date: "2026-04-01",
    });
    const both = generateMonthlySnapshot(state, "2026-04");
    expect(both.liability_total).toBe(50);
    expect(both.net_worth).toBe(50);
  });

  it("picks the dominant currency when transactions mix denominations", () => {
    const state = buildState([
      txn({ id: "a", currency: "USD", date: "2026-04-01" }),
      txn({ id: "b", currency: "USD", date: "2026-04-02" }),
      txn({ id: "c", currency: "EUR", date: "2026-04-03" }),
    ]);
    expect(monthlyTotals(state, "2026-04").currency).toBe("USD");
  });

  it("derives net-worth currency from liabilities when no assets exist", () => {
    const state = createDefaultState();
    state.liabilities.push({
      id: "l",
      label: "y",
      type: "loan",
      outstanding_balance: 100,
      currency: "USD",
      as_of_date: "2026-04-01",
    });
    expect(netWorthSummary(state).currency).toBe("USD");
  });

  it("uses date prefix when yearMonthOf cannot parse the transaction date", () => {
    const state = buildState([
      txn({ id: "a", description: "weird date entry", date: "bogus", amount: 5 }),
      txn({ id: "b", description: "weird date entry", date: "alsofake", amount: 5 }),
    ]);
    const result = recurringExpenses(state, 1);
    expect(result.length).toBeGreaterThan(0);
  });
});
