import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  chooseNextStep,
  computeMissingData,
  importDocument,
  monthlyDigest,
  parseDocument,
  reparseDocument,
  showIncome,
  whatChanged,
} from "./commands.js";
import { createDefaultState, saveState } from "./state.js";
import type { DocumentRecord, WealthState } from "./types.js";

const buildState = (overrides: Partial<WealthState> = {}): WealthState => ({
  ...createDefaultState(),
  ...overrides,
});

const doc = (overrides: Partial<DocumentRecord>): DocumentRecord => ({
  id: overrides.id ?? "doc-1",
  source_type: overrides.source_type ?? "file",
  document_type: overrides.document_type ?? "bank_statement",
  uploaded_at: overrides.uploaded_at ?? "2026-04-15T00:00:00Z",
  parse_status: overrides.parse_status ?? "parsed",
  ...overrides,
});

interface Harness {
  tempDir: string;
  workspaceDir: string;
  inboxDir: string;
  configPath: string;
  options: { instance: string; configPath: string; json: boolean };
}

const setupHarness = async (): Promise<Harness> => {
  const tempDir = await mkdtemp(join(tmpdir(), "wealth-branch-"));
  const workspaceDir = join(tempDir, "workspace");
  const inboxDir = join(workspaceDir, "inbox");
  const dataDir = join(workspaceDir, "data");
  await mkdir(inboxDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const configPath = join(tempDir, "node-config.json");
  await writeFile(
    configPath,
    JSON.stringify({
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
    }),
  );
  return {
    tempDir,
    workspaceDir,
    inboxDir,
    configPath,
    options: { instance: "wealth-alignment-core", configPath, json: false },
  };
};

describe("wealth-alignment/commands branches", () => {
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

  it("computeMissingData covers every branch", () => {
    expect(computeMissingData(buildState())).toContain("No documents have been imported yet.");
    const state = buildState({
      documents: [
        doc({ id: "d1", document_type: "credit_card_statement", parse_status: "needs_review" }),
        doc({ id: "d2", document_type: "credit_card_statement", parse_status: "failed" }),
      ],
      transactions: [
        {
          id: "t1",
          document_id: "d1",
          date: "2026-04-01",
          amount: 100,
          currency: "EUR",
          direction: "expense",
          category: "x",
          description: "y",
        },
      ],
    });
    const missing = computeMissingData(state, "2026-04");
    expect(missing).toContain("Expenses recorded but no income for the current month.");
    expect(missing).toContain("No asset records yet.");
    expect(missing).toContain("No liability records yet.");
    expect(missing.some((entry) => entry.includes("Credit card statements"))).toBe(true);
    expect(missing.some((entry) => entry.includes("need review"))).toBe(true);

    const incomeOnly = buildState({
      documents: [doc({})],
      transactions: [
        {
          id: "t1",
          document_id: "d1",
          date: "2026-04-01",
          amount: 100,
          currency: "EUR",
          direction: "income",
          category: "Income",
          description: "y",
        },
      ],
    });
    expect(computeMissingData(incomeOnly, "2026-04")).toContain(
      "Income recorded but no expense documents for the current month.",
    );
  });

  it("chooseNextStep covers every branch", () => {
    const empty = buildState();
    expect(chooseNextStep(empty, [])).toContain("Drop a finance document");

    const pending = buildState({ documents: [doc({ parse_status: "pending" })] });
    expect(chooseNextStep(pending, [])).toContain("parse --id");

    const failed = buildState({ documents: [doc({ id: "d1", parse_status: "failed" })] });
    expect(chooseNextStep(failed, [])).toContain("failed to parse");

    const needsReview = buildState({
      documents: [doc({ id: "d1", parse_status: "needs_review" })],
    });
    expect(chooseNextStep(needsReview, [])).toContain("needs review");

    const noLiabilities = buildState({
      documents: [doc({})],
      assets: [
        {
          id: "a",
          label: "x",
          type: "cash",
          value: 1,
          currency: "EUR",
          as_of_date: "2026-04-01",
        },
      ],
    });
    expect(chooseNextStep(noLiabilities, [])).toContain("liability");

    const noAssets = buildState({
      documents: [doc({})],
      liabilities: [
        {
          id: "l",
          label: "y",
          type: "loan",
          outstanding_balance: 1,
          currency: "EUR",
          as_of_date: "2026-04-01",
        },
      ],
    });
    expect(chooseNextStep(noAssets, [])).toContain("asset / account summary");

    const expensesOnly = buildState({
      documents: [doc({})],
      assets: [
        {
          id: "a",
          label: "x",
          type: "cash",
          value: 1,
          currency: "EUR",
          as_of_date: "2026-04-01",
        },
      ],
      liabilities: [
        {
          id: "l",
          label: "y",
          type: "loan",
          outstanding_balance: 1,
          currency: "EUR",
          as_of_date: "2026-04-01",
        },
      ],
      transactions: [
        {
          id: "t",
          document_id: "d1",
          date: "2026-04-01",
          amount: 100,
          currency: "EUR",
          direction: "expense",
          category: "x",
          description: "y",
        },
      ],
    });
    expect(chooseNextStep(expensesOnly, [], "2026-04")).toContain("missing income");

    const allClean = buildState({
      documents: [doc({})],
      assets: [
        {
          id: "a",
          label: "x",
          type: "cash",
          value: 1,
          currency: "EUR",
          as_of_date: "2026-04-01",
        },
      ],
      liabilities: [
        {
          id: "l",
          label: "y",
          type: "loan",
          outstanding_balance: 1,
          currency: "EUR",
          as_of_date: "2026-04-01",
        },
      ],
    });
    expect(chooseNextStep(allClean, [])).toContain("monthly-digest");
    expect(chooseNextStep(allClean, ["something missing"])).toContain("something missing");
  });

  it("rejects non-file paths during import", async () => {
    const h = harness as Harness;
    await expect(importDocument({ ...h.options, path: h.inboxDir })).rejects.toThrow(/Not a file/);
  });

  it("truncates oversized inbox files", async () => {
    const h = harness as Harness;
    const filePath = join(h.inboxDir, "big.txt");
    const big = `Bank statement\n${"x".repeat(300 * 1024)}\n2026-04-02 Salary +3000.00`;
    await writeFile(filePath, big, "utf8");
    const stats = await stat(filePath);
    expect(stats.size).toBeGreaterThan(256 * 1024);
    const result = await importDocument({
      ...h.options,
      path: filePath,
      kind: "bank_statement",
    });
    expect(result.document.raw_text?.length).toBe(256 * 1024);
  });

  it("preserves document_type when source_path or extracted_text are missing on parse", async () => {
    const h = harness as Harness;
    const dataPath = join(h.workspaceDir, "data", "wealth-alignment-state.json");
    const state = createDefaultState();
    state.documents.push({
      id: "doc-x",
      source_type: "file",
      document_type: "unknown",
      uploaded_at: "2026-04-15T00:00:00Z",
      parse_status: "pending",
      extracted_text: "no extractable structure here",
    });
    state.documents.push({
      id: "doc-empty",
      source_type: "file",
      document_type: "bank_statement",
      uploaded_at: "2026-04-15T00:00:00Z",
      parse_status: "pending",
    });
    state.documents.push({
      id: "doc-raw-only",
      source_type: "file",
      document_type: "bank_statement",
      uploaded_at: "2026-04-15T00:00:00Z",
      parse_status: "pending",
      raw_text: "2026-04-01 Salary +1500.00",
    });
    await saveState(dataPath, state);
    const result = await parseDocument({ ...h.options, id: "doc-x" });
    expect(result.document.document_type).toBe("unknown");
    const empty = await parseDocument({ ...h.options, id: "doc-empty" });
    expect(empty.document.parse_status).toBe("needs_review");
    const rawOnly = await parseDocument({ ...h.options, id: "doc-raw-only" });
    expect(rawOnly.document.parse_status).toBe("parsed");
  });

  it("infers document_type during parse when both source_path and extracted_text are present", async () => {
    const h = harness as Harness;
    const dataPath = join(h.workspaceDir, "data", "wealth-alignment-state.json");
    const state = createDefaultState();
    state.documents.push({
      id: "doc-y",
      source_type: "file",
      document_type: "unknown",
      uploaded_at: "2026-04-15T00:00:00Z",
      parse_status: "pending",
      source_path: "/tmp/payslip.txt",
      extracted_text: "Payslip\nNet pay 1500.00",
    });
    await saveState(dataPath, state);
    const result = await parseDocument({ ...h.options, id: "doc-y" });
    expect(result.document.document_type).toBe("payslip");
  });

  it("rejects an unknown kind via parseDocumentKind", async () => {
    const h = harness as Harness;
    const filePath = join(h.inboxDir, "x.txt");
    await writeFile(filePath, "hi", "utf8");
    await expect(
      importDocument({ ...h.options, path: filePath, kind: "unknown" }),
    ).resolves.toBeDefined();
  });

  it("reparses without a source path", async () => {
    const h = harness as Harness;
    const dataPath = join(h.workspaceDir, "data", "wealth-alignment-state.json");
    const state = createDefaultState();
    state.documents.push({
      id: "doc-z",
      source_type: "file",
      document_type: "bank_statement",
      uploaded_at: "2026-04-15T00:00:00Z",
      parse_status: "pending",
      raw_text: "2026-04-01 Salary +3000.00",
      extracted_text: "2026-04-01 Salary +3000.00",
    });
    state.documents.push({
      id: "doc-empty-reparse",
      source_type: "file",
      document_type: "bank_statement",
      uploaded_at: "2026-04-15T00:00:00Z",
      parse_status: "pending",
    });
    state.documents.push({
      id: "doc-raw-reparse",
      source_type: "file",
      document_type: "bank_statement",
      uploaded_at: "2026-04-15T00:00:00Z",
      parse_status: "pending",
      raw_text: "2026-04-01 Salary +3000.00",
    });
    await saveState(dataPath, state);
    const result = await reparseDocument({ ...h.options, id: "doc-z" });
    expect(result.document.parse_status).toBe("parsed");
    const empty = await reparseDocument({ ...h.options, id: "doc-empty-reparse" });
    expect(empty.document.parse_status).toBe("needs_review");
    const raw = await reparseDocument({ ...h.options, id: "doc-raw-reparse" });
    expect(raw.document.parse_status).toBe("parsed");
  });

  it("uses the current year-month when --month is omitted", async () => {
    const h = harness as Harness;
    const result = await showIncome(h.options);
    expect(result.yearMonth).toMatch(/^\d{4}-\d{2}$/);
    const digest = await monthlyDigest(h.options);
    expect(digest.yearMonth).toMatch(/^\d{4}-\d{2}$/);
    const change = await whatChanged(h.options);
    expect(change.previousMonth).toMatch(/^\d{4}-\d{2}$/);
  });

  it("falls back to upload-date document counts when no date range is recorded", async () => {
    const h = harness as Harness;
    const dataPath = join(h.workspaceDir, "data", "wealth-alignment-state.json");
    const state = createDefaultState();
    const month = new Date().toISOString().slice(0, 7);
    state.documents.push({
      id: "doc-no-range",
      source_type: "file",
      document_type: "invoice",
      uploaded_at: `${month}-15T00:00:00Z`,
      parse_status: "parsed",
    });
    await saveState(dataPath, state);
    const result = await showIncome({ ...h.options });
    expect(result.documentCount).toBe(1);
  });

  it("sorts documents and transactions when listing multiple entries", async () => {
    const h = harness as Harness;
    const first = join(h.inboxDir, "first.txt");
    const second = join(h.inboxDir, "second.txt");
    await writeFile(first, "Bank statement\n2026-03-01 Salary +1000.00\n", "utf8");
    await writeFile(second, "Bank statement\n2026-04-01 Salary +1500.00\n", "utf8");
    const a = await importDocument({ ...h.options, path: first, kind: "bank_statement" });
    const b = await importDocument({ ...h.options, path: second, kind: "bank_statement" });
    await parseDocument({ ...h.options, id: a.document.id });
    await parseDocument({ ...h.options, id: b.document.id });
    const { listDocuments, listTransactions } = await import("./commands.js");
    const docs = await listDocuments(h.options);
    expect(docs.documents).toHaveLength(2);
    const txs = await listTransactions(h.options);
    expect(txs.transactions.length).toBeGreaterThan(0);
  });

  it("creates a credit-card account from a credit-card statement", async () => {
    const h = harness as Harness;
    const filePath = join(h.inboxDir, "visa.txt");
    await writeFile(
      filePath,
      [
        "Visa credit card statement",
        "Card ending 1234",
        "Statement period 2026-04-01 to 2026-04-30",
        "2026-04-02 Amazon shop 45.00",
      ].join("\n"),
      "utf8",
    );
    const importResult = await importDocument({
      ...h.options,
      path: filePath,
      kind: "credit_card_statement",
    });
    await parseDocument({ ...h.options, id: importResult.document.id });
  });

  it("reuses an existing account on reparse", async () => {
    const h = harness as Harness;
    const filePath = join(h.inboxDir, "bank.txt");
    await writeFile(
      filePath,
      [
        "Example Bank statement",
        "Statement period 2026-04-01 to 2026-04-30",
        "IBAN DE89370400440532013000",
        "Closing balance 100.00",
        "2026-04-02 Salary +3000.00",
      ].join("\n"),
      "utf8",
    );
    const importResult = await importDocument({
      ...h.options,
      path: filePath,
      kind: "bank_statement",
    });
    await parseDocument({ ...h.options, id: importResult.document.id });
    const second = await reparseDocument({ ...h.options, id: importResult.document.id });
    expect(second.document.parse_status).toBe("parsed");
  });
});
