import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getFakeRuntime, resetFakeRuntime } from "../__fixtures__/fake-runtime.js";
import { sampleRules } from "../__fixtures__/inputs.js";
import { localDay } from "../ledger/ledger.js";
import type { LlmCandidate, LlmResult, MailSentinelState, StoredAlert } from "../types.js";

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

const { scan } = await import("./scan.js");
const { createLlmRoutingRefusedError, LLM_REVIEW_FAILED_ERROR_CODE } = await import(
  "../config/runtime.js"
);

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FIRST = new Date("2026-04-08T12:00:00.000Z");
const at = (offsetMs: number): Date => new Date(FIRST.getTime() + offsetMs);
const TODAY = localDay(FIRST);

type Runtime = ReturnType<typeof getFakeRuntime>;
type Reply = LlmResult | Error;

const makeLlm = (overrides: Partial<LlmResult> = {}): LlmResult => ({
  decisionRequired: true,
  financialRelevance: true,
  riskEscalation: false,
  confidence: 95,
  urgency: "high",
  reason: "Payment is overdue and the account may be suspended.",
  deadlineDetected: true,
  amountDetected: true,
  suggestedZone: "red",
  ...overrides,
});
const RED = makeLlm();
const AMBER = makeLlm({
  suggestedZone: "amber",
  confidence: 60,
  urgency: "low",
  reason: "An invoice is open.",
});
const GRAY = makeLlm({ suggestedZone: "gray", confidence: 80, urgency: "low", reason: "Receipt." });

/** A review that failed the way the runtime reports it: every call with its reason. */
const reviewFailed = (reason = "timeout"): Error =>
  Object.assign(new Error(`review call ${reason}`), {
    code: LLM_REVIEW_FAILED_ERROR_CODE,
    reviewAttempts: [{ reason, elapsedMs: 75_000, message: `review call ${reason}` }],
  });

interface Harness {
  runtime: Runtime;
  /** Every mail the search returns, ascending. */
  mailbox: number[];
  /** Next replies, in call order; `fallback` once they run out. */
  replies: Reply[];
  fallback: { current: Reply };
  /** Subjects the reviewer was asked about, per call. */
  calls: string[];
  candidates: LlmCandidate[];
  sent: string[];
}

const setup = (uids: number[] = [10]): Harness => {
  const runtime = getFakeRuntime();
  runtime.rules = sampleRules;
  const harness: Harness = {
    runtime,
    mailbox: [...uids],
    replies: [],
    fallback: { current: reviewFailed() },
    calls: [],
    candidates: [],
    sent: [],
  };
  runtime.searchMail = async () => ({
    messages: harness.mailbox.map((uid) => ({
      uid,
      size: 1000,
      messageId: `<m${String(uid)}@ex>`,
      from: ["Alice <alice@example.com>"],
      subject: `Invoice #${String(uid)}`,
    })),
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
  runtime.classifyCandidate = async (candidate: LlmCandidate) => {
    harness.calls.push(candidate.subject);
    harness.candidates.push(structuredClone(candidate));
    const reply = harness.replies.shift() ?? harness.fallback.current;
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  };
  runtime.sendMatrixRoomMessage = async (message) => {
    harness.sent.push(typeof message === "string" ? message : message.body);
  };
  return harness;
};

const scanAt = async (offsetMs: number) => {
  vi.setSystemTime(at(offsetMs));
  return scan({ instance: "ms-core" });
};

const alertFor = (runtime: Runtime, uid: number): StoredAlert =>
  runtime.state.alerts.find((alert) => alert.uid === uid) as StoredAlert;
const entry = (runtime: Runtime, uid: number) => runtime.ledger.entries[`imap:-:${String(uid)}`];
const redMessages = (harness: Harness): string[] =>
  harness.sent.filter((body) => body.startsWith("🔴"));
/** Red alerts and digests; degradation and integrity notices are not alerts. */
const alertMessages = (harness: Harness): string[] =>
  harness.sent.filter((body) => body.startsWith("🔴") || body.includes("AMBER DIGEST"));

/** Scans every 30 minutes from `fromMs` through `toMs`, inclusive. */
const scanEvery30Minutes = async (fromMs: number, toMs: number) => {
  const results = [];
  for (let offset = fromMs; offset <= toMs; offset += 30 * MINUTE) {
    results.push({ offset, result: await scanAt(offset) });
  }
  return results;
};

describe("commands/scan > re-review on later scans", () => {
  beforeEach(() => {
    resetFakeRuntime();
    vi.useFakeTimers();
    vi.setSystemTime(FIRST);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reviews a mail again after an outage and turns the same alert red with one late message", async () => {
    const harness = setup([10]);
    const { runtime } = harness;
    await scanAt(0);
    const fallback = alertFor(runtime, 10);
    const { alertId, shortRef } = fallback;
    expect(fallback).toMatchObject({ zone: "amber", confidence: null, llmResult: null });
    expect(fallback.review).toMatchObject({
      status: "retrying",
      attempts: 1,
      lastReason: "timeout",
    });
    expect(runtime.state.digest.pendingAmber).toEqual([alertId]);
    expect(entry(runtime, 10)).toMatchObject({
      state: "deferred",
      reason: "review-retry",
      attempts: 1,
    });
    // In progress, not "not checked", while the retry is open.
    expect(runtime.state.integrity).toMatchObject({ unaccounted: 0, inFlight: 1 });
    expect(runtime.state.integrityDetails).toEqual({});

    harness.replies.push(RED);
    const result = await scanAt(30 * MINUTE);
    expect(harness.calls).toEqual(["Invoice #10", "Invoice #10"]);
    // The same minimised payload goes out again.
    expect(harness.candidates[1]).toEqual(harness.candidates[0]);
    expect(runtime.state.alerts).toHaveLength(1);
    const late = alertFor(runtime, 10);
    expect(late).toMatchObject({ alertId, shortRef, zone: "red", confidence: 95, llmResult: RED });
    expect(late.review).toMatchObject({ status: "reviewed", attempts: 2 });
    expect(runtime.state.digest.pendingAmber).toEqual([]);
    expect(redMessages(harness)).toHaveLength(1);
    expect(redMessages(harness)[0]).toContain(`[${shortRef as string}]`);
    expect(redMessages(harness)[0]).toContain(" · late");
    expect(result.redAlertsSent).toBe(1);
    expect(entry(runtime, 10)).toMatchObject({
      state: "red",
      review: "reviewer",
      reason: "late",
      attempts: 2,
    });
    expect(runtime.state.integrity).toMatchObject({ unaccounted: 0, inFlight: 0 });
    expect(runtime.state.integrity?.days[TODAY]).toMatchObject({
      states: { red: 1 },
      lateVerdicts: 1,
    });

    await scanAt(90 * MINUTE);
    expect(harness.calls).toHaveLength(2);
    expect(redMessages(harness)).toHaveLength(1);
  });

  it("stops after 6 attempts within 12 h and leaves the mail visibly not reviewed", async () => {
    const harness = setup([10]);
    const { runtime } = harness;
    const scans = await scanEvery30Minutes(0, 13 * HOUR);
    const attemptTimes = scans
      .filter(({ result }) => result.warningCount !== undefined)
      .map(({ offset }) => offset / HOUR);
    expect(attemptTimes).toEqual([0, 0.5, 1.5, 3.5, 7.5, 11.5]);
    expect(harness.calls).toHaveLength(6);
    // One warning names the exhaustion, in the scan that used the last attempt.
    expect(scans.find(({ offset }) => offset === 11.5 * HOUR)?.result.warningCount).toBe(2);
    const fallback = alertFor(runtime, 10);
    expect(fallback.zone).toBe("amber");
    expect(fallback.review).toMatchObject({ status: "exhausted", attempts: 6 });
    expect(entry(runtime, 10)).toMatchObject({
      state: "no-verdict:reviewer-unavailable",
      reason: "retries-exhausted",
      attempts: 6,
    });
    expect(runtime.state.integrity).toMatchObject({ unaccounted: 1, inFlight: 0 });
    expect(Object.values(runtime.state.integrityDetails ?? {})).toEqual([
      { from: "Alice <alice@example.com>", subject: "Invoice #10" },
    ]);
  });

  it("ends the retry window after 12 h even with attempts left", async () => {
    const harness = setup([10]);
    await scanAt(0);
    await scanAt(30 * MINUTE);
    await scanAt(12 * HOUR + 30 * MINUTE);
    expect(harness.calls).toHaveLength(2);
    expect(alertFor(harness.runtime, 10).review).toMatchObject({
      status: "exhausted",
      attempts: 2,
    });
    expect(entry(harness.runtime, 10)).toMatchObject({
      state: "no-verdict:reviewer-unavailable",
      reason: "retries-exhausted",
    });
  });

  it("re-reviews at most 5 mails per scan, oldest first, after the new mail", async () => {
    const harness = setup([10, 11, 12, 13, 14, 15, 16]);
    await scanAt(0);
    // Two reviews failed, then the breaker postponed the other five unsent.
    expect(harness.calls).toEqual(["Invoice #10", "Invoice #11"]);
    expect(alertFor(harness.runtime, 12).review).toMatchObject({
      status: "retrying",
      attempts: 0,
      lastReason: "postponed",
    });
    expect(entry(harness.runtime, 12)).toMatchObject({ state: "deferred", attempts: 0 });

    harness.calls.length = 0;
    harness.mailbox.push(20);
    harness.fallback.current = AMBER;
    await scanAt(30 * MINUTE);
    expect(harness.calls).toEqual([
      "Invoice #20",
      "Invoice #10",
      "Invoice #11",
      "Invoice #12",
      "Invoice #13",
      "Invoice #14",
    ]);
    expect(alertFor(harness.runtime, 15).review).toMatchObject({ status: "retrying", attempts: 0 });
    expect(entry(harness.runtime, 12)).toMatchObject({ state: "amber", attempts: 1 });

    harness.calls.length = 0;
    await scanAt(60 * MINUTE);
    expect(harness.calls).toEqual(["Invoice #15", "Invoice #16"]);
  });

  it("keeps the breaker across the new mail and the re-review pass", async () => {
    const harness = setup([10, 11, 12]);
    await scanAt(0);
    harness.calls.length = 0;
    harness.mailbox.push(20);
    await scanAt(30 * MINUTE);
    // New mail fails, the first re-review fails, then nothing more is sent.
    expect(harness.calls).toEqual(["Invoice #20", "Invoice #10"]);
    expect(alertFor(harness.runtime, 10).review).toMatchObject({ attempts: 2 });
    expect(alertFor(harness.runtime, 11).review).toMatchObject({ attempts: 1 });
    expect(alertFor(harness.runtime, 12).review).toMatchObject({ attempts: 0 });
  });

  it("starts no re-review after the scan budget is spent", async () => {
    const harness = setup([10]);
    await scanAt(0);
    harness.calls.length = 0;
    harness.mailbox.push(20);
    const read = harness.runtime.readMail;
    harness.runtime.readMail = async (selector) => {
      vi.setSystemTime(Date.now() + 181_000);
      return read(selector);
    };
    harness.fallback.current = RED;
    await scanAt(30 * MINUTE);
    expect(harness.calls).toEqual([]);
    expect(alertFor(harness.runtime, 10).review).toMatchObject({
      status: "retrying",
      attempts: 1,
    });
  });

  it("clears classification-degraded once a re-review returns a verdict", async () => {
    const harness = setup([10]);
    await scanAt(0);
    expect(harness.runtime.state.degradationState).toBe("classification-degraded");
    harness.replies.push(AMBER);
    await scanAt(30 * MINUTE);
    expect(harness.runtime.state).toMatchObject({
      lastScanCandidates: 1,
      lastScanLlmFailures: 0,
      degradationState: "healthy",
    });
  });

  describe("eligibility", () => {
    it("never re-reviews an alert the operator already gave feedback on", async () => {
      const harness = setup([10]);
      await scanAt(0);
      alertFor(harness.runtime, 10).feedbackState = "important";
      harness.fallback.current = RED;
      await scanAt(30 * MINUTE);
      expect(harness.calls).toHaveLength(1);
      expect(alertFor(harness.runtime, 10).review).toMatchObject({ status: "stopped" });
      expect(entry(harness.runtime, 10)).toMatchObject({
        state: "no-verdict:reviewer-unavailable",
        reason: "operator-feedback",
      });
      expect(redMessages(harness)).toEqual([]);
    });

    it("never re-reviews a routing refusal", async () => {
      const harness = setup([10]);
      harness.fallback.current = createLlmRoutingRefusedError("No endpoints found");
      await scanAt(0);
      expect(alertFor(harness.runtime, 10).review).toBeUndefined();
      harness.fallback.current = RED;
      await scanAt(30 * MINUTE);
      expect(harness.calls).toHaveLength(1);
      expect(entry(harness.runtime, 10)?.state).toBe("no-verdict:refused");
    });

    it("stops re-reviewing once the provider refuses the re-review", async () => {
      const harness = setup([10]);
      await scanAt(0);
      harness.fallback.current = createLlmRoutingRefusedError("No endpoints found");
      await scanAt(30 * MINUTE);
      expect(alertFor(harness.runtime, 10).review).toMatchObject({ status: "stopped" });
      expect(entry(harness.runtime, 10)?.state).toBe("no-verdict:refused");
      harness.fallback.current = RED;
      await scanAt(2 * HOUR);
      expect(harness.calls).toHaveLength(2);
    });

    it("never opens a retry for bulk or muted mail", async () => {
      // UID 10 comes from a muted sender, UID 11 is a newsletter.
      const harness = setup([10, 11]);
      harness.runtime.policy.mutePolicies.push({
        id: "m",
        match: "alice@example.com",
        reason: "x",
      });
      harness.runtime.readMail = async (selector: unknown) => ({
        message: {
          uid: Number(selector),
          messageId: `<m${String(selector)}@ex>`,
          from: [
            Number(selector) === 10
              ? "Alice <alice@example.com>"
              : "Vendor <billing@promo.example>",
          ],
          subject: "Invoice: your subscription renewal is due",
          text: `Pay $500 now for invoice. ${Array.from(
            { length: 10 },
            (_, index) => `https://promo.example/p${String(index)}`,
          ).join(" ")}`,
          headers: [{ key: "List-Unsubscribe", value: "<https://promo.example/unsub>" }],
        },
      });
      await scanAt(0);
      await scanAt(30 * MINUTE);
      expect(harness.calls).toEqual([]);
      expect(harness.runtime.state.alerts.every((alert) => alert.review === undefined)).toBe(true);
    });

    it("finalizes a stuck review retry whose alert is gone once its window has passed", async () => {
      const harness = setup([]);
      harness.runtime.ledger.entries["imap:-:99"] = {
        key: "imap:-:99",
        firstSeenAt: at(-13 * HOUR).toISOString(),
        scannedAt: at(-13 * HOUR).toISOString(),
        updatedAt: at(-13 * HOUR).toISOString(),
        state: "deferred",
        reason: "review-retry",
        attempts: 3,
      };
      await scanAt(0);
      expect(harness.runtime.ledger.entries["imap:-:99"]).toMatchObject({
        state: "no-verdict:reviewer-unavailable",
        reason: "retries-exhausted",
      });
    });
  });

  describe("a late verdict and the digest", () => {
    const sendDigestWithTheFirstScan = (runtime: Runtime) => {
      runtime.state.digest.lastDigestAt = at(-13 * HOUR).toISOString();
    };

    it("sends one late red message when the digest already went out", async () => {
      const harness = setup([10]);
      sendDigestWithTheFirstScan(harness.runtime);
      await scanAt(0);
      expect(harness.sent.filter((body) => body.includes("AMBER DIGEST"))).toHaveLength(1);
      harness.replies.push(RED);
      await scanAt(30 * MINUTE);
      expect(redMessages(harness)).toHaveLength(1);
      expect(alertFor(harness.runtime, 10).zone).toBe("red");
    });

    it("updates an amber verdict in place and keeps it queued, sending nothing", async () => {
      const harness = setup([10]);
      await scanAt(0);
      const { alertId } = alertFor(harness.runtime, 10);
      harness.replies.push(AMBER);
      await scanAt(30 * MINUTE);
      expect(alertMessages(harness)).toEqual([]);
      expect(alertFor(harness.runtime, 10)).toMatchObject({
        zone: "amber",
        confidence: 60,
        why: "An invoice is open.",
      });
      expect(harness.runtime.state.digest.pendingAmber).toEqual([alertId]);
      expect(entry(harness.runtime, 10)).toMatchObject({ state: "amber", reason: "late" });
    });

    it("updates an amber verdict in place after the digest, without queueing it again", async () => {
      const harness = setup([10]);
      sendDigestWithTheFirstScan(harness.runtime);
      await scanAt(0);
      harness.sent.length = 0;
      harness.replies.push(AMBER);
      await scanAt(30 * MINUTE);
      expect(alertMessages(harness)).toEqual([]);
      expect(harness.runtime.state.digest.pendingAmber).toEqual([]);
      expect(alertFor(harness.runtime, 10).confidence).toBe(60);
    });

    it.each([
      ["before", false],
      ["after", true],
    ])("downgrades to gray silently %s the digest", async (_label, digestSent) => {
      const harness = setup([10]);
      harness.runtime.policy.categoryPolicies.push({
        id: "c",
        category: "financial-relevance",
        minConfidence: 90,
        reason: "only sure money mail",
      });
      if (digestSent) {
        sendDigestWithTheFirstScan(harness.runtime);
      }
      await scanAt(0);
      harness.sent.length = 0;
      harness.replies.push(GRAY);
      await scanAt(30 * MINUTE);
      expect(alertMessages(harness)).toEqual([]);
      expect(alertFor(harness.runtime, 10).zone).toBe("gray");
      expect(harness.runtime.state.digest.pendingAmber).toEqual([]);
      expect(entry(harness.runtime, 10)).toMatchObject({ state: "gray", reason: "late" });
    });
  });

  describe("crash and interrupt safety", () => {
    /** State that lives only in what was written, as after a process restart. */
    const persistState = (runtime: Runtime) => {
      const disk: { state: MailSentinelState; crashed: boolean } = {
        state: structuredClone(runtime.state),
        crashed: false,
      };
      runtime.readState = async () => structuredClone(disk.state);
      runtime.writeState = async (state) => {
        if (disk.crashed) {
          throw new Error("process killed");
        }
        disk.state = structuredClone(state);
      };
      return disk;
    };

    it("persists the attempt before the call", async () => {
      const harness = setup([10]);
      const disk = persistState(harness.runtime);
      await scanAt(0);
      const attemptsOnDisk: unknown[] = [];
      harness.runtime.classifyCandidate = async () => {
        attemptsOnDisk.push(disk.state.alerts[0]?.review?.attempts);
        throw reviewFailed();
      };
      await scanAt(30 * MINUTE);
      expect(attemptsOnDisk).toEqual([2]);
    });

    it("keeps the counted attempt when the scan is interrupted during a re-review", async () => {
      const harness = setup([10]);
      await scanAt(0);
      harness.runtime.classifyCandidate = async () => {
        process.emit("SIGTERM", "SIGTERM");
        await Promise.resolve();
        throw reviewFailed();
      };
      await expect(scanAt(30 * MINUTE)).rejects.toThrow("interrupted by SIGTERM");
      expect(alertFor(harness.runtime, 10).review).toMatchObject({
        status: "retrying",
        attempts: 2,
        lastAttemptAt: at(30 * MINUTE).toISOString(),
      });
    });

    it("repeats the late red message at most once after a crash between send and state write", async () => {
      const harness = setup([10]);
      const disk = persistState(harness.runtime);
      await scanAt(0);
      harness.fallback.current = RED;
      harness.runtime.sendMatrixRoomMessage = async (message) => {
        const body = typeof message === "string" ? message : message.body;
        harness.sent.push(body);
        if (body.startsWith("🔴") && redMessages(harness).length === 1) {
          disk.crashed = true;
        }
      };
      await expect(scanAt(30 * MINUTE)).rejects.toThrow("process killed");
      disk.crashed = false;
      await scanEvery30Minutes(HOUR, 6 * HOUR);
      expect(redMessages(harness)).toHaveLength(2);
      expect(disk.state.alerts[0]?.review).toMatchObject({ status: "reviewed", attempts: 3 });
    });
  });

  describe("recovery pass after the window", () => {
    /** Runs a 13-hour outage that leaves UID 10 exhausted. */
    const exhaust = async (harness: Harness) => {
      await scanEvery30Minutes(0, 13 * HOUR);
      expect(alertFor(harness.runtime, 10).review).toMatchObject({ status: "exhausted" });
      harness.calls.length = 0;
    };

    it("gives exhausted mail one recovery attempt in the first scan with a real verdict", async () => {
      const harness = setup([10]);
      await exhaust(harness);
      harness.mailbox.push(20);
      harness.fallback.current = RED;
      await scanAt(13.5 * HOUR);
      expect(harness.calls).toEqual(["Invoice #20", "Invoice #10"]);
      expect(alertFor(harness.runtime, 10)).toMatchObject({ zone: "red" });
      expect(alertFor(harness.runtime, 10).review).toMatchObject({
        status: "reviewed",
        attempts: 7,
        recoveryAttempted: true,
      });
      expect(entry(harness.runtime, 10)).toMatchObject({
        state: "red",
        reason: "late",
        attempts: 7,
      });
      const lateRed = redMessages(harness).filter((body) => body.includes("Invoice #10"));
      expect(lateRed).toHaveLength(1);
      harness.mailbox.push(21);
      await scanAt(14 * HOUR);
      expect(harness.calls).toEqual(["Invoice #20", "Invoice #10", "Invoice #21"]);
    });

    it("spends the recovery attempt only once, even when it fails", async () => {
      const harness = setup([10]);
      await exhaust(harness);
      harness.mailbox.push(20);
      harness.replies.push(AMBER, reviewFailed("connection"));
      await scanAt(13.5 * HOUR);
      expect(harness.calls).toEqual(["Invoice #20", "Invoice #10"]);
      expect(entry(harness.runtime, 10)).toMatchObject({
        state: "no-verdict:reviewer-unavailable",
        reason: "recovery-failed",
        attempts: 7,
      });
      harness.mailbox.push(21);
      harness.fallback.current = AMBER;
      await scanAt(14 * HOUR);
      await scanAt(20 * HOUR);
      expect(harness.calls).toEqual(["Invoice #20", "Invoice #10", "Invoice #21"]);
      expect(alertFor(harness.runtime, 10).review).toMatchObject({
        status: "exhausted",
        recoveryAttempted: true,
        lastReason: "connection",
      });
    });

    it("makes no recovery call into an outage", async () => {
      const harness = setup([10]);
      await exhaust(harness);
      await scanAt(13.5 * HOUR);
      expect(harness.calls).toEqual([]);
      harness.mailbox.push(20);
      await scanAt(14 * HOUR);
      expect(harness.calls).toEqual(["Invoice #20"]);
      expect(alertFor(harness.runtime, 10).review?.recoveryAttempted).toBeUndefined();
    });

    it("recovers in the same scan once a re-review returns a verdict", async () => {
      const harness = setup([10]);
      await exhaust(harness);
      harness.mailbox.push(20);
      await scanAt(13.5 * HOUR);
      harness.calls.length = 0;
      harness.fallback.current = AMBER;
      await scanAt(14 * HOUR);
      expect(harness.calls).toEqual(["Invoice #20", "Invoice #10"]);
    });

    it("leaves mail older than 7 days as it is", async () => {
      const harness = setup([10]);
      await exhaust(harness);
      harness.mailbox.push(20);
      harness.fallback.current = AMBER;
      await scanAt(7 * DAY + 1);
      expect(harness.calls).toEqual(["Invoice #20"]);
      expect(entry(harness.runtime, 10)).toMatchObject({
        state: "no-verdict:reviewer-unavailable",
        reason: "retries-exhausted",
      });
    });
  });
});
