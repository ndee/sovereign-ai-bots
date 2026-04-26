import type { DocumentKind } from "./types.js";

export const DEFAULT_CURRENCY = "EUR";

export const SUPPORTED_DOCUMENT_KINDS: DocumentKind[] = [
  "bank_statement",
  "credit_card_statement",
  "invoice",
  "payslip",
  "account_summary",
];

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  bank_statement: "bank statement",
  credit_card_statement: "credit card statement",
  invoice: "invoice",
  payslip: "payslip / income record",
  account_summary: "account / asset summary",
  unknown: "unknown",
};

export const MAX_RAW_TEXT_BYTES = 256 * 1024;

export const RECURRING_MIN_OCCURRENCES = 2;
