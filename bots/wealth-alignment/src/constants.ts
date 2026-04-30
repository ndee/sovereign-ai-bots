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

export const MAX_RAW_TEXT_BYTES = 1024 * 1024;

export const RECURRING_MIN_OCCURRENCES = 2;

export const SUPPORTED_FILE_EXTENSIONS = [
  ".txt",
  ".csv",
  ".tsv",
  ".md",
  ".log",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
];

export const DEFAULT_VISION_MODEL = "qwen/qwen2-vl-72b-instruct";
export const DEFAULT_VISION_MAX_PAGES = 4;
export const DEFAULT_PDF_EXTRACTOR = "pdftotext";
export const DEFAULT_IMAGE_EXTRACTOR = "tesseract";
export const DEFAULT_PDF_RENDERER = "pdftoppm";
export const OPENROUTER_REFERER = "https://github.com/ndee/sovereign-ai-bots";
export const OPENROUTER_TITLE = "Wealth Alignment vision extraction";
