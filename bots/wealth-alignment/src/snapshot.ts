import { DEFAULT_CURRENCY, RECURRING_MIN_OCCURRENCES } from "./constants.js";
import type {
  AssetRecord,
  LiabilityRecord,
  MonthlySnapshot,
  TransactionRecord,
  WealthState,
} from "./types.js";
import { nowIso, round2, sumAmounts, yearMonthOf } from "./util.js";

export interface MonthlyTotals {
  yearMonth: string;
  currency: string;
  income: number;
  expenses: number;
  transfers: number;
  netCashflow: number;
  transactions: TransactionRecord[];
}

export const transactionsForMonth = (
  state: Pick<WealthState, "transactions">,
  yearMonth: string,
): TransactionRecord[] =>
  state.transactions.filter((entry) => yearMonthOf(entry.date) === yearMonth);

const dominantCurrency = (transactions: readonly TransactionRecord[], fallback: string): string => {
  const tally = new Map<string, number>();
  for (const entry of transactions) {
    tally.set(entry.currency, (tally.get(entry.currency) ?? 0) + 1);
  }
  let best: { currency: string; count: number } | undefined;
  for (const [currency, count] of tally) {
    if (best === undefined || count > best.count) {
      best = { currency, count };
    }
  }
  return best?.currency ?? fallback;
};

export const monthlyTotals = (
  state: Pick<WealthState, "transactions">,
  yearMonth: string,
  fallbackCurrency: string = DEFAULT_CURRENCY,
): MonthlyTotals => {
  const transactions = transactionsForMonth(state, yearMonth);
  const currency = dominantCurrency(transactions, fallbackCurrency);
  const income = sumAmounts(
    transactions
      .filter((entry) => entry.direction === "income")
      .map((entry) => Math.abs(entry.amount)),
  );
  const expenses = sumAmounts(
    transactions
      .filter((entry) => entry.direction === "expense")
      .map((entry) => Math.abs(entry.amount)),
  );
  const transfers = sumAmounts(
    transactions
      .filter((entry) => entry.direction === "transfer")
      .map((entry) => Math.abs(entry.amount)),
  );
  return {
    yearMonth,
    currency,
    income,
    expenses,
    transfers,
    netCashflow: round2(income - expenses),
    transactions,
  };
};

export interface NetWorthSummary {
  currency: string;
  assetTotal: number;
  liabilityTotal: number;
  netWorth: number;
  assets: AssetRecord[];
  liabilities: LiabilityRecord[];
  hasAssets: boolean;
  hasLiabilities: boolean;
}

export const netWorthSummary = (
  state: Pick<WealthState, "assets" | "liabilities">,
  fallbackCurrency: string = DEFAULT_CURRENCY,
): NetWorthSummary => {
  const currency = state.assets[0]?.currency ?? state.liabilities[0]?.currency ?? fallbackCurrency;
  const assetTotal = sumAmounts(state.assets.map((entry) => entry.value));
  const liabilityTotal = sumAmounts(state.liabilities.map((entry) => entry.outstanding_balance));
  return {
    currency,
    assetTotal,
    liabilityTotal,
    netWorth: round2(assetTotal - liabilityTotal),
    assets: state.assets,
    liabilities: state.liabilities,
    hasAssets: state.assets.length > 0,
    hasLiabilities: state.liabilities.length > 0,
  };
};

export interface CategoryTotal {
  category: string;
  total: number;
  count: number;
}

export const topExpenseCategories = (totals: MonthlyTotals, limit: number = 5): CategoryTotal[] => {
  const tally = new Map<string, { total: number; count: number }>();
  for (const entry of totals.transactions) {
    if (entry.direction !== "expense") {
      continue;
    }
    const current = tally.get(entry.category) ?? { total: 0, count: 0 };
    current.total = round2(current.total + Math.abs(entry.amount));
    current.count += 1;
    tally.set(entry.category, current);
  }
  return [...tally.entries()]
    .map(([category, value]) => ({ category, total: value.total, count: value.count }))
    .sort((left, right) => right.total - left.total)
    .slice(0, limit);
};

export interface RecurringExpense {
  description: string;
  category: string;
  occurrences: number;
  averageAmount: number;
  currency: string;
}

const normalizeDescription = (description: string): string =>
  description
    .toLowerCase()
    .replace(/\b\d{2,}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

export const recurringExpenses = (
  state: Pick<WealthState, "transactions">,
  minOccurrences: number = RECURRING_MIN_OCCURRENCES,
): RecurringExpense[] => {
  const groups = new Map<
    string,
    {
      description: string;
      category: string;
      currency: string;
      amounts: number[];
      months: Set<string>;
    }
  >();
  for (const entry of state.transactions) {
    if (entry.direction !== "expense") {
      continue;
    }
    const key = normalizeDescription(entry.description);
    if (key.length < 3) {
      continue;
    }
    const existing = groups.get(key);
    const month = yearMonthOf(entry.date) ?? entry.date.slice(0, 7);
    if (existing === undefined) {
      groups.set(key, {
        description: entry.description,
        category: entry.category,
        currency: entry.currency,
        amounts: [Math.abs(entry.amount)],
        months: new Set<string>([month]),
      });
    } else {
      existing.amounts.push(Math.abs(entry.amount));
      existing.months.add(month);
    }
  }
  const out: RecurringExpense[] = [];
  for (const value of groups.values()) {
    if (value.months.size < minOccurrences) {
      continue;
    }
    out.push({
      description: value.description,
      category: value.category,
      currency: value.currency,
      occurrences: value.amounts.length,
      averageAmount: round2(
        value.amounts.reduce((sum, amount) => sum + amount, 0) / value.amounts.length,
      ),
    });
  }
  return out.sort((left, right) => right.averageAmount - left.averageAmount);
};

export const annotateRecurringFlags = (state: WealthState): void => {
  const recurring = new Set(
    recurringExpenses(state).map((entry) => normalizeDescription(entry.description)),
  );
  for (const transaction of state.transactions) {
    if (transaction.direction !== "expense") {
      continue;
    }
    const key = normalizeDescription(transaction.description);
    transaction.recurring_flag = recurring.has(key);
  }
};

export const generateMonthlySnapshot = (
  state: WealthState,
  yearMonth: string,
  fallbackCurrency: string = DEFAULT_CURRENCY,
): MonthlySnapshot => {
  const totals = monthlyTotals(state, yearMonth, fallbackCurrency);
  const netWorth = netWorthSummary(state, totals.currency);
  const documentsForMonth = state.documents.filter((document) => {
    const upload = yearMonthOf(document.uploaded_at);
    const start = document.date_range_start;
    const end = document.date_range_end;
    if (start !== undefined && end !== undefined) {
      const startMonth = yearMonthOf(start);
      const endMonth = yearMonthOf(end);
      if (startMonth !== undefined && endMonth !== undefined) {
        return yearMonth >= startMonth && yearMonth <= endMonth;
      }
    }
    return upload === yearMonth;
  });
  const id = `snap-${yearMonth}`;
  return {
    id,
    year_month: yearMonth,
    income_total: totals.income,
    expense_total: totals.expenses,
    transfer_total: totals.transfers,
    net_cashflow: totals.netCashflow,
    asset_total: netWorth.hasAssets ? netWorth.assetTotal : undefined,
    liability_total: netWorth.hasLiabilities ? netWorth.liabilityTotal : undefined,
    net_worth: netWorth.hasAssets || netWorth.hasLiabilities ? netWorth.netWorth : undefined,
    generated_at: nowIso(),
    currency: totals.currency,
    document_count: documentsForMonth.length,
    transaction_count: totals.transactions.length,
  };
};

export const upsertSnapshot = (state: WealthState, snapshot: MonthlySnapshot): void => {
  const index = state.snapshots.findIndex((entry) => entry.year_month === snapshot.year_month);
  if (index >= 0) {
    state.snapshots[index] = snapshot;
  } else {
    state.snapshots.push(snapshot);
    state.snapshots.sort((left, right) => left.year_month.localeCompare(right.year_month));
  }
};
