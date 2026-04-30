import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDefaultState,
  loadState,
  migrateState,
  readJsonFile,
  saveState,
  writeJsonFile,
} from "./state.js";

describe("wealth-alignment/state", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("reads and writes JSON files", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "wealth-state-"));
    const filePath = join(tempDir, "state.json");
    expect(await readJsonFile(filePath, { ok: false })).toEqual({ ok: false });
    await writeJsonFile(filePath, { ok: true });
    expect(await readJsonFile(filePath, { ok: false })).toEqual({ ok: true });
    expect(await readFile(filePath, "utf8")).toBe('{\n  "ok": true\n}\n');

    await writeFile(filePath, "{\n", "utf8");
    await expect(readJsonFile(filePath, { ok: false })).rejects.toThrow();
  });

  it("migrates partial state", () => {
    const result = migrateState({ documents: [{ id: "doc-1" }] });
    expect(result.version).toBe(1);
    expect(result.documents).toEqual([{ id: "doc-1" }]);
    expect(result.counters.documents).toBe(0);
  });

  it("returns defaults from null or undefined input", () => {
    expect(migrateState(undefined).documents).toEqual([]);
    expect(migrateState(null).documents).toEqual([]);
  });

  it("falls back to defaults when fields are missing or invalid", () => {
    const result = migrateState({
      documents: "not-an-array",
      accounts: undefined,
      transactions: null,
      counters: { documents: "5", transactions: 10 },
    });
    expect(result.documents).toEqual([]);
    expect(result.accounts).toEqual([]);
    expect(result.transactions).toEqual([]);
    expect(result.counters).toEqual({ documents: 5, transactions: 10 });
  });

  it("loads default state when file is missing", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "wealth-state-"));
    const result = await loadState(join(tempDir, "missing.json"));
    expect(result).toEqual(createDefaultState());
  });

  it("saves and reloads state", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "wealth-state-"));
    const filePath = join(tempDir, "state.json");
    const state = createDefaultState();
    state.counters.documents = 3;
    await saveState(filePath, state);
    const reloaded = await loadState(filePath);
    expect(reloaded.counters.documents).toBe(3);
  });

  it("propagates non-ENOENT read errors", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "wealth-state-"));
    await expect(readJsonFile(tempDir, { ok: false })).rejects.toThrow();
  });
});
