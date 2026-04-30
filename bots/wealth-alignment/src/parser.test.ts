import { describe, expect, it } from "vitest";

import { inferDocumentKind, parseDocumentText } from "./parser.js";

describe("wealth-alignment/parser", () => {
  it("infers document kind from filename and text", () => {
    expect(inferDocumentKind("visa-statement.pdf", "")).toBe("credit_card_statement");
    expect(inferDocumentKind("payslip.txt", "")).toBe("payslip");
    expect(inferDocumentKind("invoice-2026.txt", "")).toBe("invoice");
    expect(inferDocumentKind("portfolio.txt", "")).toBe("account_summary");
    expect(inferDocumentKind("kontoauszug.txt", "")).toBe("bank_statement");
    expect(inferDocumentKind("random.txt", "")).toBe("unknown");
  });

  it("flags empty documents as needs_review", () => {
    const result = parseDocumentText({ document_type: "bank_statement" }, "   ");
    expect(result.status).toBe("needs_review");
    expect(result.warnings).toContain("Document text is empty.");
  });

  it("parses bank statement lines", () => {
    const text = [
      "Example Bank account statement",
      "Statement period 2026-03-01 to 2026-03-31",
      "IBAN DE89370400440532013000",
      "Closing balance 1234.56",
      "2026-03-02 Salary Acme Corp +2500.00",
      "2026-03-05 Rent payment landlord 1100.00",
      "2026-03-10 Edeka groceries 75.42",
      "2026-03-12 Netflix subscription 12.99",
      "2026-03-15 SEPA transfer to savings 200.00",
    ].join("\n");
    const result = parseDocumentText(
      { document_type: "bank_statement", source_path: "stmt.txt" },
      text,
    );
    expect(result.status).toBe("parsed");
    expect(result.transactions.length).toBeGreaterThanOrEqual(4);
    expect(result.institution?.toLowerCase()).toContain("bank");
    expect(result.account_name).toMatch(/Account/);
    expect(result.account_balance).toBe(1234.56);
    expect(result.date_range_start).toBe("2026-03-01");
    expect(result.date_range_end).toBe("2026-03-31");
    const categories = result.transactions.map((entry) => entry.category);
    expect(categories).toContain("Housing");
    expect(categories).toContain("Subscriptions");
    expect(result.transactions.some((entry) => entry.direction === "transfer")).toBe(true);
  });

  it("infers expense direction for credit card statements", () => {
    const text = [
      "Visa Platinum credit card statement",
      "Card ending 1234",
      "Statement period 01/03/2026 to 31/03/2026",
      "02.03.2026 Amazon shop 45.00",
      "10.03.2026 Restaurant dinner 60.00",
      "20.03.2026 Payment received -100.00",
    ].join("\n");
    const result = parseDocumentText({ document_type: "credit_card_statement" }, text);
    expect(result.status).toBe("parsed");
    expect(result.account_name).toBe("Card ending 1234");
    const directions = result.transactions.map((entry) => entry.direction);
    expect(directions).toContain("expense");
    expect(directions).toContain("income");
  });

  it("parses payslips and falls back to gross when net is missing", () => {
    const netResult = parseDocumentText(
      { document_type: "payslip" },
      "Payslip\nPay date 2026-03-31\nNet pay 3,200.00 EUR",
    );
    expect(netResult.transactions).toHaveLength(1);
    expect(netResult.transactions[0]?.direction).toBe("income");
    expect(netResult.transactions[0]?.amount).toBe(3200);

    const grossResult = parseDocumentText(
      { document_type: "payslip" },
      "Payslip\nGross pay 4000.00",
    );
    expect(grossResult.transactions).toHaveLength(1);
    expect(grossResult.transactions[0]?.amount).toBe(4000);

    const emptyResult = parseDocumentText({ document_type: "payslip" }, "Payslip\nno totals");
    expect(emptyResult.transactions).toHaveLength(0);
    expect(emptyResult.status).toBe("needs_review");
  });

  it("parses invoices", () => {
    const result = parseDocumentText(
      { document_type: "invoice" },
      "Invoice 2026-03-15\nTotal due 250.00",
    );
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]?.direction).toBe("expense");
    expect(result.transactions[0]?.amount).toBe(250);
    expect(result.transactions[0]?.date).toBe("2026-03-15");

    const noDate = parseDocumentText({ document_type: "invoice" }, "Invoice\nTotal due $99.99");
    expect(noDate.transactions[0]?.currency).toBe("USD");

    const noTotal = parseDocumentText({ document_type: "invoice" }, "Invoice without totals");
    expect(noTotal.transactions).toHaveLength(0);
  });

  it("parses account summary into assets and liabilities", () => {
    const text = [
      "Account summary 2026-03-31",
      "Savings deposit 12000.00",
      "Brokerage portfolio 25000.00",
      "Real estate property 200000.00",
      "Vehicle car 8000.00",
      "Cash 500.00",
      "Mortgage outstanding 80000.00",
      "Credit card debt 1500.00",
      "Personal loan owed 5000.00",
    ].join("\n");
    const result = parseDocumentText({ document_type: "account_summary" }, text);
    const assetTypes = result.assets.map((entry) => entry.type);
    expect(assetTypes).toContain("deposit");
    expect(assetTypes).toContain("investment");
    expect(assetTypes).toContain("real_estate");
    expect(assetTypes).toContain("vehicle");
    expect(assetTypes).toContain("cash");
    const liabilityTypes = result.liabilities.map((entry) => entry.type);
    expect(liabilityTypes).toContain("mortgage");
    expect(liabilityTypes).toContain("credit_card");
    expect(liabilityTypes).toContain("loan");
  });

  it("infers document kind from text when type is unknown", () => {
    const result = parseDocumentText(
      { document_type: "unknown", source_path: "anon.txt" },
      "Visa credit card statement\n02.03.2026 store 10.00",
    );
    expect(result.transactions.length).toBeGreaterThan(0);
  });

  it("marks unsupported types as needs_review", () => {
    const result = parseDocumentText(
      { document_type: "unknown", source_path: "blank.txt" },
      "no signal here",
    );
    expect(result.status).toBe("needs_review");
  });

  it("normalizes amounts in different formats", () => {
    const text = [
      "Bank statement",
      "2026-03-01 entry one 1.234,56",
      "2026-03-02 entry two 1,234.56",
      "2026-03-03 entry three (45.00)",
      "2026-03-04 entry four 1'000.00",
    ].join("\n");
    const result = parseDocumentText({ document_type: "bank_statement" }, text);
    const amounts = result.transactions.map((entry) => entry.amount);
    expect(amounts).toContain(1234.56);
    expect(amounts.some((value) => value < 0)).toBe(true);
  });

  it("handles slash-format dates with two-digit years", () => {
    const text = "Bank statement\n02/03/26 Aldi groceries 25.00";
    const result = parseDocumentText({ document_type: "bank_statement" }, text);
    expect(result.transactions[0]?.date).toBe("2026-03-02");
  });

  it("ignores lines without a parseable amount", () => {
    const text = "Bank statement\n2026-03-01 description without amount";
    const result = parseDocumentText({ document_type: "bank_statement" }, text);
    expect(result.transactions).toHaveLength(0);
  });

  it("skips short header lines and standalone amount lines", () => {
    const text = ["abc", "", "1234.56", "2026-04-01 Salary +1000"].join("\n");
    const result = parseDocumentText({ document_type: "bank_statement" }, text);
    expect(result.transactions).toHaveLength(1);
  });

  it("skips short and amount-only entries when reading account summary", () => {
    const text = [
      "abc",
      "1234.56",
      "no amount on this descriptive line",
      "Savings deposit 100.00",
    ].join("\n");
    const result = parseDocumentText({ document_type: "account_summary" }, text);
    expect(result.assets.length).toBeGreaterThan(0);
  });
});
