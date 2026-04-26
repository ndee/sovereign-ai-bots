import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  documentTypes,
  help,
  importDocument,
  listAccounts,
  listAssets,
  listDocuments,
  listLiabilities,
  listTransactions,
  monthlyDigest,
  nextStep,
  parseDocument,
  reparseDocument,
  showCashflow,
  showDocument,
  showExpenses,
  showIncome,
  showMissingData,
  showNetWorth,
  showParsingIssues,
  showRecurring,
  showTopCategories,
  summary,
  weeklyReview,
  whatChanged,
} from "./commands.js";

const BANK_STATEMENT = [
  "Example Bank statement",
  "Statement period 2026-04-01 to 2026-04-30",
  "IBAN DE89370400440532013000",
  "Closing balance 2500.00",
  "2026-04-02 Salary Acme Corp +3000.00",
  "2026-04-05 Rent payment landlord 1100.00",
  "2026-04-10 Edeka groceries 75.42",
  "2026-04-12 Netflix subscription 12.99",
  "2026-04-20 Edeka groceries 60.00",
].join("\n");

const ACCOUNT_SUMMARY = [
  "Account summary 2026-04-30",
  "Savings deposit 12000.00",
  "Brokerage portfolio 25000.00",
  "Mortgage outstanding 80000.00",
].join("\n");

interface Harness {
  tempDir: string;
  inboxDir: string;
  configPath: string;
  options: { instance: string; configPath: string; json: boolean };
  writeInboxFile: (name: string, content: string) => Promise<string>;
}

const setupHarness = async (): Promise<Harness> => {
  const tempDir = await mkdtemp(join(tmpdir(), "wealth-cmd-"));
  const workspaceDir = join(tempDir, "workspace");
  const inboxDir = join(workspaceDir, "inbox");
  const dataDir = join(workspaceDir, "data");
  await rm(dataDir, { recursive: true, force: true });
  await writeFile(
    join(tempDir, "node-config.json"),
    JSON.stringify(
      {
        sovereignTools: {
          instances: [
            {
              id: "wealth-alignment-core",
              config: {
                statePath: join(dataDir, "wealth-alignment-state.json"),
                inboxPath: inboxDir,
                agentId: "wealth-alignment-core",
              },
            },
          ],
        },
        openclawProfile: {
          agents: [{ id: "wealth-alignment-core", workspace: workspaceDir }],
        },
      },
      null,
      2,
    ),
  );
  await writeFile(join(tempDir, "ensure-inbox"), "", "utf8");
  // ensure inbox dir exists
  await rm(inboxDir, { recursive: true, force: true });
  await import("node:fs/promises").then((mod) => mod.mkdir(inboxDir, { recursive: true }));
  return {
    tempDir,
    inboxDir,
    configPath: join(tempDir, "node-config.json"),
    options: {
      instance: "wealth-alignment-core",
      configPath: join(tempDir, "node-config.json"),
      json: false,
    },
    writeInboxFile: async (name, content) => {
      const path = join(inboxDir, name);
      await writeFile(path, content, "utf8");
      return path;
    },
  };
};

describe("wealth-alignment/commands", () => {
  let harness: Harness | undefined;

  beforeEach(async () => {
    harness = await setupHarness();
  });

  afterEach(async () => {
    if (harness !== undefined) {
      await rm(harness.tempDir, { recursive: true, force: true });
      harness = undefined;
    }
  });

  it("returns help and document types", () => {
    const helpResult = help();
    expect(helpResult.commands.length).toBeGreaterThan(10);
    const types = documentTypes();
    expect(types.supported.map((entry) => entry.kind)).toContain("bank_statement");
  });

  it("rejects missing instance", async () => {
    await expect(listDocuments({ json: false })).rejects.toThrow(/--instance/);
  });

  it("imports, parses, and reparses a bank statement end to end", async () => {
    const h = harness as Harness;
    const path = await h.writeInboxFile("bank-april.txt", BANK_STATEMENT);
    const importResult = await importDocument({
      ...h.options,
      path,
      kind: "bank_statement",
    });
    expect(importResult.document.parse_status).toBe("pending");
    const parseResult = await parseDocument({ ...h.options, id: importResult.document.id });
    expect(parseResult.document.parse_status).toBe("parsed");
    expect(parseResult.extracted.transactions).toBeGreaterThanOrEqual(4);

    const docs = await listDocuments(h.options);
    expect(docs.documents).toHaveLength(1);
    const show = await showDocument({ ...h.options, id: importResult.document.id });
    expect(show.transactionCount).toBeGreaterThanOrEqual(4);
    expect(show.account?.type).toBe("bank");

    const accounts = await listAccounts(h.options);
    expect(accounts.accounts).toHaveLength(1);

    const transactions = await listTransactions({ ...h.options, month: "2026-04" });
    expect(transactions.transactions.length).toBeGreaterThan(0);

    const all = await listTransactions(h.options);
    expect(all.transactions.length).toBeGreaterThan(0);

    const income = await showIncome({ ...h.options, month: "2026-04" });
    expect(income.totals.income).toBeGreaterThan(0);
    const expenses = await showExpenses({ ...h.options, month: "2026-04" });
    expect(expenses.totals.expenses).toBeGreaterThan(0);
    const cashflow = await showCashflow({ ...h.options, month: "2026-04" });
    expect(cashflow.totals.netCashflow).toBeDefined();

    const reparseResult = await reparseDocument({ ...h.options, id: importResult.document.id });
    expect(reparseResult.document.parse_status).toBe("parsed");
  });

  it("extracts assets and liabilities from an account summary", async () => {
    const h = harness as Harness;
    const path = await h.writeInboxFile("summary.txt", ACCOUNT_SUMMARY);
    const importResult = await importDocument({
      ...h.options,
      path,
      kind: "account_summary",
    });
    await parseDocument({ ...h.options, id: importResult.document.id });
    const netWorth = await showNetWorth(h.options);
    expect(netWorth.summary.netWorth).toBeLessThan(netWorth.summary.assetTotal);
    expect(netWorth.note).toBeUndefined();

    const assets = await listAssets(h.options);
    expect(assets.assets.length).toBeGreaterThan(0);
    const liabilities = await listLiabilities(h.options);
    expect(liabilities.liabilities.length).toBeGreaterThan(0);
  });

  it("notes incomplete net worth when assets and liabilities are missing", async () => {
    const h = harness as Harness;
    const netWorth = await showNetWorth(h.options);
    expect(netWorth.note).toContain("No asset");
  });

  it("compares months with what-changed", async () => {
    const h = harness as Harness;
    const path = await h.writeInboxFile("bank.txt", BANK_STATEMENT);
    const importResult = await importDocument({ ...h.options, path });
    await parseDocument({ ...h.options, id: importResult.document.id });
    const result = await whatChanged({ ...h.options, month: "2026-04" });
    expect(result.previousMonth).toBe("2026-03");
    expect(result.incomeDelta).toBeGreaterThanOrEqual(0);
  });

  it("returns summary, weekly review, monthly digest, recurring, top categories", async () => {
    const h = harness as Harness;
    const path = await h.writeInboxFile("bank.txt", BANK_STATEMENT);
    const importResult = await importDocument({ ...h.options, path, kind: "bank_statement" });
    await parseDocument({ ...h.options, id: importResult.document.id });
    const summaryResult = await summary(h.options);
    expect(summaryResult.documentCount).toBe(1);
    const weekly = await weeklyReview(h.options);
    expect(weekly.documentsAdded).toHaveLength(1);
    const digest = await monthlyDigest({ ...h.options, month: "2026-04" });
    expect(digest.totals.expenses).toBeGreaterThan(0);
    const recurring = await showRecurring(h.options);
    expect(recurring.recurring.length).toBeGreaterThanOrEqual(0);
    const top = await showTopCategories({ ...h.options, month: "2026-04" });
    expect(top.categories.length).toBeGreaterThan(0);
  });

  it("returns parsing issues and missing data", async () => {
    const h = harness as Harness;
    const path = await h.writeInboxFile("blank.txt", "no data here");
    const importResult = await importDocument({ ...h.options, path, kind: "bank_statement" });
    await parseDocument({ ...h.options, id: importResult.document.id });
    const issues = await showParsingIssues(h.options);
    expect(issues.documents).toHaveLength(1);
    const missing = await showMissingData(h.options);
    expect(missing.missing.length).toBeGreaterThan(0);
    const next = await nextStep(h.options);
    expect(next.step).toBeTruthy();
  });

  it("rejects invalid month", async () => {
    const h = harness as Harness;
    await expect(showIncome({ ...h.options, month: "bad" })).rejects.toThrow(/Invalid --month/);
  });

  it("rejects unsupported document kind", async () => {
    const h = harness as Harness;
    const path = await h.writeInboxFile("file.txt", "anything");
    await expect(importDocument({ ...h.options, path, kind: "weird" })).rejects.toThrow(
      /Unsupported document kind/,
    );
  });

  it("imports without an explicit kind, inferring it", async () => {
    const h = harness as Harness;
    const path = await h.writeInboxFile("payslip.txt", "Payslip\nNet pay 2500.00");
    const importResult = await importDocument({ ...h.options, path });
    expect(importResult.inferred).toBe(true);
    expect(importResult.document.document_type).toBe("payslip");
  });

  it("rejects show-document and parse without an id", async () => {
    const h = harness as Harness;
    await expect(showDocument(h.options)).rejects.toThrow(/document-id/);
    await expect(parseDocument(h.options)).rejects.toThrow(/document-id/);
    await expect(reparseDocument(h.options)).rejects.toThrow(/document-id/);
    await expect(importDocument(h.options)).rejects.toThrow(/--path/);
  });

  it("reports missing source files on reparse", async () => {
    const h = harness as Harness;
    const path = await h.writeInboxFile("bank.txt", BANK_STATEMENT);
    const importResult = await importDocument({ ...h.options, path, kind: "bank_statement" });
    await parseDocument({ ...h.options, id: importResult.document.id });
    await rm(path);
    const result = await reparseDocument({ ...h.options, id: importResult.document.id });
    expect(result.document.parse_status).toBe("failed");
  });

  it("rejects show-document for unknown ids", async () => {
    const h = harness as Harness;
    await expect(showDocument({ ...h.options, id: "missing" })).rejects.toThrow(
      /Document not found/,
    );
  });

  it("returns no-account summary on import without account info", async () => {
    const h = harness as Harness;
    const path = await h.writeInboxFile("invoice.txt", "Invoice\nTotal due 100.00");
    const importResult = await importDocument({ ...h.options, path, kind: "invoice" });
    await parseDocument({ ...h.options, id: importResult.document.id });
    const show = await showDocument({ ...h.options, id: importResult.document.id });
    expect(show.account).toBeUndefined();
  });
});
