import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MAX_STORED_CHECKINS, MAX_STORED_STEPS } from "./constants.js";
import {
  createDefaultState,
  migrateState,
  pruneState,
  readJsonFile,
  writeJsonFile,
} from "./state.js";
import type { ActionStep, AlignmentCheckin } from "./types.js";

describe("reality-alignment/state", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("reads and writes JSON files atomically", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reality-alignment-state-"));
    const filePath = join(tempDir, "state.json");
    expect(await readJsonFile(filePath, { ok: false })).toEqual({ ok: false });
    await writeJsonFile(filePath, { ok: true });
    expect(await readJsonFile(filePath, { ok: false })).toEqual({ ok: true });
    expect(await readFile(filePath, "utf8")).toBe('{\n  "ok": true\n}\n');

    await writeFile(filePath, "{\n", "utf8");
    await expect(readJsonFile(filePath, { ok: false })).rejects.toThrow();
  });

  it("rethrows non-ENOENT read errors", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reality-alignment-state-"));
    await expect(readJsonFile(tempDir, { ok: false })).rejects.toThrow();
  });

  it("creates default state and migrates partial documents", () => {
    expect(createDefaultState()).toEqual({
      version: 1,
      wishes: [],
      checkins: [],
      resistance: [],
      steps: [],
    });
    expect(migrateState(undefined)).toEqual(createDefaultState());
    expect(
      migrateState({
        wishes: "not-an-array",
        checkins: [{ id: "c1" }],
        resistance: undefined,
        steps: [{ id: "s1" }],
      }),
    ).toEqual({
      version: 1,
      wishes: [],
      checkins: [{ id: "c1" }],
      resistance: [],
      steps: [{ id: "s1" }],
    });
  });

  it("prunes oversized check-in and step lists", () => {
    const checkins: AlignmentCheckin[] = Array.from({ length: MAX_STORED_CHECKINS + 5 }).map(
      (_, index) => ({
        id: `c-${index}`,
        date: "2026-04-26",
        energyScore: 3,
        clarityScore: 3,
        congruenceScore: 3,
        resistanceScore: 3,
        linkedWishIds: [],
        createdAt: new Date(2_000_000_000_000 + index).toISOString(),
      }),
    );
    const steps: ActionStep[] = Array.from({ length: MAX_STORED_STEPS + 3 }).map((_, index) => ({
      id: `s-${index}`,
      title: `step ${index}`,
      linkedWishId: "w",
      status: "open",
      createdAt: new Date(2_000_000_000_000 + index).toISOString(),
    }));
    const state = {
      ...createDefaultState(),
      checkins,
      steps,
    };
    const pruned = pruneState(state);
    expect(pruned.checkins).toHaveLength(MAX_STORED_CHECKINS);
    expect(pruned.steps).toHaveLength(MAX_STORED_STEPS);
    expect(pruned.checkins[0]?.id).toBe(`c-5`);
    expect(pruned.steps[0]?.id).toBe(`s-3`);
  });
});
