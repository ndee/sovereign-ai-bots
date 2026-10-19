import { describe, expect, it, vi } from "vitest";

import { parseInventoryResult, runInventory, takeInventory } from "./inventory.js";
import { createLedger, type MailLedger } from "./ledger.js";

const NOON = new Date("2026-10-19T12:00:00.000Z");
const WINDOW = { searchWindowMs: 25 * 60 * 60 * 1000 };

type Cursor = { afterUid?: number; uidValidity?: string | undefined };

const fakeRuntime = (
  result: unknown,
  mailProtocol: "imap" | "pop3" = "imap",
): {
  mailProtocol: "imap" | "pop3";
  inventoryMail: ReturnType<typeof vi.fn<(cursor?: Cursor) => Promise<unknown>>>;
} => ({
  mailProtocol,
  inventoryMail: vi.fn(async (_cursor?: Cursor) => {
    if (result instanceof Error || typeof result === "string") {
      throw result;
    }
    return result;
  }),
});

describe("ledger/inventory > parseInventoryResult", () => {
  it("rejects anything that is not an object with a listing", () => {
    expect(parseInventoryResult(null, "imap")).toBeUndefined();
    expect(parseInventoryResult([], "imap")).toBeUndefined();
    expect(parseInventoryResult({ uidValidity: "7" }, "imap")).toBeUndefined();
  });

  it("reads IMAP UID ranges, dropping malformed ones and sorting the rest", () => {
    expect(
      parseInventoryResult(
        {
          protocol: "imap",
          uidValidity: "7",
          afterUid: 10,
          uidGaps: 2,
          uidRanges: [[20, 22], "x", [0, 3], [5, 4], [11, 1.5], [11, 12]],
        },
        "pop3",
      ),
    ).toEqual({
      keySpace: "imap:7",
      fullCensus: false,
      uidRanges: [
        [11, 12],
        [20, 22],
      ],
      uidGaps: 2,
    });
  });

  it("treats a run from zero, without a bound, or across a UIDVALIDITY change as a full census", () => {
    const base = { uidValidity: "7", uidRanges: [] };
    expect(parseInventoryResult({ ...base, afterUid: 0 }, "imap")?.fullCensus).toBe(true);
    expect(parseInventoryResult(base, "imap")?.fullCensus).toBe(true);
    expect(
      parseInventoryResult({ ...base, afterUid: 9, uidValidityChanged: true }, "imap")?.fullCensus,
    ).toBe(true);
  });

  it("falls back to the runtime protocol and an unknown UIDVALIDITY", () => {
    expect(parseInventoryResult({ uidRanges: [], uidGaps: 0 }, "imap")).toEqual({
      keySpace: "imap:-",
      fullCensus: true,
      uidRanges: [],
    });
    expect(parseInventoryResult({ uidRanges: [], uidGaps: "3" }, "imap")).not.toHaveProperty(
      "uidGaps",
    );
  });

  it("keeps only POP3 messages the index has given a uid, without their UIDL hashes", () => {
    const listing = parseInventoryResult(
      {
        protocol: "pop3",
        uidValidity: "ab12cd34:2",
        messages: [
          { uidlHash: "aaaaaaaaaaaa", uid: 9 },
          { uidlHash: "bbbbbbbbbbbb", uid: 4, baseline: true },
          { uidlHash: "cccccccccccc" },
          "junk",
        ],
      },
      "imap",
    );
    expect(listing).toEqual({
      keySpace: "pop3:ab12cd34:2",
      fullCensus: true,
      uidRanges: [
        [4, 4],
        [9, 9],
      ],
      baselineUids: [4],
    });
    expect(JSON.stringify(listing)).not.toContain("aaaa");
  });
});

describe("ledger/inventory > runInventory", () => {
  it("asks for a full census when there is no cursor", async () => {
    const runtime = fakeRuntime({ uidValidity: "7", afterUid: 0, uidRanges: [[1, 3]] });
    expect(await runInventory(runtime, createLedger())).toMatchObject({ kind: "listed" });
    expect(runtime.inventoryMail).toHaveBeenCalledWith({});
  });

  it("passes the cursor and its UIDVALIDITY", async () => {
    const ledger: MailLedger = createLedger();
    ledger.inventory.cursor = { keySpace: "imap:ab12:3", afterUid: 41 };
    const runtime = fakeRuntime({ uidRanges: [] });
    await runInventory(runtime, ledger);
    expect(runtime.inventoryMail).toHaveBeenCalledWith({ afterUid: 41, uidValidity: "ab12:3" });
  });

  it("asks for a full listing when the cursor's key space had no UIDVALIDITY", async () => {
    const ledger = createLedger();
    ledger.inventory.cursor = { keySpace: "imap:-", afterUid: 5 };
    const runtime = fakeRuntime({ uidRanges: [] });
    await runInventory(runtime, ledger);
    expect(runtime.inventoryMail).toHaveBeenCalledWith({});
  });

  it("never passes a cursor for POP3, which always lists everything", async () => {
    const ledger = createLedger();
    ledger.inventory.cursor = { keySpace: "pop3:ab12:3", afterUid: 41 };
    const runtime = fakeRuntime({ messages: [] }, "pop3");
    await runInventory(runtime, ledger);
    expect(runtime.inventoryMail).toHaveBeenCalledWith({});
  });

  it("reports a tool without the command as unsupported", async () => {
    const runtime = fakeRuntime(
      new Error("mail-inventory failed: error: unknown command 'mail-inventory'"),
    );
    expect(await runInventory(runtime, createLedger())).toEqual({ kind: "unsupported" });
  });

  it("reports any other error, thrown or not, as a failure", async () => {
    expect(
      await runInventory(fakeRuntime(new Error("MAIL_INVENTORY_TIMEOUT")), createLedger()),
    ).toEqual({ kind: "failed", message: "MAIL_INVENTORY_TIMEOUT" });
    expect(await runInventory(fakeRuntime("socket closed"), createLedger())).toEqual({
      kind: "failed",
      message: "socket closed",
    });
  });

  it("reports a result without a listing as a failure", async () => {
    expect(await runInventory(fakeRuntime({ ok: true }), createLedger())).toEqual({
      kind: "failed",
      message: "mail-inventory returned no identifier listing",
    });
  });
});

describe("ledger/inventory > takeInventory", () => {
  it("folds a listing into the ledger and returns the created keys", async () => {
    const ledger = createLedger();
    await takeInventory(
      fakeRuntime({ uidValidity: "7", uidRanges: [[1, 3]] }),
      ledger,
      NOON,
      WINDOW,
    );
    const outcome = await takeInventory(
      fakeRuntime({ uidValidity: "7", afterUid: 3, uidRanges: [[4, 5]] }),
      ledger,
      NOON,
      WINDOW,
    );
    expect(outcome).toMatchObject({ kind: "listed", created: ["imap:7:4", "imap:7:5"] });
    expect(ledger.inventory.status).toBe("available");
  });

  it("records an unsupported or failed inventory without touching entries", async () => {
    const ledger = createLedger();
    expect(
      await takeInventory(fakeRuntime(new Error("unknown command")), ledger, NOON, WINDOW),
    ).toEqual({ kind: "unsupported" });
    expect(ledger.inventory).toEqual({ status: "unsupported", lastAttemptAt: NOON.toISOString() });
    await takeInventory(fakeRuntime(new Error("boom")), ledger, NOON, WINDOW);
    expect(ledger.inventory.status).toBe("failed");
    expect(ledger.entries).toEqual({});
  });
});
