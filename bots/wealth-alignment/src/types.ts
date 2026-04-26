export type DocumentKind =
  | "bank_statement"
  | "credit_card_statement"
  | "invoice"
  | "payslip"
  | "account_summary"
  | "unknown";

export type ParseStatus = "pending" | "parsed" | "failed" | "needs_review";

export type AccountType = "bank" | "credit_card" | "brokerage" | "cash" | "liability" | "unknown";

export type AccountStatus = "active" | "closed" | "unknown";

export type TransactionDirection = "income" | "expense" | "transfer" | "unknown";

export type AssetType = "cash" | "deposit" | "investment" | "real_estate" | "vehicle" | "other";

export type LiabilityType = "credit_card" | "loan" | "mortgage" | "tax" | "other";

export interface DocumentRecord {
  id: string;
  source_type: string;
  document_type: DocumentKind;
  uploaded_at: string;
  institution?: string | undefined;
  date_range_start?: string | undefined;
  date_range_end?: string | undefined;
  raw_text?: string | undefined;
  extracted_text?: string | undefined;
  parse_status: ParseStatus;
  notes?: string | undefined;
  source_path?: string | undefined;
  parse_warnings?: string[] | undefined;
}

export interface AccountRecord {
  id: string;
  name: string;
  institution?: string | undefined;
  type: AccountType;
  currency: string;
  current_balance?: number | undefined;
  last_statement_date?: string | undefined;
  status: AccountStatus;
}

export interface TransactionRecord {
  id: string;
  document_id: string;
  account_id?: string | undefined;
  date: string;
  amount: number;
  currency: string;
  direction: TransactionDirection;
  category: string;
  counterparty?: string | undefined;
  description: string;
  recurring_flag?: boolean | undefined;
  confidence?: number | undefined;
}

export interface AssetRecord {
  id: string;
  label: string;
  type: AssetType;
  value: number;
  currency: string;
  as_of_date: string;
  source_document_id?: string | undefined;
  notes?: string | undefined;
}

export interface LiabilityRecord {
  id: string;
  label: string;
  type: LiabilityType;
  outstanding_balance: number;
  currency: string;
  as_of_date: string;
  source_document_id?: string | undefined;
  notes?: string | undefined;
}

export interface MonthlySnapshot {
  id: string;
  year_month: string;
  income_total: number;
  expense_total: number;
  transfer_total?: number | undefined;
  net_cashflow: number;
  asset_total?: number | undefined;
  liability_total?: number | undefined;
  net_worth?: number | undefined;
  generated_at: string;
  currency: string;
  document_count: number;
  transaction_count: number;
}

export interface WealthState {
  version: number;
  lastImportAt?: string | undefined;
  lastParseAt?: string | undefined;
  counters: {
    documents: number;
    transactions: number;
  };
  documents: DocumentRecord[];
  accounts: AccountRecord[];
  transactions: TransactionRecord[];
  assets: AssetRecord[];
  liabilities: LiabilityRecord[];
  snapshots: MonthlySnapshot[];
}

export interface CommandOptions {
  json: boolean;
  instance?: string | undefined;
  configPath?: string | undefined;
  id?: string | undefined;
  path?: string | undefined;
  kind?: string | undefined;
  month?: string | undefined;
  currency?: string | undefined;
  institution?: string | undefined;
  notes?: string | undefined;
}
