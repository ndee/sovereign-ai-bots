import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DegradationState } from "./degradation.js";
import {
  announceDegradationIfChanged,
  degradationNoticePathFor,
  formatDegradationNotice,
} from "./notice.js";

const NOW = new Date("2026-07-25T14:32:00.000Z");

let statePath: string;
let sent: unknown[];

const makeRuntime = (send?: () => Promise<void>) => ({
  statePath,
  sendMatrixRoomMessage: vi.fn(async (message: unknown) => {
    sent.push(message);
    if (send !== undefined) {
      await send();
    }
  }),
});

const readRecord = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(degradationNoticePathFor(statePath), "utf8")) as Record<
    string,
    unknown
  >;

/** Drive the node to a recorded state so the next call is a real transition. */
const settleAt = async (state: DegradationState): Promise<void> => {
  await announceDegradationIfChanged(makeRuntime(), state, NOW);
};

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "ms-degradation-"));
  statePath = join(dir, "mail-sentinel-state.json");
  sent = [];
});

describe("health/notice", () => {
  it("records a healthy baseline silently on a fresh node", async () => {
    const runtime = makeRuntime();

    const outcome = await announceDegradationIfChanged(runtime, "healthy", NOW);

    expect(outcome).toEqual({ announced: false, reason: "unchanged" });
    expect(runtime.sendMatrixRoomMessage).not.toHaveBeenCalled();
    await expect(readRecord()).resolves.toMatchObject({
      announcedState: "healthy",
      announcedAt: "2026-07-25T14:32:00.000Z",
    });
  });

  // A node whose very first observed scan is already broken still has to speak.
  it("announces immediately when the first observation is degraded", async () => {
    const runtime = makeRuntime();

    const outcome = await announceDegradationIfChanged(runtime, "classification-degraded", NOW);

    expect(outcome).toEqual({ announced: true, reason: "announced" });
    expect(runtime.sendMatrixRoomMessage).toHaveBeenCalledTimes(1);
  });

  it("announces the transition into classification-degraded", async () => {
    await settleAt("healthy");
    const runtime = makeRuntime();

    const outcome = await announceDegradationIfChanged(runtime, "classification-degraded", NOW);

    expect(outcome.announced).toBe(true);
    expect(runtime.sendMatrixRoomMessage).toHaveBeenCalledTimes(1);
  });

  it("announces the transition into scans-failing", async () => {
    await settleAt("healthy");
    const runtime = makeRuntime();

    const outcome = await announceDegradationIfChanged(runtime, "scans-failing", NOW);

    expect(outcome.announced).toBe(true);
  });

  it("announces an escalation from classification-degraded to scans-failing", async () => {
    await settleAt("classification-degraded");
    const runtime = makeRuntime();

    const outcome = await announceDegradationIfChanged(runtime, "scans-failing", NOW);

    expect(outcome.announced).toBe(true);
  });

  it("announces recovery back to healthy", async () => {
    await settleAt("scans-failing");
    const runtime = makeRuntime();

    const outcome = await announceDegradationIfChanged(runtime, "healthy", NOW);

    expect(outcome.announced).toBe(true);
    expect(sent.at(-1)).toMatchObject({ body: expect.stringContaining("back to normal") });
  });

  // Mail Sentinel is a oneshot on a timer. Re-announcing per scan would train
  // the operator to mute the room.
  it("does not re-announce while a degraded state holds", async () => {
    await settleAt("classification-degraded");
    const runtime = makeRuntime();

    const first = await announceDegradationIfChanged(runtime, "classification-degraded", NOW);
    const second = await announceDegradationIfChanged(runtime, "classification-degraded", NOW);

    expect(first).toEqual({ announced: false, reason: "unchanged" });
    expect(second).toEqual({ announced: false, reason: "unchanged" });
    expect(runtime.sendMatrixRoomMessage).not.toHaveBeenCalled();
  });

  it("does not re-announce while healthy holds", async () => {
    await settleAt("healthy");
    const runtime = makeRuntime();

    await announceDegradationIfChanged(runtime, "healthy", NOW);

    expect(runtime.sendMatrixRoomMessage).not.toHaveBeenCalled();
  });

  it("announces again after a full degrade → recover → degrade cycle", async () => {
    await settleAt("healthy");
    await settleAt("classification-degraded");
    await settleAt("healthy");
    const runtime = makeRuntime();

    const outcome = await announceDegradationIfChanged(runtime, "classification-degraded", NOW);

    expect(outcome.announced).toBe(true);
  });

  it("persists the new state only after Matrix accepted the message", async () => {
    await settleAt("healthy");
    const later = new Date("2026-07-26T08:00:00.000Z");

    await announceDegradationIfChanged(makeRuntime(), "scans-failing", later);

    await expect(readRecord()).resolves.toMatchObject({
      announcedState: "scans-failing",
      announcedAt: "2026-07-26T08:00:00.000Z",
    });
  });

  it("does not record the state when delivery fails", async () => {
    await settleAt("healthy");
    const failing = makeRuntime(async () => {
      throw new Error("Failed to send Matrix room message (502)");
    });

    const outcome = await announceDegradationIfChanged(failing, "scans-failing", NOW);

    expect(outcome).toEqual({ announced: false, reason: "send-failed" });
    // Still healthy on disk — so the next scan retries the warning.
    await expect(readRecord()).resolves.toMatchObject({ announcedState: "healthy" });
  });

  it("retries on the next run after a failed delivery", async () => {
    await settleAt("healthy");
    await announceDegradationIfChanged(
      makeRuntime(async () => {
        throw new Error("network down");
      }),
      "scans-failing",
      NOW,
    );

    const recovered = makeRuntime();
    const outcome = await announceDegradationIfChanged(recovered, "scans-failing", NOW);

    expect(outcome.announced).toBe(true);
    expect(recovered.sendMatrixRoomMessage).toHaveBeenCalledTimes(1);
  });

  it("recovers from a corrupted record instead of wedging", async () => {
    await writeFile(degradationNoticePathFor(statePath), "{ this is not json", "utf8");

    const outcome = await announceDegradationIfChanged(makeRuntime(), "scans-failing", NOW);

    // Unreadable == nothing announced yet, and a degraded first observation
    // still announces.
    expect(outcome.announced).toBe(true);
  });

  it("treats a record with a non-string state as unannounced", async () => {
    await writeFile(
      degradationNoticePathFor(statePath),
      JSON.stringify({ announcedState: 42 }),
      "utf8",
    );

    const outcome = await announceDegradationIfChanged(makeRuntime(), "healthy", NOW);

    expect(outcome).toEqual({ announced: false, reason: "unchanged" });
    await expect(readRecord()).resolves.toMatchObject({ announcedState: "healthy" });
  });

  // A future/garbage state string must not be trusted as a dedup baseline.
  it("treats an unknown state string as unannounced", async () => {
    await writeFile(
      degradationNoticePathFor(statePath),
      JSON.stringify({ announcedState: "quantum-degraded" }),
      "utf8",
    );

    const outcome = await announceDegradationIfChanged(makeRuntime(), "scans-failing", NOW);

    expect(outcome.announced).toBe(true);
  });

  // Concurrent oneshot scans must not both post the notice.
  it("announces only once when two runs race", async () => {
    await settleAt("healthy");
    const a = makeRuntime();
    const b = makeRuntime();

    const outcomes = await Promise.all([
      announceDegradationIfChanged(a, "scans-failing", NOW),
      announceDegradationIfChanged(b, "scans-failing", NOW),
    ]);

    expect(outcomes.filter((outcome) => outcome.announced)).toHaveLength(1);
    const totalSends =
      a.sendMatrixRoomMessage.mock.calls.length + b.sendMatrixRoomMessage.mock.calls.length;
    expect(totalSends).toBe(1);
  });

  // An unwritable data directory must fail fast, not inherit the state lock's
  // ~30s retry budget and stall the scan behind it.
  it("gives up immediately and never throws when the record is unwritable", async () => {
    const runtime = {
      statePath: "/proc/nonexistent/deep/state.json",
      sendMatrixRoomMessage: vi.fn(),
    };

    const startedAt = Date.now();
    await expect(announceDegradationIfChanged(runtime, "scans-failing", NOW)).resolves.toEqual({
      announced: false,
      reason: "unchanged",
    });
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(runtime.sendMatrixRoomMessage).not.toHaveBeenCalled();
  });

  it("releases its lock so a later run can still announce", async () => {
    await settleAt("healthy");
    await settleAt("classification-degraded");
    const second = makeRuntime();

    const outcome = await announceDegradationIfChanged(second, "scans-failing", NOW);

    expect(outcome.announced).toBe(true);
  });
});

describe("health/notice > formatDegradationNotice", () => {
  const states: DegradationState[] = ["healthy", "classification-degraded", "scans-failing"];

  it("carries the SAN-LLM-001 code and explains that mail still arrives", () => {
    const message = formatDegradationNotice("classification-degraded");
    expect(message.body).toContain("SAN-LLM-001");
    // The entire point of this state: it is NOT a mailbox failure.
    expect(message.body).toContain("still being retrieved");
    expect(message.body).toContain("not being escalated to red");
    expect(message.formattedBody).toContain("SAN-LLM-001");
  });

  it("carries the SAN-MAIL-001 code and says mail is not arriving", () => {
    const message = formatDegradationNotice("scans-failing");
    expect(message.body).toContain("SAN-MAIL-001");
    expect(message.body).toContain("not being retrieved");
    expect(message.formattedBody).toContain("SAN-MAIL-001");
  });

  it("renders recovery without an error code", () => {
    const message = formatDegradationNotice("healthy");
    expect(message.body).toContain("back to normal");
    expect(message.body).not.toMatch(/SAN-/u);
    expect(message.formattedBody).not.toMatch(/SAN-/u);
  });

  it("distinguishes the two failure codes from each other", () => {
    expect(formatDegradationNotice("classification-degraded").body).not.toContain("SAN-MAIL-001");
    expect(formatDegradationNotice("scans-failing").body).not.toContain("SAN-LLM-001");
  });

  it.each(states)("keeps the %s notice short enough for a Matrix room", (state) => {
    expect(formatDegradationNotice(state).body.length).toBeLessThanOrEqual(220);
  });

  // The notice fires exactly when something is wrong — which is exactly when a
  // "add some context" instinct would leak a subject line into the room.
  it.each(states)("never leaks mail content in the %s notice", (state) => {
    const message = formatDegradationNotice(state);
    for (const rendered of [message.body, message.formattedBody]) {
      expect(rendered).not.toContain("@");
      expect(rendered).not.toMatch(/subject|sender|snippet|from:|body/iu);
    }
  });
});
