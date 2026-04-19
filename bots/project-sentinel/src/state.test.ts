import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDefaultUserPolicy,
  migrateState,
  normalizeUserPolicy,
  pruneState,
  readJsonFile,
  withLockedState,
  writeJsonFile,
} from "./state.js";

describe("project-sentinel/state", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("reads and writes JSON files", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "project-sentinel-state-"));
    const filePath = join(tempDir, "state.json");
    expect(await readJsonFile(filePath, { ok: false })).toEqual({ ok: false });
    await writeJsonFile(filePath, { ok: true });
    expect(await readJsonFile(filePath, { ok: false })).toEqual({ ok: true });
    expect(await readFile(filePath, "utf8")).toBe('{\n  "ok": true\n}\n');

    await writeFile(filePath, "{\n", "utf8");
    await expect(readJsonFile(filePath, { ok: false })).rejects.toThrow();
  });

  it("acquires the state lock and clears stale lock files", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "project-sentinel-state-"));
    const statePath = join(tempDir, "state.json");
    await expect(withLockedState(statePath, async () => 42)).resolves.toBe(42);
    await expect(stat(`${statePath}.lock`)).rejects.toThrow();

    await writeFile(`${statePath}.lock`, "busy\n", "utf8");
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(`${statePath}.lock`, old, old);
    await expect(withLockedState(statePath, async () => "stale-recovered")).resolves.toBe(
      "stale-recovered",
    );
  });

  it("times out when a fresh lock never clears", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "project-sentinel-state-"));
    const statePath = join(tempDir, "state.json");
    await writeFile(`${statePath}.lock`, "busy\n", "utf8");
    await expect(withLockedState(statePath, async () => "never")).rejects.toThrow(
      "Timed out while waiting for the state lock",
    );
  }, 15000);

  it("normalizes policy and trims stored state", () => {
    const policy = normalizeUserPolicy({
      sourceWeights: { a: 2 },
      laneWeights: { matrix: 3, bogus: 7 },
      sourceOverrides: { a: { minRoute: "red" }, b: { minRoute: "bogus" } },
      mutedFingerprints: ["fp-1", 7],
    });
    expect(policy).toEqual({
      version: 1,
      sourceWeights: { a: 2 },
      laneWeights: {
        matrix: 3,
        openclaw: 0,
        mail_stack: 0,
        ops_security: 0,
        local_first_ai: 0,
      },
      sourceOverrides: { a: { minRoute: "red" } },
      mutedFingerprints: ["fp-1"],
    });
    expect(normalizeUserPolicy({ mutedFingerprints: "nope" })).toEqual(
      expect.objectContaining({ mutedFingerprints: [] }),
    );

    const state = migrateState({
      version: 0,
      consecutiveFailures: 2,
      seenSignals: Object.fromEntries(
        Array.from({ length: 5005 }, (_, index) => [
          `fp-${String(index)}`,
          {
            fingerprint: `fp-${String(index)}`,
            contentFingerprint: `content-${String(index)}`,
            sourceId: "source",
            title: `Title ${String(index)}`,
            url: `https://example.com/${String(index)}`,
            publishedAt: "2026-04-17T00:00:00.000Z",
            updatedAt: "2026-04-17T00:00:00.000Z",
            lastSeenAt: `2026-04-17T00:00:${String(index).padStart(2, "0")}.000Z`,
          },
        ]),
      ),
      deliveredSignals: Array.from({ length: 1005 }, (_, index) => ({
        signalId: `sig-${String(index)}`,
        fingerprint: `fp-${String(index)}`,
        kind: "new-signal",
        route: "amber",
        lane: "ops_security",
        lanes: ["ops_security"],
        sourceId: "source",
        sourceName: "Source",
        sourceType: "rss",
        trustTier: "official",
        title: `Signal ${String(index)}`,
        url: `https://example.com/${String(index)}`,
        summary: "Summary",
        why: "Why",
        confidence: 80,
        score: 12,
        projectId: "sovereign-ai-node",
        publishedAt: "2026-04-17T00:00:00.000Z",
        updatedAt: "2026-04-17T00:00:00.000Z",
        sentAt: `2026-04-17T00:00:${String(index).padStart(2, "0")}.000Z`,
      })),
      feedback: Array.from({ length: 505 }, (_, index) => ({
        signalId: `sig-${String(index)}`,
        fingerprint: `fp-${String(index)}`,
        sourceId: "source",
        lane: "ops_security",
        action: "not-relevant",
        at: `2026-04-17T00:00:${String(index).padStart(2, "0")}.000Z`,
      })),
      digestQueue: Array.from({ length: 205 }, (_, index) => `sig-${String(index)}`),
      sourceStatus: {
        good: {
          lastScanAt: "2026-04-17T00:00:00.000Z",
          lastRedAt: "2026-04-17T00:00:00.000Z",
          consecutiveFailures: 3,
          lastError: "boom",
        },
        weird: { consecutiveFailures: "4" },
      },
    });
    const pruned = pruneState(state);
    expect(createDefaultUserPolicy().laneWeights.matrix).toBe(0);
    expect(pruned.version).toBe(1);
    expect(Object.keys(pruned.seenSignals)).toHaveLength(5000);
    expect(pruned.deliveredSignals).toHaveLength(1000);
    expect(pruned.feedback).toHaveLength(500);
    expect(pruned.digestQueue).toHaveLength(200);

    expect(
      migrateState({
        deliveredSignals: "nope",
        feedback: "nope",
        digestQueue: "nope",
        sourceStatus: { weird: { consecutiveFailures: "5" }, blank: {} },
      }),
    ).toEqual(
      expect.objectContaining({
        deliveredSignals: [],
        feedback: [],
        digestQueue: [],
        sourceStatus: { weird: { consecutiveFailures: 5 }, blank: { consecutiveFailures: 0 } },
      }),
    );
    expect(migrateState(undefined)).toEqual(
      expect.objectContaining({
        version: 1,
        digestQueue: [],
        sourceStatus: {},
      }),
    );
  });
});
