import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getFakeRuntime, resetFakeRuntime } from "../__fixtures__/fake-runtime.js";
import { sampleRules } from "../__fixtures__/inputs.js";
import { createLedger, type LedgerEntry, localDay, recordOutcome } from "../ledger/ledger.js";

vi.mock("../config/runtime.js", async () => {
  const actual =
    await vi.importActual<typeof import("../config/runtime.js")>("../config/runtime.js");
  return {
    ...actual,
    resolveToolRuntime: async () => getFakeRuntime(),
    checkToolAvailability: async () => ({
      ok: true,
      executable: "/usr/local/bin/sovereign-tool",
      source: "default",
    }),
  };
});

vi.mock("../state/io.js", async () => {
  const actual = await vi.importActual<typeof import("../state/io.js")>("../state/io.js");
  return {
    ...actual,
    withLockedState: async <T>(_p: string, action: () => Promise<T>) => action(),
  };
});

const { DEFAULT_INTEGRITY_DAYS, formatIntegrityResult, integrity } = await import("./integrity.js");
const { scan } = await import("./scan.js");

const NOW = new Date("2026-04-08T12:00:00.000Z");
const minutesAgo = (count: number): Date => new Date(NOW.getTime() - count * 60 * 1000);
const daysAgo = (count: number): Date => new Date(NOW.getTime() - count * 24 * 60 * 60 * 1000);

describe("commands/integrity", () => {
  beforeEach(() => {
    resetFakeRuntime();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("requires an instance id", async () => {
    await expect(integrity({})).rejects.toThrow("Expected --instance <id>");
  });

  it("rejects an invalid --limit", async () => {
    await expect(integrity({ instance: "ms-core", limit: "-1" })).rejects.toThrow(
      "Expected a positive integer limit",
    );
  });

  it("reports an empty period", async () => {
    const result = await integrity({ instance: "ms-core" });
    expect(result).toEqual({
      instanceId: "ms-core",
      coverage: "partial",
      days: [],
      unaccounted: [],
    });
    expect(formatIntegrityResult(result)).toBe(
      "Mail check (coverage: partial).\nNo mail recorded yet.",
    );
  });

  it("summarizes each day and says when every message was checked", async () => {
    const ledger = createLedger();
    recordOutcome(ledger, "imap:1:1", { state: "gray" }, NOW);
    recordOutcome(ledger, "imap:1:2", { state: "deferred" }, NOW);
    getFakeRuntime().ledger = ledger;
    const result = await integrity({ instance: "ms-core" });
    expect(DEFAULT_INTEGRITY_DAYS).toBe(7);
    expect(result.days).toEqual([
      {
        day: localDay(NOW),
        received: 2,
        checked: 1,
        notChecked: 0,
        inProgress: 1,
        countingDefect: 0,
      },
    ]);
    expect(formatIntegrityResult(result)).toBe(
      [
        "Mail check (coverage: partial).",
        `${localDay(NOW)}: 2 received, 1 checked, 0 not checked, 1 in progress.`,
        "Every message in this period was checked or is still in progress.",
      ].join("\n"),
    );
  });

  it("lists unaccounted messages newest first, naming them where the scan saw them", async () => {
    const ledger = createLedger();
    recordOutcome(ledger, "imap:1:1", { state: "read-failed", reason: "timeout" }, minutesAgo(30));
    recordOutcome(ledger, "imap:1:2", { state: "no-verdict:reviewer-unavailable" }, minutesAgo(10));
    recordOutcome(ledger, "imap:1:3", { state: "red", review: "reviewer" }, minutesAgo(5));
    ledger.entries["imap:1:4"] = {
      key: "imap:1:4",
      firstSeenAt: minutesAgo(20).toISOString(),
      state: "not-returned",
      reason: "truncated",
      attempts: 0,
      updatedAt: minutesAgo(20).toISOString(),
      inventoriedAt: minutesAgo(20).toISOString(),
    };
    const today = ledger.days[localDay(NOW)];
    if (today !== undefined) today.recorded += 1;
    const runtime = getFakeRuntime();
    runtime.ledger = ledger;
    runtime.state.integrityDetails = {
      "imap:1:1": { from: "Alice <alice@example.com>", subject: "Invoice 42" },
      "imap:1:2": { from: "Bob <bob@example.com>", subject: "Contract" },
    };
    const result = await integrity({ instance: "ms-core" });
    expect(result.unaccounted.map((message) => message.state)).toEqual([
      "no-verdict:reviewer-unavailable",
      "not-returned",
      "read-failed",
    ]);
    expect(result.unaccounted[0]).toEqual({
      firstSeenAt: minutesAgo(10).toISOString(),
      state: "no-verdict:reviewer-unavailable",
      from: "Bob <bob@example.com>",
      subject: "Contract",
    });
    expect(result.unaccounted[1]).toEqual({
      firstSeenAt: minutesAgo(20).toISOString(),
      state: "not-returned",
      reason: "truncated",
    });
    const text = formatIntegrityResult(result);
    expect(text).toContain("1 checked, 3 not checked");
    expect(text).toContain("Not checked:");
    expect(text).toContain(
      "· not reviewed: the AI reviewer was unavailable · Bob <bob@example.com> · Contract",
    );
    expect(text).toContain(
      "· in the mailbox, but never reached the scan (truncated) · never read; look in your mail client around this time",
    );
    expect(text).toContain(
      "· could not be read (timeout) · Alice <alice@example.com> · Invoice 42",
    );
    expect(text).toMatch(/- \d{4}-\d{2}-\d{2} \d{2}:\d{2} · /u);
  });

  it("counts a mail whose review failed as in progress, then as checked once a later scan reviews it", async () => {
    const runtime = getFakeRuntime();
    runtime.rules = sampleRules;
    runtime.searchMail = async () => ({
      messages: [
        {
          uid: 10,
          size: 1000,
          messageId: "<m10@ex>",
          from: ["Alice <alice@example.com>"],
          subject: "Invoice #10",
        },
      ],
    });
    runtime.readMail = async () => ({
      message: {
        uid: 10,
        messageId: "<m10@ex>",
        from: ["Alice <alice@example.com>"],
        subject: "Invoice #10",
        text: "Please pay $500 for invoice.",
        headers: [],
      },
    });
    runtime.classifyCandidate = async () => {
      throw new Error("llm down");
    };
    await scan({ instance: "ms-core" });
    expect((await integrity({ instance: "ms-core" })).days[0]).toMatchObject({
      checked: 0,
      notChecked: 0,
      inProgress: 1,
    });
    runtime.classifyCandidate = async () => ({
      decisionRequired: true,
      financialRelevance: true,
      riskEscalation: false,
      confidence: 95,
      urgency: "high",
      reason: "Payment is overdue.",
      deadlineDetected: true,
      amountDetected: true,
      suggestedZone: "red",
    });
    vi.setSystemTime(new Date(NOW.getTime() + 30 * 60 * 1000));
    await scan({ instance: "ms-core" });
    const result = await integrity({ instance: "ms-core" });
    expect(result.days[0]).toMatchObject({ checked: 1, notChecked: 0, inProgress: 0 });
    expect(result.unaccounted).toEqual([]);
  });

  it("asks the operator to look at a mail whose re-reviews ran out", async () => {
    const ledger = createLedger();
    recordOutcome(
      ledger,
      "imap:1:1",
      { state: "deferred", reason: "review-retry" },
      minutesAgo(10),
    );
    recordOutcome(
      ledger,
      "imap:1:2",
      { state: "no-verdict:reviewer-unavailable", reason: "retries-exhausted" },
      minutesAgo(20),
    );
    recordOutcome(
      ledger,
      "imap:1:3",
      { state: "no-verdict:reviewer-unavailable", reason: "recovery-failed" },
      minutesAgo(30),
    );
    getFakeRuntime().ledger = ledger;
    const result = await integrity({ instance: "ms-core" });
    expect(result.days[0]).toMatchObject({ checked: 0, notChecked: 2, inProgress: 1 });
    expect(result.unaccounted.map((message) => message.reason)).toEqual([
      "retries-exhausted",
      "recovery-failed",
    ]);
    const text = formatIntegrityResult(result);
    expect(text).toContain(
      "· not reviewed: please look at this one yourself (retries-exhausted) ·",
    );
    expect(text).toContain("· not reviewed: please look at this one yourself (recovery-failed) ·");
  });

  it("caps the list at 20 messages", async () => {
    const ledger = createLedger();
    for (let index = 0; index < 25; index += 1) {
      recordOutcome(
        ledger,
        `imap:1:${String(index + 1)}`,
        { state: "too-large" },
        minutesAgo(index),
      );
    }
    getFakeRuntime().ledger = ledger;
    const result = await integrity({ instance: "ms-core" });
    expect(result.unaccounted).toHaveLength(20);
    expect(result.unaccounted[0]?.firstSeenAt).toBe(NOW.toISOString());
    expect(formatIntegrityResult(result)).toContain("too large to read");
  });

  it("excludes messages from days outside the shown period", async () => {
    const ledger = createLedger();
    recordOutcome(ledger, "imap:1:1", { state: "too-large" }, NOW);
    recordOutcome(ledger, "imap:1:2", { state: "too-large" }, daysAgo(3));
    getFakeRuntime().ledger = ledger;
    const result = await integrity({ instance: "ms-core", limit: "1" });
    expect(result.days).toHaveLength(1);
    expect(result.unaccounted).toHaveLength(1);
    expect(result.unaccounted[0]?.firstSeenAt).toBe(NOW.toISOString());
  });

  it("falls back to the raw state name and reports a counting defect", () => {
    const text = formatIntegrityResult({
      instanceId: "ms-core",
      coverage: "full",
      days: [
        {
          day: "2026-04-08",
          received: 3,
          checked: 1,
          notChecked: 1,
          inProgress: 0,
          countingDefect: 1,
        },
      ],
      unaccounted: [
        { firstSeenAt: NOW.toISOString(), state: "something-new" as LedgerEntry["state"] },
      ],
    });
    expect(text).toContain("Mail check (coverage: full).");
    expect(text).toContain(" Counts do not balance (difference 1).");
    expect(text).toContain("· something-new · never read");
  });

  it("labels refused and defaulted reviews", () => {
    const text = formatIntegrityResult({
      instanceId: "ms-core",
      coverage: "partial",
      days: [
        {
          day: "2026-04-08",
          received: 2,
          checked: 0,
          notChecked: 2,
          inProgress: 0,
          countingDefect: 0,
        },
      ],
      unaccounted: [
        { firstSeenAt: NOW.toISOString(), state: "no-verdict:refused" },
        { firstSeenAt: NOW.toISOString(), state: "no-verdict:defaulted" },
      ],
    });
    expect(text).toContain("not reviewed: the AI provider refused under the privacy routing");
    expect(text).toContain("not reviewed: the AI reply was incomplete");
  });

  it("lists only messages the day's equation counts, so the list matches the counts", async () => {
    const runtime = getFakeRuntime();
    const ledger = createLedger();
    // Recorded by the scan before the inventory's first run took its baseline.
    recordOutcome(ledger, "imap:7:4", { state: "read-failed", reason: "other" }, minutesAgo(90));
    ledger.inventory.baseline = { keySpace: "imap:7", throughUid: 4 };
    ledger.inventory.status = "available";
    const day = localDay(NOW);
    (ledger.days[day] as { inventoryRuns: number }).inventoryRuns = 1;
    // Listed by the inventory afterwards and still unaccounted.
    recordOutcome(ledger, "imap:7:5", { state: "too-large" }, minutesAgo(10));
    (ledger.entries["imap:7:5"] as LedgerEntry).inventoriedAt = minutesAgo(30).toISOString();
    (ledger.days[day] as { inventoried: number }).inventoried = 1;
    runtime.ledger = ledger;
    const result = await integrity({ instance: "ms-core" });
    expect(result.days[0]).toMatchObject({ day, received: 1, notChecked: 1 });
    expect(result.unaccounted.map((message) => message.state)).toEqual(["too-large"]);
  });
});
