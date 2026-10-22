import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getFakeRuntime, resetFakeRuntime } from "../__fixtures__/fake-runtime.js";
import { createLedger, localDay, type MailLedger, recordOutcome } from "../ledger/ledger.js";

vi.mock("../config/runtime.js", async () => {
  const actual =
    await vi.importActual<typeof import("../config/runtime.js")>("../config/runtime.js");
  return { ...actual, resolveToolRuntime: async () => getFakeRuntime() };
});

const { DEFAULT_RECONCILE_DAYS, formatReconcileResult, reconcile } = await import("./reconcile.js");

const NOW = new Date("2026-04-08T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (count: number): Date => new Date(NOW.getTime() - count * DAY_MS);

/** One verdict per day for `count` days, newest today. */
const ledgerSpanning = (count: number): MailLedger => {
  const ledger = createLedger();
  for (let index = 0; index < count; index += 1) {
    recordOutcome(ledger, `imap:1:${String(index + 1)}`, { state: "gray" }, daysAgo(index));
  }
  return ledger;
};

describe("commands/reconcile", () => {
  beforeEach(() => {
    resetFakeRuntime();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("requires an instance id", async () => {
    await expect(reconcile({})).rejects.toThrow("Expected --instance <id>");
  });

  it("rejects an invalid --limit", async () => {
    await expect(reconcile({ instance: "ms-core", limit: "0" })).rejects.toThrow(
      "Expected a positive integer limit",
    );
  });

  it("reports the last 7 days by default", async () => {
    getFakeRuntime().ledger = ledgerSpanning(10);
    const result = await reconcile({ instance: "ms-core" });
    expect(DEFAULT_RECONCILE_DAYS).toBe(7);
    expect(result.instanceId).toBe("ms-core");
    expect(result.days).toHaveLength(7);
    expect(result.days[0]?.day).toBe(localDay(NOW));
    expect(result.totals).toMatchObject({ expected: 7, verdict: 7, residual: 0 });
  });

  it("honours --limit, capped at the retention window", async () => {
    getFakeRuntime().ledger = ledgerSpanning(10);
    expect((await reconcile({ instance: "ms-core", limit: "3" })).days).toHaveLength(3);
    expect((await reconcile({ instance: "ms-core", limit: "999" })).days).toHaveLength(10);
  });

  it("carries counts only, never mail content", async () => {
    const runtime = getFakeRuntime();
    runtime.ledger = ledgerSpanning(2);
    runtime.state.integrityDetails = {
      "imap:1:1": { from: "Alice <alice@example.com>", subject: "Secret invoice" },
    };
    const serialized = JSON.stringify(await reconcile({ instance: "ms-core" }));
    expect(serialized).not.toContain("alice@example.com");
    expect(serialized).not.toContain("Secret invoice");
  });

  describe("formatReconcileResult", () => {
    const render = async (ledger: MailLedger): Promise<string> => {
      getFakeRuntime().ledger = ledger;
      return formatReconcileResult(await reconcile({ instance: "ms-core" }));
    };

    it("says so when nothing was recorded", async () => {
      const text = await render(createLedger());
      expect(text).toBe(
        "Coverage: partial. No mailbox inventory has run yet.\nNo mail recorded yet.",
      );
    });

    it("names the coverage for every inventory status", async () => {
      const cases: Array<[MailLedger["inventory"]["status"], string]> = [
        ["available", "Coverage: full (independent mailbox inventory)."],
        ["unsupported", "Coverage: partial. The mail tool has no inventory command"],
        ["failed", "Coverage: partial. The last mailbox inventory failed."],
        ["unknown", "Coverage: partial. No mailbox inventory has run yet."],
      ];
      for (const [status, expected] of cases) {
        const ledger = createLedger();
        ledger.inventory.status = status;
        expect(await render(ledger)).toContain(expected);
      }
    });

    it("renders each day's equation, outcome breakdown and the total", async () => {
      const ledger = createLedger();
      recordOutcome(ledger, "imap:1:1", { state: "red", review: "reviewer" }, NOW);
      recordOutcome(ledger, "imap:1:2", { state: "read-failed", reason: "timeout" }, NOW);
      const text = await render(ledger);
      const today = localDay(NOW);
      expect(text).toContain(
        `${today} (partial): 2 = 1 verdict + 0 no verdict + 1 not processed + 0 in flight; residual 0`,
      );
      expect(text).toContain("  red 1 · read-failed 1");
      expect(text).toContain(
        "Total: 2 = 1 verdict + 0 no verdict + 1 not processed + 0 in flight; residual 0",
      );
      expect(text).not.toContain("flags:");
    });

    it("shows a non-zero residual as a defect, plus flags and the extra counts", async () => {
      const ledger = createLedger();
      recordOutcome(ledger, "imap:1:1", { state: "gray" }, NOW, { outageAffected: true });
      // A key deleted behind the ledger's back leaves the day's count unbalanced.
      recordOutcome(ledger, "imap:1:2", { state: "gray" }, NOW);
      delete ledger.entries["imap:1:2"];
      // A full day where a scan saw mail the inventory never listed.
      const yesterday = localDay(daysAgo(1));
      ledger.days[yesterday] = {
        recorded: 1,
        inventoried: 0,
        inventoryRuns: 1,
        flags: ["search-truncated", "coverage-break"],
      };
      ledger.entries["imap:2:9"] = {
        key: "imap:2:9",
        firstSeenAt: daysAgo(1).toISOString(),
        state: "amber",
        attempts: 1,
        updatedAt: daysAgo(1).toISOString(),
      };
      const text = await render(ledger);
      expect(text).toContain("; RESIDUAL 1 (reconciliation defect)");
      expect(text).toContain("  outage-affected 1");
      expect(text).toContain("  seen by a scan but not inventoried 1");
      expect(text).toContain("  flags: search-truncated, coverage-break");
      expect(text).toContain(`${yesterday} (full): 0 = 0 verdict`);
    });

    it("names the verdicts that arrived late, and returns them per day in the JSON", async () => {
      const ledger = createLedger();
      recordOutcome(ledger, "imap:1:1", { state: "red", review: "reviewer", reason: "late" }, NOW);
      getFakeRuntime().ledger = ledger;
      const report = await reconcile({ instance: "ms-core" });
      expect(report.days[0]?.lateVerdicts).toBe(1);
      expect(report.totals.lateVerdicts).toBe(1);
      expect(formatReconcileResult(report)).toContain("  late verdicts 1");
    });

    it("omits the breakdown line for a day with no counted outcome", async () => {
      const ledger = createLedger();
      ledger.days[localDay(NOW)] = { recorded: 1, inventoried: 0, inventoryRuns: 0 };
      const lines = (await render(ledger)).split("\n");
      expect(lines[1]).toContain("RESIDUAL 1");
      expect(lines[2]).toMatch(/^Total: /u);
    });
  });
});
