import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getFakeRuntime, resetFakeRuntime } from "../__fixtures__/fake-runtime.js";
import { sampleRules } from "../__fixtures__/inputs.js";
import { createLedger, normalizeLedger } from "../ledger/ledger.js";
import { summarizeIntegrity } from "../ledger/reconcile.js";
import type { LlmResult, StoredAlert } from "../types.js";

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

const { flushDigestIfDue, scan } = await import("./scan.js");
const { createLlmRoutingRefusedError } = await import("../config/runtime.js");
const { normalizeLlmResult } = await import("../scoring/llm.js");

const FIXED_NOW = new Date("2026-04-08T12:00:00.000Z");

const makeLlm = (overrides: Partial<LlmResult> = {}): LlmResult => ({
  decisionRequired: true,
  financialRelevance: true,
  riskEscalation: false,
  confidence: 95,
  urgency: "high",
  reason: "clear invoice",
  deadlineDetected: true,
  amountDetected: true,
  suggestedZone: "red",
  ...overrides,
});

type Runtime = ReturnType<typeof getFakeRuntime>;

const summaryFor = (uid: number) => ({
  uid,
  size: 1000,
  messageId: `<m${String(uid)}@ex>`,
  from: ["Alice <alice@example.com>"],
  subject: `Invoice #${String(uid)}`,
});

/** A runtime whose search returns `uids` (in key space `uidValidity`) and reads them all. */
const setup = (uids: number[] = [10], uidValidity?: string): Runtime => {
  const runtime = getFakeRuntime();
  runtime.rules = sampleRules;
  runtime.searchMail = async () => ({
    messages: uids.map(summaryFor),
    ...(uidValidity === undefined ? {} : { uidValidity }),
  });
  runtime.readMail = async (selector: unknown) => ({
    message: {
      uid: Number(selector),
      messageId: `<m${String(selector)}@ex>`,
      from: ["Alice <alice@example.com>"],
      subject: `Invoice #${String(selector)}`,
      text: "Please pay $500 for invoice.",
      headers: [],
    },
  });
  runtime.classifyCandidate = async () => makeLlm();
  return runtime;
};

const entry = (runtime: Runtime, uid: number, uidValidity = "-") =>
  runtime.ledger.entries[`imap:${uidValidity}:${String(uid)}`];

/** Inventory results in the shape of the mail tool's `mail-inventory` command. */
const inventoryOf = (afterUid: number, uidRanges: Array<[number, number]>, uidValidity = "7") => ({
  protocol: "imap",
  uidValidity,
  afterUid,
  uidRanges,
});

describe("commands/scan > outcome ledger", () => {
  beforeEach(() => {
    resetFakeRuntime();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("outcome per message", () => {
    it("records a reviewer verdict for a red alert", async () => {
      const runtime = setup();
      await scan({ instance: "ms-core" });
      expect(entry(runtime, 10)).toMatchObject({
        state: "red",
        review: "reviewer",
        attempts: 1,
        firstSeenAt: FIXED_NOW.toISOString(),
        scannedAt: FIXED_NOW.toISOString(),
      });
    });

    it("records a reviewer verdict for an amber alert", async () => {
      const runtime = setup();
      runtime.classifyCandidate = async () =>
        makeLlm({ confidence: 60, urgency: "medium", suggestedZone: "amber" });
      await scan({ instance: "ms-core" });
      expect(entry(runtime, 10)).toMatchObject({ state: "amber", review: "reviewer" });
    });

    it("records a reviewer verdict for gray mail", async () => {
      const runtime = setup();
      runtime.policy.categoryPolicies.push({
        id: "min-conf",
        category: "financial-relevance",
        minConfidence: 99,
      });
      await scan({ instance: "ms-core" });
      expect(entry(runtime, 10)).toMatchObject({ state: "gray", review: "reviewer" });
    });

    it("records rules-only gray below the candidate threshold", async () => {
      const runtime = setup();
      runtime.rules = {
        ...sampleRules,
        senderWeights: {},
        domainWeights: {},
        rules: [],
        thresholds: { candidate: 10, alert: 10, category: 10 },
      };
      await scan({ instance: "ms-core" });
      expect(entry(runtime, 10)).toMatchObject({ state: "gray", review: "rules-only" });
    });

    it("records policy-skipped for a muted sender", async () => {
      const runtime = setup();
      runtime.policy.mutePolicies.push({ id: "m", match: "alice@example.com", reason: "x" });
      await scan({ instance: "ms-core" });
      expect(entry(runtime, 10)).toMatchObject({ state: "gray", review: "policy-skipped" });
    });

    it("records rules-only for bulk mail", async () => {
      const runtime = setup([11]);
      runtime.readMail = async () => ({
        message: {
          uid: 11,
          messageId: "<promo@ex>",
          from: ["Vendor <billing@promo.example>"],
          subject: "Invoice: your subscription renewal is due",
          text: `Pay $500 now for invoice. ${Array.from(
            { length: 10 },
            (_, index) => `https://promo.example/p${String(index)}`,
          ).join(" ")}`,
          headers: [{ key: "List-Unsubscribe", value: "<https://promo.example/unsub>" }],
        },
      });
      await scan({ instance: "ms-core" });
      expect(entry(runtime, 11)).toMatchObject({ state: "amber", review: "rules-only" });
    });

    it("counts a fallback amber as in progress (deferred for a re-review), alert unchanged", async () => {
      const runtime = setup();
      runtime.classifyCandidate = async () => {
        throw new Error("llm down");
      };
      const result = await scan({ instance: "ms-core" });
      expect(result.amberQueued).toBe(1);
      expect(runtime.state.alerts.at(-1)?.zone).toBe("amber");
      expect(entry(runtime, 10)).toMatchObject({ state: "deferred", reason: "review-retry" });
      expect(entry(runtime, 10)?.review).toBeUndefined();
      // Not listed as unchecked while the re-review is still open.
      expect(runtime.state.integrityDetails).toEqual({});
      expect(runtime.state.integrity?.days["2026-04-08"]).toMatchObject({
        states: { deferred: 1 },
        inFlight: 1,
      });
      expect(runtime.state.integrity?.days["2026-04-08"]).not.toHaveProperty("unaccounted");
    });

    it("counts a fallback gray without an alert as no-verdict:reviewer-unavailable", async () => {
      const runtime = setup([10, 11, 12]);
      runtime.policy.senderPolicies.push({
        id: "cap",
        match: "alice@example.com",
        maxZone: "gray",
        reason: "never alert",
      });
      runtime.classifyCandidate = async () => {
        throw new Error("llm down");
      };
      await scan({ instance: "ms-core" });
      expect(runtime.state.alerts).toEqual([]);
      expect(entry(runtime, 10)).toMatchObject({ state: "no-verdict:reviewer-unavailable" });
      // The breaker postponed the third one unsent.
      expect(entry(runtime, 12)).toMatchObject({
        state: "no-verdict:reviewer-unavailable",
        reason: "postponed",
        attempts: 0,
      });
      expect(runtime.state.integrityDetails?.["imap:-:10"]).toEqual({
        from: "Alice <alice@example.com>",
        subject: "Invoice #10",
      });
    });

    it("records no-verdict:refused for the refused and every later candidate", async () => {
      const runtime = setup([10, 11]);
      runtime.classifyCandidate = async () => {
        throw createLlmRoutingRefusedError("No endpoints found matching your data policy");
      };
      await scan({ instance: "ms-core" });
      expect(entry(runtime, 10)?.state).toBe("no-verdict:refused");
      expect(entry(runtime, 11)?.state).toBe("no-verdict:refused");
    });

    it("records no-verdict:defaulted for a reply that lacked confidence and zone", async () => {
      const runtime = setup();
      runtime.classifyCandidate = async () => normalizeLlmResult({});
      await scan({ instance: "ms-core" });
      expect(entry(runtime, 10)?.state).toBe("no-verdict:defaulted");
    });

    it("records read-failed with a timeout or other sub-cause and counts attempts", async () => {
      const runtime = setup([10, 11]);
      runtime.readMail = async (selector: unknown) => {
        throw new Error(
          Number(selector) === 10
            ? "imap-read-mail failed: killed by SIGKILL after 60000ms without completing"
            : "imap-read-mail failed: connection reset",
        );
      };
      await scan({ instance: "ms-core" });
      expect(entry(runtime, 10)).toMatchObject({
        state: "read-failed",
        reason: "timeout",
        attempts: 1,
      });
      expect(entry(runtime, 11)).toMatchObject({ state: "read-failed", reason: "other" });
      expect(runtime.state.integrityDetails?.["imap:-:11"]).toEqual({
        from: "Alice <alice@example.com>",
        subject: "Invoice #11",
      });
      // Both stay above the watermark, so the next scan reads them again.
      await scan({ instance: "ms-core" });
      expect(entry(runtime, 10)?.attempts).toBe(2);
    });

    it("records too-large with the search summary as detail", async () => {
      const runtime = setup();
      runtime.searchMail = async () => ({
        messages: [{ uid: 20, size: 10 * 1024 * 1024 }],
      });
      await scan({ instance: "ms-core" });
      expect(entry(runtime, 20)).toMatchObject({ state: "too-large", attempts: 0 });
      expect(runtime.state.integrityDetails?.["imap:-:20"]).toEqual({
        from: "(unknown sender)",
        subject: "(no subject)",
      });
    });

    it("records the messages left by an exhausted budget as deferred", async () => {
      const runtime = setup([10, 20, 30]);
      const classify = runtime.classifyCandidate;
      runtime.classifyCandidate = async (...args) => {
        vi.setSystemTime(new Date(FIXED_NOW.getTime() + 181_000));
        return classify(...args);
      };
      const result = await scan({ instance: "ms-core" });
      expect(result.deferredMessages).toBe(2);
      expect(entry(runtime, 10)?.state).toBe("red");
      expect(entry(runtime, 20)?.state).toBe("deferred");
      expect(entry(runtime, 30)?.state).toBe("deferred");
      expect(runtime.state.integrity?.inFlight).toBe(2);
    });
  });

  describe("duplicates of an already handled Message-ID", () => {
    const knownMessage = (alertId?: string) => ({
      key: "msg:<m10@ex>",
      uid: 3,
      subject: "existing",
      from: "Alice <alice@example.com>",
      snippet: "existing",
      firstSeenAt: "2026-04-07T00:00:00Z",
      lastSeenAt: "2026-04-07T00:00:00Z",
      ...(alertId === undefined ? {} : { alertId }),
    });
    const knownAlert: StoredAlert = {
      alertId: "known-1",
      zone: "amber",
      category: "financial-relevance",
      subject: "existing",
      from: "a@b",
      why: "w",
      sentAt: "2026-04-07T00:00:00Z",
    };

    it("inherits the known alert's zone", async () => {
      const runtime = setup();
      runtime.state.messages["msg:<m10@ex>"] = knownMessage("known-1");
      runtime.state.alerts.push(knownAlert);
      await scan({ instance: "ms-core" });
      expect(entry(runtime, 10)).toMatchObject({ state: "amber", review: "duplicate" });
    });

    it("falls back to gray when the known message raised no alert", async () => {
      const runtime = setup();
      runtime.state.messages["msg:<m10@ex>"] = knownMessage();
      await scan({ instance: "ms-core" });
      expect(entry(runtime, 10)).toMatchObject({ state: "gray", review: "duplicate" });
    });

    it("resolves a pending inventoried entry", async () => {
      const runtime = setup();
      runtime.state.messages["msg:<m10@ex>"] = knownMessage();
      runtime.ledger.entries["imap:-:10"] = {
        key: "imap:-:10",
        firstSeenAt: FIXED_NOW.toISOString(),
        state: "pending",
        attempts: 0,
        updatedAt: FIXED_NOW.toISOString(),
        inventoriedAt: FIXED_NOW.toISOString(),
      };
      await scan({ instance: "ms-core" });
      expect(entry(runtime, 10)).toMatchObject({ state: "gray", review: "duplicate" });
    });

    it("never overwrites an entry that already has a final state", async () => {
      const runtime = setup();
      runtime.state.messages["msg:<m10@ex>"] = knownMessage("known-1");
      runtime.state.alerts.push(knownAlert);
      runtime.ledger.entries["imap:-:10"] = {
        key: "imap:-:10",
        firstSeenAt: FIXED_NOW.toISOString(),
        state: "red",
        review: "reviewer",
        attempts: 1,
        updatedAt: FIXED_NOW.toISOString(),
      };
      await scan({ instance: "ms-core" });
      expect(entry(runtime, 10)).toMatchObject({ state: "red", review: "reviewer", attempts: 1 });
    });
  });

  describe("independent inventory", () => {
    it("reports partial coverage without a warning when the tool has no inventory", async () => {
      const runtime = setup();
      const result = await scan({ instance: "ms-core" });
      expect(result.warningCount).toBeUndefined();
      expect(runtime.state.integrity).toMatchObject({
        version: 1,
        coverage: "partial",
        inventory: "unsupported",
        residual: 0,
      });
      expect(runtime.state.integrity?.days["2026-04-08"]).toMatchObject({
        coverage: "partial",
        inventory: 1,
        states: { red: 1 },
      });
    });

    it("warns when the inventory fails", async () => {
      const runtime = setup();
      runtime.inventoryMail = async () => {
        throw new Error("mail-inventory failed: MAIL_INVENTORY_TIMEOUT");
      };
      const result = await scan({ instance: "ms-core" });
      expect(result.note).toBe(
        "Mail inventory failed (mail-inventory failed: MAIL_INVENTORY_TIMEOUT); coverage is partial.",
      );
      expect(runtime.state.integrity?.inventory).toBe("failed");
    });

    it("baselines the first run, then tracks arrivals until a scan resolves them", async () => {
      const runtime = setup([], "7");
      const inventory = vi.fn(
        async (_cursor?: unknown): Promise<unknown> => inventoryOf(0, [[1, 5]]),
      );
      runtime.inventoryMail = inventory;
      await scan({ instance: "ms-core" });
      expect(runtime.ledger.entries).toEqual({});
      expect(runtime.ledger.inventory.baseline).toEqual({ keySpace: "imap:7", throughUid: 5 });

      // Second tick: the inventory lists a new arrival before the search sees it.
      inventory.mockImplementationOnce(async () => inventoryOf(5, [[10, 10]]));
      runtime.searchMail = async () => {
        expect(runtime.ledger.entries["imap:7:10"]?.state).toBe("pending");
        return { messages: [summaryFor(10)], uidValidity: "7" };
      };
      await scan({ instance: "ms-core" });
      expect(inventory).toHaveBeenLastCalledWith({ afterUid: 5, uidValidity: "7" });
      expect(entry(runtime, 10, "7")).toMatchObject({
        state: "red",
        inventoriedAt: FIXED_NOW.toISOString(),
      });
      expect(runtime.state.integrity).toMatchObject({ coverage: "full", residual: 0 });
      expect(runtime.state.integrity?.days["2026-04-08"]).toMatchObject({
        coverage: "full",
        inventory: 1,
        states: { red: 1 },
      });
    });

    it("persists the inventory before the search runs", async () => {
      const runtime = setup();
      runtime.inventoryMail = async () => inventoryOf(0, [[1, 5]]);
      runtime.searchMail = async () => {
        throw new Error("search exploded");
      };
      await expect(scan({ instance: "ms-core" })).rejects.toThrow("search exploded");
      expect(runtime.ledger.inventory.cursor).toEqual({ keySpace: "imap:7", afterUid: 5 });
      // The failure path persists the integrity counts too.
      expect(runtime.state.integrity?.inventory).toBe("available");
    });

    it("marks an arrival no search returned within the grace period as not-returned", async () => {
      const runtime = setup([], "7");
      runtime.ledger = normalizeLedger({
        inventory: {
          status: "available",
          lastSuccessAt: FIXED_NOW.toISOString(),
          cursor: { keySpace: "imap:7", afterUid: 5 },
          baseline: { keySpace: "imap:7", throughUid: 5 },
        },
      });
      runtime.inventoryMail = async () => inventoryOf(5, [[12, 12]]);
      await scan({ instance: "ms-core" });
      expect(entry(runtime, 12, "7")?.state).toBe("pending");

      // 2 x 30m + 10m grace, plus a minute.
      vi.setSystemTime(new Date(FIXED_NOW.getTime() + 71 * 60 * 1000));
      runtime.inventoryMail = async () => inventoryOf(12, []);
      await scan({ instance: "ms-core" });
      expect(entry(runtime, 12, "7")?.state).toBe("not-returned");
    });

    it("notes a truncated search on the day and on the pending arrivals it cut", async () => {
      const runtime = setup([15], "7");
      runtime.ledger = normalizeLedger({
        inventory: {
          status: "available",
          lastSuccessAt: FIXED_NOW.toISOString(),
          cursor: { keySpace: "imap:7", afterUid: 5 },
        },
      });
      runtime.inventoryMail = async () => inventoryOf(5, [[12, 12]]);
      runtime.searchMail = async () => ({
        messages: [summaryFor(15)],
        uidValidity: "7",
        totalMatches: 5,
      });
      await scan({ instance: "ms-core" });
      expect(entry(runtime, 12, "7")?.reason).toBe("truncated");
      expect(runtime.ledger.days["2026-04-08"]?.flags).toContain("search-truncated");
    });

    it("treats a truncated search that returned nothing as cutting every pending arrival", async () => {
      const runtime = setup([], "7");
      runtime.ledger = normalizeLedger({
        inventory: {
          status: "available",
          lastSuccessAt: FIXED_NOW.toISOString(),
          cursor: { keySpace: "imap:7", afterUid: 5 },
        },
      });
      runtime.inventoryMail = async () => inventoryOf(5, [[12, 12]]);
      runtime.searchMail = async () => ({ messages: [], uidValidity: "7", totalMatches: 2 });
      await scan({ instance: "ms-core" });
      expect(entry(runtime, 12, "7")?.reason).toBe("truncated");
    });

    it("notes a pending arrival the search returned below the watermark", async () => {
      const runtime = setup([12], "7");
      runtime.state.mailbox.lastSeenUid = 20;
      runtime.state.mailbox.uidValidity = "7";
      runtime.ledger = normalizeLedger({
        inventory: {
          status: "available",
          lastSuccessAt: FIXED_NOW.toISOString(),
          cursor: { keySpace: "imap:7", afterUid: 5 },
        },
      });
      runtime.inventoryMail = async () => inventoryOf(5, [[12, 12]]);
      await scan({ instance: "ms-core" });
      expect(entry(runtime, 12, "7")).toMatchObject({
        state: "pending",
        reason: "below-watermark",
      });
    });

    it("flags a coverage break when the scan sees UIDVALIDITY change", async () => {
      const runtime = setup([10], "222");
      runtime.state.mailbox.uidValidity = "111";
      await scan({ instance: "ms-core" });
      expect(runtime.ledger.days["2026-04-08"]?.flags).toContain("coverage-break");
      expect(entry(runtime, 10, "222")?.state).toBe("red");
    });

    it("falls back to default durations when the configured ones are invalid", async () => {
      const runtime = setup();
      runtime.lookbackWindow = "whenever";
      runtime.pollInterval = "sometimes";
      await scan({ instance: "ms-core" });
      expect(entry(runtime, 10)?.state).toBe("red");
    });
  });

  describe("outage overlay", () => {
    it("marks mail first seen while classification was already degraded", async () => {
      const runtime = setup();
      runtime.state.degradationState = "classification-degraded";
      await scan({ instance: "ms-core" });
      expect(entry(runtime, 10)?.outageAffected).toBe(true);
      expect(runtime.state.integrity?.days["2026-04-08"]?.outageAffected).toBe(1);
    });

    it("marks mail first seen by a scan that ends degraded", async () => {
      const runtime = setup([10], "7");
      runtime.ledger = normalizeLedger({
        inventory: {
          status: "available",
          lastSuccessAt: FIXED_NOW.toISOString(),
          cursor: { keySpace: "imap:7", afterUid: 5 },
        },
      });
      runtime.inventoryMail = async () => inventoryOf(5, [[10, 11]]);
      runtime.classifyCandidate = async () => {
        throw new Error("llm down");
      };
      await scan({ instance: "ms-core" });
      expect(runtime.state.degradationState).toBe("classification-degraded");
      expect(entry(runtime, 10, "7")?.outageAffected).toBe(true);
      // Created by the inventory in the same scan, never returned yet.
      expect(entry(runtime, 11, "7")).toMatchObject({ state: "pending", outageAffected: true });
    });

    it("leaves mail seen during a healthy scan unmarked", async () => {
      const runtime = setup();
      await scan({ instance: "ms-core" });
      expect(entry(runtime, 10)?.outageAffected).toBeUndefined();
    });
  });

  describe("persistence", () => {
    it("persists the ledger and integrity counts when the scan fails", async () => {
      const runtime = setup();
      runtime.readMail = async () => {
        throw new Error("fetch failed");
      };
      runtime.sendMatrixRoomMessage = async () => undefined;
      // Fail after the per-message outcome was recorded.
      runtime.readRules = (() => {
        let calls = 0;
        return async () => {
          calls += 1;
          if (calls > 1) throw new Error("never");
          return sampleRules;
        };
      })();
      runtime.searchMail = async () => {
        throw new Error("search down");
      };
      await expect(scan({ instance: "ms-core" })).rejects.toThrow("search down");
      expect(runtime.state.integrity).toBeDefined();
      expect(runtime.ledger.inventory.status).toBe("unsupported");
    });

    it("never fails the scan when the ledger cannot be written", async () => {
      const runtime = setup();
      runtime.writeLedger = async () => {
        throw new Error("disk full");
      };
      const result = await scan({ instance: "ms-core" });
      expect(result.redAlertsSent).toBe(1);
      expect(result.note).toBe("Outcome ledger could not be written: disk full");
      expect(runtime.state.lastScanWarnings).toBe(1);
      expect(runtime.state.consecutiveFailures).toBe(0);
    });

    it("recomputes the same integrity counts from the persisted ledger after a restart", async () => {
      const runtime = setup([10, 11]);
      runtime.readMail = async (selector: unknown) => {
        if (Number(selector) === 11) throw new Error("connection reset");
        return {
          message: {
            uid: Number(selector),
            messageId: `<m${String(selector)}@ex>`,
            from: ["Alice <alice@example.com>"],
            subject: "Invoice",
            text: "Please pay $500 for invoice.",
            headers: [],
          },
        };
      };
      await scan({ instance: "ms-core" });
      runtime.searchMail = async () => ({
        messages: [summaryFor(10), summaryFor(11), summaryFor(12)],
      });
      await scan({ instance: "ms-core" });
      const persisted = normalizeLedger(JSON.parse(JSON.stringify(runtime.ledger)));
      const recomputed = summarizeIntegrity(persisted, new Date());
      expect(recomputed).toEqual(runtime.state.integrity);
      // 11 stays read-failed below the new watermark: counted, not hidden.
      expect(recomputed.days["2026-04-08"]).toEqual({
        coverage: "partial",
        inventory: 3,
        unaccounted: 1,
        states: { red: 2, "read-failed:other": 1 },
      });
      expect(recomputed.residual).toBe(0);
    });

    it("keeps integrity details only for messages still unaccounted for", async () => {
      const runtime = setup();
      runtime.readMail = async () => {
        throw new Error("fetch failed");
      };
      await scan({ instance: "ms-core" });
      expect(Object.keys(runtime.state.integrityDetails ?? {})).toEqual(["imap:-:10"]);
      setup();
      await scan({ instance: "ms-core" });
      expect(entry(runtime, 10)?.state).toBe("red");
      expect(runtime.state.integrityDetails).toEqual({});
    });
  });

  describe("daily unaccounted notice", () => {
    const failingReads = (runtime: Runtime): void => {
      runtime.readMail = async () => {
        throw new Error("fetch failed");
      };
    };
    const noticeBodies = (send: ReturnType<typeof vi.fn>): string[] =>
      send.mock.calls
        .map(([message]) => message as { body?: string } | string)
        .filter((message): message is { body: string } => typeof message !== "string")
        .map((message) => message.body)
        .filter((body) => body.includes('ask "integrity"'));

    it("sends one content-free notice per day and records it", async () => {
      const runtime = setup();
      failingReads(runtime);
      const send = vi.fn(async (_message: unknown) => undefined);
      runtime.sendMatrixRoomMessage = send;
      await scan({ instance: "ms-core" });
      const bodies = noticeBodies(send);
      expect(bodies).toEqual([
        'Mail Sentinel: 1 message received today could not be checked: 1 could not be read. Check them in your mail client, or ask "integrity" for details.',
      ]);
      expect(bodies[0]).not.toMatch(/invoice|alice|example\.com/iu);
      expect(runtime.ledger.notice).toEqual({
        reported: { "2026-04-08": 1 },
        lastSentDay: "2026-04-08",
      });

      // A second failure the same day does not repeat the notice.
      runtime.searchMail = async () => ({ messages: [summaryFor(10), summaryFor(11)] });
      await scan({ instance: "ms-core" });
      expect(noticeBodies(send)).toHaveLength(1);
    });

    it("keeps the notice queued when the send fails and delivers it on the next scan", async () => {
      const runtime = setup();
      failingReads(runtime);
      const send = vi
        .fn(async (_message: unknown) => undefined)
        .mockRejectedValueOnce(new Error("matrix down"));
      runtime.sendMatrixRoomMessage = send;
      await scan({ instance: "ms-core" });
      expect(runtime.ledger.notice.lastSentDay).toBeUndefined();
      await scan({ instance: "ms-core" });
      expect(noticeBodies(send)).toHaveLength(2);
      expect(runtime.ledger.notice.lastSentDay).toBe("2026-04-08");
    });
  });

  describe("digest coverage line", () => {
    const pendingAmberAlert: StoredAlert = {
      alertId: "p1",
      zone: "amber",
      category: "financial-relevance",
      subject: "p",
      from: "a@b",
      why: "w",
      sentAt: "2026-04-08T08:00:00Z",
    };
    const prepare = (): Runtime => {
      const runtime = getFakeRuntime();
      runtime.state.alerts.push(pendingAmberAlert);
      runtime.state.digest.pendingAmber.push("p1");
      runtime.state.digest.lastDigestAt = "2026-04-07T00:00:00Z";
      return runtime;
    };
    const sentBody = (send: ReturnType<typeof vi.fn>): string =>
      (send.mock.calls[0]?.[0] as { body: string }).body;

    it("adds the coverage line when a ledger is passed", async () => {
      const runtime = prepare();
      const send = vi.fn(async (_message: unknown) => undefined);
      runtime.sendMatrixRoomMessage = send;
      const ledger = createLedger();
      await flushDigestIfDue(runtime as never, runtime.state, FIXED_NOW.toISOString(), ledger);
      expect(sentBody(send)).toContain("Since the last digest: 0 mails, 0 checked.");
    });

    it("leaves the digest unchanged without a ledger", async () => {
      const runtime = prepare();
      const send = vi.fn(async (_message: unknown) => undefined);
      runtime.sendMatrixRoomMessage = send;
      await flushDigestIfDue(runtime as never, runtime.state, FIXED_NOW.toISOString());
      expect(sentBody(send)).not.toContain("Since the last digest");
    });
  });
});
