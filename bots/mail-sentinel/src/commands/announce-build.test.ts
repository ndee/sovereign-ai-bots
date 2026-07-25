import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BuildInfo } from "../build-info.js";
import {
  announceBuildIfChanged,
  buildIdentityPathFor,
  formatUpdateAnnouncement,
} from "./announce-build.js";

const COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const NOW = new Date("2026-07-25T14:32:00.000Z");

const makeInfo = (overrides: Partial<BuildInfo> = {}): BuildInfo => ({
  component: "mail-sentinel",
  version: "2.0.4-test.1",
  commit: COMMIT,
  releaseId: "2.9.2-test",
  buildTimestamp: "2026-07-25T09:15:00.000Z",
  ...overrides,
});

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
  JSON.parse(await readFile(buildIdentityPathFor(statePath), "utf8")) as Record<string, unknown>;

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "ms-announce-"));
  statePath = join(dir, "mail-sentinel-state.json");
  sent = [];
});

describe("commands/announce-build", () => {
  // A fresh install is not an update. Announcing here would post a spurious
  // "updated" notice to every new node.
  it("records the identity silently on first run without announcing", async () => {
    const runtime = makeRuntime();
    const outcome = await announceBuildIfChanged(runtime, makeInfo(), NOW);

    expect(outcome).toEqual({ announced: false, reason: "first-run-recorded" });
    expect(runtime.sendMatrixRoomMessage).not.toHaveBeenCalled();
    await expect(readRecord()).resolves.toMatchObject({
      announcedIdentity: `2.0.4-test.1+${COMMIT}+2.9.2-test`,
      announcedAt: "2026-07-25T14:32:00.000Z",
    });
  });

  it("does not announce again when the same build restarts", async () => {
    await announceBuildIfChanged(makeRuntime(), makeInfo(), NOW);
    const runtime = makeRuntime();

    const outcome = await announceBuildIfChanged(runtime, makeInfo(), NOW);

    expect(outcome).toEqual({ announced: false, reason: "unchanged" });
    expect(runtime.sendMatrixRoomMessage).not.toHaveBeenCalled();
  });

  it("announces when the version changed", async () => {
    await announceBuildIfChanged(makeRuntime(), makeInfo(), NOW);
    const runtime = makeRuntime();

    const outcome = await announceBuildIfChanged(runtime, makeInfo({ version: "2.0.5" }), NOW);

    expect(outcome).toEqual({ announced: true, reason: "announced" });
    expect(runtime.sendMatrixRoomMessage).toHaveBeenCalledTimes(1);
  });

  // Version alone is too weak: a rebuild at the same version is a different
  // build and an operator verifying an update must see it.
  it("announces when only the commit changed", async () => {
    await announceBuildIfChanged(makeRuntime(), makeInfo(), NOW);
    const runtime = makeRuntime();

    const outcome = await announceBuildIfChanged(
      runtime,
      makeInfo({ commit: "f".repeat(40) }),
      NOW,
    );

    expect(outcome.announced).toBe(true);
  });

  it("announces when only the release id changed", async () => {
    await announceBuildIfChanged(makeRuntime(), makeInfo(), NOW);
    const runtime = makeRuntime();

    const outcome = await announceBuildIfChanged(
      runtime,
      makeInfo({ releaseId: "2.9.3-test" }),
      NOW,
    );

    expect(outcome.announced).toBe(true);
  });

  it("persists the new identity only after Matrix accepted the message", async () => {
    await announceBuildIfChanged(makeRuntime(), makeInfo(), NOW);
    const later = new Date("2026-07-26T08:00:00.000Z");

    await announceBuildIfChanged(makeRuntime(), makeInfo({ version: "2.0.5" }), later);

    await expect(readRecord()).resolves.toMatchObject({
      announcedIdentity: `2.0.5+${COMMIT}+2.9.2-test`,
      announcedAt: "2026-07-26T08:00:00.000Z",
    });
  });

  it("does not mark the build announced when delivery fails", async () => {
    await announceBuildIfChanged(makeRuntime(), makeInfo(), NOW);
    const failing = makeRuntime(async () => {
      throw new Error("Failed to send Matrix room message (502)");
    });

    const outcome = await announceBuildIfChanged(failing, makeInfo({ version: "2.0.5" }), NOW);

    expect(outcome).toEqual({ announced: false, reason: "send-failed" });
    // Still the previous identity — so the next scan retries.
    await expect(readRecord()).resolves.toMatchObject({
      announcedIdentity: `2.0.4-test.1+${COMMIT}+2.9.2-test`,
    });
  });

  it("retries on the next run after a failed delivery", async () => {
    await announceBuildIfChanged(makeRuntime(), makeInfo(), NOW);
    await announceBuildIfChanged(
      makeRuntime(async () => {
        throw new Error("network down");
      }),
      makeInfo({ version: "2.0.5" }),
      NOW,
    );

    const recovered = makeRuntime();
    const outcome = await announceBuildIfChanged(recovered, makeInfo({ version: "2.0.5" }), NOW);

    expect(outcome.announced).toBe(true);
    expect(recovered.sendMatrixRoomMessage).toHaveBeenCalledTimes(1);
  });

  it("recovers from a corrupted record instead of wedging", async () => {
    await writeFile(buildIdentityPathFor(statePath), "{ this is not json", "utf8");
    const runtime = makeRuntime();

    const outcome = await announceBuildIfChanged(runtime, makeInfo(), NOW);

    // Unreadable == nothing announced yet, so it re-records rather than spamming.
    expect(outcome).toEqual({ announced: false, reason: "first-run-recorded" });
    await expect(readRecord()).resolves.toMatchObject({
      announcedIdentity: `2.0.4-test.1+${COMMIT}+2.9.2-test`,
    });
  });

  it("treats a record with a non-string identity as unannounced", async () => {
    await writeFile(
      buildIdentityPathFor(statePath),
      JSON.stringify({ announcedIdentity: 42 }),
      "utf8",
    );

    const outcome = await announceBuildIfChanged(makeRuntime(), makeInfo(), NOW);

    expect(outcome.reason).toBe("first-run-recorded");
  });

  // Concurrent oneshot scans must not both post the notice.
  it("announces only once when two runs race", async () => {
    await announceBuildIfChanged(makeRuntime(), makeInfo(), NOW);
    const a = makeRuntime();
    const b = makeRuntime();

    const outcomes = await Promise.all([
      announceBuildIfChanged(a, makeInfo({ version: "2.0.5" }), NOW),
      announceBuildIfChanged(b, makeInfo({ version: "2.0.5" }), NOW),
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
    await expect(announceBuildIfChanged(runtime, makeInfo(), NOW)).resolves.toEqual({
      announced: false,
      reason: "unchanged",
    });
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(runtime.sendMatrixRoomMessage).not.toHaveBeenCalled();
  });

  it("releases its lock so a later run can still announce", async () => {
    await announceBuildIfChanged(makeRuntime(), makeInfo(), NOW);
    const runtime = makeRuntime();

    await announceBuildIfChanged(runtime, makeInfo({ version: "2.0.5" }), NOW);
    const second = makeRuntime();
    const outcome = await announceBuildIfChanged(second, makeInfo({ version: "2.0.6" }), NOW);

    expect(outcome.announced).toBe(true);
  });

  describe("formatUpdateAnnouncement", () => {
    it("renders a calm notice with a shortened commit", () => {
      const message = formatUpdateAnnouncement(makeInfo());
      expect(message.body).toBe(
        [
          "Mail Sentinel updated",
          "",
          "Version: 2.0.4-test.1",
          "Release: 2.9.2-test",
          "Commit: a1b2c3d",
        ].join("\n"),
      );
      expect(message.formattedBody).toContain("<b>Mail Sentinel updated</b>");
    });

    it("escapes build values rather than injecting markup into the room", () => {
      const message = formatUpdateAnnouncement(
        makeInfo({ version: '<img src=x onerror="alert(1)">' }),
      );
      expect(message.formattedBody).not.toContain("<img");
      expect(message.formattedBody).toContain("&lt;img");
    });

    it("does not leak configuration or credentials", () => {
      const message = formatUpdateAnnouncement(makeInfo());
      expect(message.body).not.toMatch(/token|password|@|http|\//i);
    });
  });
});
