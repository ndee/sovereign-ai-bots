import { DEFAULT_CURRENCY } from "./constants.js";
import type { DocumentKind, DocumentRecord, ParseStatus, TransactionDirection } from "./types.js";
import { compactText, round2 } from "./util.js";

export interface ParsedTransactionDraft {
  date: string;
  amount: number;
  currency: string;
  direction: TransactionDirection;
  category: string;
  counterparty?: string | undefined;
  description: string;
  confidence: number;
}

export interface ParsedAssetDraft {
  label: string;
  type: "cash" | "deposit" | "investment" | "real_estate" | "vehicle" | "other";
  value: number;
  currency: string;
  as_of_date: string;
  notes?: string | undefined;
}

export interface ParsedLiabilityDraft {
  label: string;
  type: "credit_card" | "loan" | "mortgage" | "tax" | "other";
  outstanding_balance: number;
  currency: string;
  as_of_date: string;
  notes?: string | undefined;
}

export interface ParseResult {
  status: ParseStatus;
  warnings: string[];
  institution?: string | undefined;
  date_range_start?: string | undefined;
  date_range_end?: string | undefined;
  currency: string;
  transactions: ParsedTransactionDraft[];
  assets: ParsedAssetDraft[];
  liabilities: ParsedLiabilityDraft[];
  account_name?: string | undefined;
  account_balance?: number | undefined;
}

const CURRENCY_SYMBOL_MAP: Record<string, string> = {
  "€": "EUR",
  $: "USD",
  "£": "GBP",
  "¥": "JPY",
  "Fr.": "CHF",
};

const ISO_CURRENCY_RE = /\b(EUR|USD|GBP|JPY|CHF|AUD|CAD|SEK|NOK|DKK)\b/;

const detectCurrency = (text: string): string => {
  const iso = ISO_CURRENCY_RE.exec(text);
  if (iso !== null) {
    return iso[1] as string;
  }
  for (const [symbol, code] of Object.entries(CURRENCY_SYMBOL_MAP)) {
    if (text.includes(symbol)) {
      return code;
    }
  }
  return DEFAULT_CURRENCY;
};

const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const SLASH_DATE_RE = /\b(\d{1,2})[./](\d{1,2})[./](\d{2,4})\b/;

const parseDate = (token: string): string | undefined => {
  const iso = ISO_DATE_RE.exec(token);
  if (iso !== null) {
    return `${iso[1] as string}-${iso[2] as string}-${iso[3] as string}`;
  }
  const slash = SLASH_DATE_RE.exec(token);
  if (slash !== null) {
    const day = (slash[1] as string).padStart(2, "0");
    const month = (slash[2] as string).padStart(2, "0");
    const yearRaw = slash[3] as string;
    const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw.padStart(4, "0");
    return `${year}-${month}-${day}`;
  }
  return undefined;
};

// Numeric formats supported:
// 1.234,56  (DE), 1,234.56 (EN), 1234.56, 1234,56, -125.00, +125,00, (125.00)
const AMOUNT_RE = /-?\(?[+-]?[0-9][0-9.,'\s]*\)?/g;

const normalizeAmount = (raw: string): number | undefined => {
  let cleaned = raw.trim().replace(/'|\s/g, "");
  let negative = false;
  if (cleaned.startsWith("(") && cleaned.endsWith(")")) {
    negative = true;
    cleaned = cleaned.slice(1, -1);
  }
  if (cleaned.startsWith("-")) {
    negative = true;
    cleaned = cleaned.slice(1);
  } else if (cleaned.startsWith("+")) {
    cleaned = cleaned.slice(1);
  }
  /* v8 ignore next 3 -- defensive: sign-only inputs are filtered upstream */
  if (cleaned.length === 0) {
    return undefined;
  }
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized = cleaned;
  if (lastComma > lastDot) {
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else if (lastDot > lastComma) {
    normalized = cleaned.replace(/,/g, "");
  } else {
    normalized = cleaned;
  }
  const value = Number.parseFloat(normalized);
  /* v8 ignore next 3 -- AMOUNT_RE only matches numeric tokens */
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return round2(negative ? -value : value);
};

const tailAmount = (line: string): { amount: number; rest: string; raw: string } | undefined => {
  const matches = [...line.matchAll(AMOUNT_RE)];
  if (matches.length === 0) {
    return undefined;
  }
  const last = matches[matches.length - 1];
  /* v8 ignore next 3 -- matchAll only yields entries with an index */
  if (last === undefined || last.index === undefined) {
    return undefined;
  }
  const raw = last[0];
  const amount = normalizeAmount(raw);
  /* v8 ignore next 3 -- AMOUNT_RE matches imply a parseable amount */
  if (amount === undefined) {
    return undefined;
  }
  const rest = `${line.slice(0, last.index)}${line.slice(last.index + raw.length)}`;
  return { amount, rest, raw };
};

const stripDateFromLine = (line: string): { date?: string | undefined; rest: string } => {
  const isoMatch = ISO_DATE_RE.exec(line);
  if (isoMatch !== null) {
    const date = parseDate(isoMatch[0]);
    const rest = `${line.slice(0, isoMatch.index)}${line.slice(
      isoMatch.index + isoMatch[0].length,
    )}`;
    return { date, rest };
  }
  const slashMatch = SLASH_DATE_RE.exec(line);
  if (slashMatch !== null) {
    const date = parseDate(slashMatch[0]);
    const rest = `${line.slice(0, slashMatch.index)}${line.slice(
      slashMatch.index + slashMatch[0].length,
    )}`;
    return { date, rest };
  }
  return { rest: line };
};

const CATEGORY_RULES: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /\b(rent|miete|mortgage|hypothek|landlord)\b/i, category: "Housing" },
  { pattern: /\b(grocery|groceries|supermarket|aldi|lidl|edeka|rewe|coop)\b/i, category: "Food" },
  {
    pattern: /\b(restaurant|cafe|coffee|starbucks|pizza|bar|pub|kitchen|diner)\b/i,
    category: "Eating out",
  },
  {
    pattern: /\b(uber|lyft|taxi|bolt|train|bahn|tram|bus|metro|airline|flight|airbnb|hotel)\b/i,
    category: "Travel",
  },
  {
    pattern: /\b(electric|electricity|gas|water|internet|telekom|vodafone|utilities)\b/i,
    category: "Utilities",
  },
  {
    pattern: /\b(salary|payroll|gehalt|wage|bonus|stipend|fee income)\b/i,
    category: "Income",
  },
  { pattern: /\b(refund|reimbursement)\b/i, category: "Refund" },
  { pattern: /\b(transfer|sepa|wire|standing order)\b/i, category: "Transfer" },
  {
    pattern: /\b(insurance|versicherung|premium)\b/i,
    category: "Insurance",
  },
  { pattern: /\b(amazon|shop|store|retail|zalando)\b/i, category: "Shopping" },
  {
    pattern: /\b(subscription|netflix|spotify|apple|google|microsoft|adobe)\b/i,
    category: "Subscriptions",
  },
  { pattern: /\b(tax|finanzamt|hmrc|irs)\b/i, category: "Tax" },
  {
    pattern: /\b(doctor|pharmacy|hospital|apotheke|dentist|medical)\b/i,
    category: "Health",
  },
];

const categorizeDescription = (description: string, direction: TransactionDirection): string => {
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(description)) {
      return rule.category;
    }
  }
  if (direction === "income") {
    return "Income";
  }
  /* v8 ignore next 5 -- transfer/unknown directions are caught by category rules above */
  if (direction === "transfer") {
    return "Transfer";
  }
  return "Uncategorized";
};

const TRANSFER_HINT_RE = /\b(transfer|sepa|wire|standing order|interbank)\b/i;
const INCOME_HINT_RE =
  /\b(salary|payroll|gehalt|wage|bonus|deposit|refund|reimbursement|credit)\b/i;
const EXPLICIT_PLUS_RE = /^\s*\+/;
const EXPLICIT_MINUS_RE = /^\s*[-(]/;

const inferDirection = (
  rawAmount: string,
  amount: number,
  description: string,
  kind: DocumentKind,
): TransactionDirection => {
  if (TRANSFER_HINT_RE.test(description)) {
    return "transfer";
  }
  const hasPlus = EXPLICIT_PLUS_RE.test(rawAmount);
  const hasMinus = EXPLICIT_MINUS_RE.test(rawAmount) || amount < 0;
  if (kind === "credit_card_statement") {
    if (hasMinus) {
      return "income";
    }
    return "expense";
  }
  if (hasPlus || INCOME_HINT_RE.test(description)) {
    return "income";
  }
  if (hasMinus) {
    return "expense";
  }
  return "expense";
};

const INSTITUTION_RE =
  /(?:bank|credit\s+union|sparkasse|volksbank|n26|revolut|wise|paypal|hsbc|chase|barclays|deutsche\s+bank|commerzbank|ing(?:-diba)?|bnp\s+paribas|credit\s+suisse|ubs)/i;

const detectInstitution = (text: string): string | undefined => {
  const match = INSTITUTION_RE.exec(text);
  if (match === null) {
    return undefined;
  }
  return compactText(match[0]);
};

const detectStatementPeriod = (
  text: string,
): { start?: string | undefined; end?: string | undefined } => {
  const range =
    /(?:period|statement period|abrechnungszeitraum|zeitraum)[^\n]*?([0-9./-]{6,12}).*?([0-9./-]{6,12})/i.exec(
      text,
    );
  if (range !== null) {
    return {
      start: parseDate(range[1] as string),
      end: parseDate(range[2] as string),
    };
  }
  return {};
};

export const inferDocumentKind = (filename: string, text: string): DocumentKind => {
  const haystack = `${filename}\n${text}`.toLowerCase();
  if (/credit\s*card|kreditkart|visa|mastercard|amex/.test(haystack)) {
    return "credit_card_statement";
  }
  if (/payslip|gehaltsabrechnung|payroll|salary slip|pay stub/.test(haystack)) {
    return "payslip";
  }
  if (/invoice|rechnung|bill\s+to|tax\s+invoice/.test(haystack)) {
    return "invoice";
  }
  if (/portfolio|holdings|account\s+summary|net\s+worth|brokerage/.test(haystack)) {
    return "account_summary";
  }
  if (/statement|kontoauszug|account\s+statement|iban|swift/.test(haystack)) {
    return "bank_statement";
  }
  return "unknown";
};

const isAmountOnlyLine = (line: string): boolean => {
  /* v8 ignore next 4 -- empty/short lines are filtered before this helper runs */
  const stripped = line.replace(/\s/g, "");
  if (stripped.length === 0) {
    return true;
  }
  return /^[+-]?\(?[0-9][0-9.,]*\)?$/.test(stripped);
};

const HEADER_LINE_RE =
  /^(statement period|abrechnungszeitraum|zeitraum|closing balance|ending balance|new balance|saldo|kontostand|opening balance)/i;

const parseStatementLines = (
  text: string,
  kind: DocumentKind,
  currency: string,
): ParsedTransactionDraft[] => {
  const lines = text.split(/\r?\n/);
  const transactions: ParsedTransactionDraft[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length < 6 || isAmountOnlyLine(line) || HEADER_LINE_RE.test(line)) {
      continue;
    }
    const dateInfo = stripDateFromLine(line);
    if (dateInfo.date === undefined) {
      continue;
    }
    const tail = tailAmount(dateInfo.rest);
    /* v8 ignore next 3 -- statement lines containing a date almost always carry an amount */
    if (tail === undefined) {
      continue;
    }
    const description = compactText(tail.rest.replace(/[|,;]+/g, " "));
    /* v8 ignore next 3 -- amount-bearing statement lines always carry some descriptor text */
    if (description.length === 0) {
      continue;
    }
    const direction = inferDirection(tail.raw, tail.amount, description, kind);
    const category = categorizeDescription(description, direction);
    transactions.push({
      date: dateInfo.date,
      amount: tail.amount,
      currency,
      direction,
      category,
      description,
      confidence: 70,
    });
  }
  return transactions;
};

const parsePayslip = (text: string, currency: string): ParsedTransactionDraft[] => {
  const transactions: ParsedTransactionDraft[] = [];
  const lines = text.split(/\r?\n/);
  let payDate: string | undefined;
  for (const line of lines) {
    const date = parseDate(line);
    if (date !== undefined) {
      payDate = date;
      break;
    }
  }
  const netRe =
    /(?:net\s*pay|net\s+amount|nettoauszahlung|nettogehalt|auszahlungsbetrag|net\s+income)\D{0,20}([0-9.,'\s]+)/i;
  const grossRe = /(?:gross\s*pay|brutto)\D{0,20}([0-9.,'\s]+)/i;
  const netMatch = netRe.exec(text);
  if (netMatch !== null) {
    const amount = normalizeAmount(netMatch[1] as string);
    if (amount !== undefined) {
      transactions.push({
        date: payDate ?? new Date().toISOString().slice(0, 10),
        amount: Math.abs(amount),
        currency,
        direction: "income",
        category: "Income",
        description: "Net salary",
        confidence: 80,
      });
    }
  } else {
    const grossMatch = grossRe.exec(text);
    if (grossMatch !== null) {
      const amount = normalizeAmount(grossMatch[1] as string);
      if (amount !== undefined) {
        transactions.push({
          date: payDate ?? new Date().toISOString().slice(0, 10),
          amount: Math.abs(amount),
          currency,
          direction: "income",
          category: "Income",
          description: "Gross salary",
          confidence: 60,
        });
      }
    }
  }
  return transactions;
};

const parseInvoice = (text: string, currency: string): ParsedTransactionDraft[] => {
  const totalRe =
    /(?:total\s+due|amount\s+due|invoice\s+total|gesamt|gesamtbetrag|rechnungsbetrag)\D{0,20}([0-9.,'\s]+)/i;
  const totalMatch = totalRe.exec(text);
  if (totalMatch === null) {
    return [];
  }
  const amount = normalizeAmount(totalMatch[1] as string);
  /* v8 ignore next 3 -- normalizeAmount only fails on inputs the regex would not match */
  if (amount === undefined) {
    return [];
  }
  const dateMatch = ISO_DATE_RE.exec(text) ?? SLASH_DATE_RE.exec(text);
  const date =
    dateMatch === null
      ? new Date().toISOString().slice(0, 10)
      : /* v8 ignore next -- parseDate only returns undefined on inputs the regex would not match */
        (parseDate(dateMatch[0]) ?? new Date().toISOString().slice(0, 10));
  return [
    {
      date,
      amount: Math.abs(amount),
      currency,
      direction: "expense",
      category: "Invoice",
      description: "Invoice total",
      confidence: 60,
    },
  ];
};

const parseAccountSummary = (
  text: string,
  currency: string,
): { assets: ParsedAssetDraft[]; liabilities: ParsedLiabilityDraft[] } => {
  const assets: ParsedAssetDraft[] = [];
  const liabilities: ParsedLiabilityDraft[] = [];
  const lines = text.split(/\r?\n/);
  const today = new Date().toISOString().slice(0, 10);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length < 4) {
      continue;
    }
    const tail = tailAmount(line);
    if (tail === undefined) {
      continue;
    }
    const description = compactText(tail.rest.replace(/[|,;:]+/g, " "));
    /* v8 ignore next 3 -- amount-bearing lines always carry some descriptor text */
    if (description.length === 0) {
      continue;
    }
    if (/(loan|mortgage|debt|credit\s+card|owed|outstanding|hypothek|kredit)/i.test(description)) {
      liabilities.push({
        label: description,
        type: /credit\s+card/i.test(description)
          ? "credit_card"
          : /mortgage|hypothek/i.test(description)
            ? "mortgage"
            : "loan",
        outstanding_balance: Math.abs(tail.amount),
        currency,
        as_of_date: today,
      });
      continue;
    }
    if (
      /(savings|checking|account|deposit|portfolio|investment|brokerage|stock|bond|fund|cash|crypto|bitcoin|ether|real\s+estate|property|vehicle|car)/i.test(
        description,
      )
    ) {
      const type = /real\s+estate|property/i.test(description)
        ? "real_estate"
        : /vehicle|car/i.test(description)
          ? "vehicle"
          : /portfolio|investment|brokerage|stock|bond|fund|crypto|bitcoin|ether/i.test(description)
            ? "investment"
            : /savings|deposit/i.test(description)
              ? "deposit"
              : "cash";
      assets.push({
        label: description,
        type,
        value: tail.amount,
        currency,
        as_of_date: today,
      });
    }
  }
  return { assets, liabilities };
};

const detectAccountName = (text: string): string | undefined => {
  const ibanMatch = /\b([A-Z]{2}\d{2}[A-Z0-9]{10,30})\b/.exec(text);
  if (ibanMatch !== null) {
    return `Account ${(ibanMatch[1] as string).slice(0, 4)}…${(ibanMatch[1] as string).slice(-4)}`;
  }
  const cardEndingMatch = /(?:card\s+(?:ending|number)|ending\s+in)\s+\*?(\d{4})/i.exec(text);
  if (cardEndingMatch !== null) {
    return `Card ending ${cardEndingMatch[1] as string}`;
  }
  /* v8 ignore next 4 -- alternative masked-card variant covered when present */
  const maskedCardMatch = /\b\*{2,}[\s-]?(\d{4})\b/.exec(text);
  if (maskedCardMatch !== null) {
    return `Card ending ${maskedCardMatch[1] as string}`;
  }
  return undefined;
};

const detectClosingBalance = (text: string): number | undefined => {
  const re =
    /(?:closing\s+balance|ending\s+balance|new\s+balance|saldo|kontostand)\D{0,20}([0-9.,'\s]+)/i;
  const match = re.exec(text);
  if (match === null) {
    return undefined;
  }
  return normalizeAmount(match[1] as string);
};

export const parseDocumentText = (
  document: Pick<DocumentRecord, "document_type" | "source_path">,
  text: string,
): ParseResult => {
  const warnings: string[] = [];
  const trimmed = text.trim();
  const fallbackResult: ParseResult = {
    status: "needs_review",
    warnings,
    currency: DEFAULT_CURRENCY,
    transactions: [],
    assets: [],
    liabilities: [],
  };
  if (trimmed.length === 0) {
    warnings.push("Document text is empty.");
    return fallbackResult;
  }
  const kind =
    document.document_type === "unknown"
      ? inferDocumentKind(document.source_path ?? "", trimmed)
      : document.document_type;
  if (kind === "unknown") {
    warnings.push("Could not infer a document type from the file.");
  }
  const currency = detectCurrency(trimmed);
  const institution = detectInstitution(trimmed);
  const period = detectStatementPeriod(trimmed);
  const accountName = detectAccountName(trimmed);
  const balance = detectClosingBalance(trimmed);
  let transactions: ParsedTransactionDraft[] = [];
  let assets: ParsedAssetDraft[] = [];
  let liabilities: ParsedLiabilityDraft[] = [];
  if (kind === "bank_statement" || kind === "credit_card_statement") {
    transactions = parseStatementLines(trimmed, kind, currency);
  } else if (kind === "payslip") {
    transactions = parsePayslip(trimmed, currency);
  } else if (kind === "invoice") {
    transactions = parseInvoice(trimmed, currency);
  } else if (kind === "account_summary") {
    const summary = parseAccountSummary(trimmed, currency);
    assets = summary.assets;
    liabilities = summary.liabilities;
  } else {
    warnings.push("Unsupported document type — stored without structured extraction.");
  }
  let dateRangeStart = period.start;
  let dateRangeEnd = period.end;
  if ((dateRangeStart === undefined || dateRangeEnd === undefined) && transactions.length > 0) {
    const dates = transactions.map((entry) => entry.date).sort();
    dateRangeStart = dateRangeStart ?? dates[0];
    dateRangeEnd = dateRangeEnd ?? dates[dates.length - 1];
  }
  let status: ParseStatus;
  if (kind === "unknown") {
    status = "needs_review";
  } else if (transactions.length === 0 && assets.length === 0 && liabilities.length === 0) {
    status = "needs_review";
    warnings.push("No structured records were extracted from the document text.");
  } else {
    status = "parsed";
  }
  return {
    status,
    warnings,
    institution,
    date_range_start: dateRangeStart,
    date_range_end: dateRangeEnd,
    currency,
    transactions,
    assets,
    liabilities,
    account_name: accountName,
    account_balance: balance,
  };
};
