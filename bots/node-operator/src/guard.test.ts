import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireDiagnosticsSlot,
  CONCURRENT_RUN_EXPIRY_MS,
  CONCURRENT_TEXT,
  clearGuardState,
  RATE_LIMIT_MAX_RUNS,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMITED_TEXT,
  resolveGuardPath,
} from "./guard.js";

let tempRoot: string;
let guardPath: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "node-operator-guard-test-"));
  guardPath = join(tempRoot, "data", "guard.json");
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("resolveGuardPath", () => {
  it("prefers an absolute env override and ignores a relative one", () => {
    expect(resolveGuardPath({ NODE_OPERATOR_GUARD_PATH: "/x/guard.json" })).toBe("/x/guard.json");
    expect(resolveGuardPath({ NODE_OPERATOR_GUARD_PATH: "relative.json" }, "/ws/bin/bot.js")).toBe(
      "/ws/data/node-operator-guard.json",
    );
  });

  it("derives the workspace data path from the running binary", () => {
    expect(resolveGuardPath({}, "/var/lib/x/workspace/bin/node-operator.js")).toBe(
      "/var/lib/x/workspace/data/node-operator-guard.json",
    );
    expect(resolveGuardPath({}, undefined)).toContain("node-operator-guard.json");
    expect(resolveGuardPath({}, "")).toContain("node-operator-guard.json");
  });
});

describe("acquireDiagnosticsSlot", () => {
  it("grants, blocks a concurrent run, and grants again after release", async () => {
    const first = await acquireDiagnosticsSlot(guardPath, 1_000_000);
    expect(first.ok).toBe(true);

    const concurrent = await acquireDiagnosticsSlot(guardPath, 1_000_500);
    expect(concurrent).toEqual({ ok: false, reason: "concurrent" });

    if (first.ok) {
      await first.release();
    }
    const afterRelease = await acquireDiagnosticsSlot(guardPath, 1_001_000);
    expect(afterRelease.ok).toBe(true);
  });

  it("expires a crashed run instead of wedging the bot forever", async () => {
    const first = await acquireDiagnosticsSlot(guardPath, 1_000_000);
    expect(first.ok).toBe(true);
    // No release — simulate a crash. After the expiry window a new run
    // proceeds.
    const later = await acquireDiagnosticsSlot(guardPath, 1_000_000 + CONCURRENT_RUN_EXPIRY_MS + 1);
    expect(later.ok).toBe(true);
  });

  it("rate-limits after the bounded number of runs per window", async () => {
    let at = 2_000_000;
    for (let i = 0; i < RATE_LIMIT_MAX_RUNS; i += 1) {
      const slot = await acquireDiagnosticsSlot(guardPath, at);
      expect(slot.ok).toBe(true);
      if (slot.ok) {
        await slot.release();
      }
      at += 100;
    }
    const throttled = await acquireDiagnosticsSlot(guardPath, at);
    expect(throttled).toEqual({ ok: false, reason: "rate-limited" });

    // The window slides: after it passes, runs are granted again.
    const afterWindow = await acquireDiagnosticsSlot(guardPath, at + RATE_LIMIT_WINDOW_MS + 1);
    expect(afterWindow.ok).toBe(true);
  });

  it("treats corrupt or missing state as empty rather than blocking", async () => {
    await clearGuardState(guardPath);
    const missing = await acquireDiagnosticsSlot(guardPath, 3_000_000);
    expect(missing.ok).toBe(true);

    await writeFile(guardPath, "{not json", "utf8");
    const corrupt = await acquireDiagnosticsSlot(guardPath, 3_000_100);
    expect(corrupt.ok).toBe(true);

    await writeFile(
      guardPath,
      JSON.stringify({ runningSince: "nope", recentRuns: "nope" }),
      "utf8",
    );
    const wrongTypes = await acquireDiagnosticsSlot(guardPath, 3_000_200);
    expect(wrongTypes.ok).toBe(true);

    await writeFile(guardPath, "42", "utf8");
    expect((await acquireDiagnosticsSlot(guardPath, 3_000_300)).ok).toBe(true);
    await writeFile(guardPath, "null", "utf8");
    expect((await acquireDiagnosticsSlot(guardPath, 3_000_400)).ok).toBe(true);
  });

  it("clears existing guard state on demand", async () => {
    const slot = await acquireDiagnosticsSlot(guardPath, 6_000_000);
    expect(slot.ok).toBe(true);
    await clearGuardState(guardPath);
    // The in-flight marker is gone with the file: a new run is granted.
    expect((await acquireDiagnosticsSlot(guardPath, 6_000_100)).ok).toBe(true);
  });

  it("persists state as plain JSON without leaking anything else", async () => {
    const slot = await acquireDiagnosticsSlot(guardPath, 4_000_000);
    expect(slot.ok).toBe(true);
    const raw = await readFile(guardPath, "utf8");
    expect(Object.keys(JSON.parse(raw) as Record<string, unknown>).sort()).toEqual([
      "recentRuns",
      "runningSince",
    ]);
  });

  it("still grants when the guard path is unwritable — availability wins", async () => {
    const unwritable = join(tempRoot, "missing-parent-is-a-file", "guard.json");
    await writeFile(join(tempRoot, "missing-parent-is-a-file"), "occupied", "utf8");
    const slot = await acquireDiagnosticsSlot(unwritable, 5_000_000);
    expect(slot.ok).toBe(true);
    if (slot.ok) {
      await slot.release();
    }
  });
});

describe("guard copy", () => {
  it("carries no paths, secrets, or technical detail", () => {
    for (const text of [CONCURRENT_TEXT, RATE_LIMITED_TEXT]) {
      expect(text).not.toContain("/");
      expect(text).not.toMatch(/token|path|json/i);
    }
  });
});
