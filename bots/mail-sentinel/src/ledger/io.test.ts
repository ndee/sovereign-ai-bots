import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LEDGER_FILENAME, ledgerPathFor, readLedgerFile, writeLedgerFile } from "./io.js";
import { buildLedgerKey, createLedger, localDay, recordOutcome } from "./ledger.js";

const NOON = new Date("2026-10-19T12:00:00.000Z");

describe("ledger/io", () => {
  it("places the ledger beside the state file", () => {
    expect(ledgerPathFor("/ws/data/mail-sentinel-state.json")).toBe(`/ws/data/${LEDGER_FILENAME}`);
  });

  it("starts empty when no ledger exists yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ledger-io-"));
    expect(await readLedgerFile(join(dir, LEDGER_FILENAME), NOON)).toEqual(createLedger());
  });

  it("restarts an unreadable ledger and flags the day", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ledger-io-"));
    const path = join(dir, LEDGER_FILENAME);
    await writeFile(path, "{ not json", "utf8");
    const ledger = await readLedgerFile(path, NOON);
    expect(ledger.entries).toEqual({});
    expect(ledger.days[localDay(NOON)]?.flags).toEqual(["ledger-reset"]);
  });

  it("round-trips a ledger and holds no mail content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ledger-io-"));
    const path = join(dir, "nested", LEDGER_FILENAME);
    const ledger = createLedger();
    recordOutcome(
      ledger,
      buildLedgerKey("imap:7", 3),
      { state: "read-failed", reason: "timeout" },
      NOON,
    );
    await writeLedgerFile(path, ledger);
    expect(await readLedgerFile(path, NOON)).toEqual(ledger);
    const raw = await readFile(path, "utf8");
    expect(raw).not.toMatch(/subject|from|snippet|messageId|@/iu);
  });
});
