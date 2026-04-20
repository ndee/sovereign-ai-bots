import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mkdir = vi.fn();
const open = vi.fn();
const readFile = vi.fn();
const rename = vi.fn();
const rm = vi.fn();
const stat = vi.fn();
const writeFile = vi.fn();

vi.mock("node:fs/promises", () => ({
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
}));

// Import after vi.mock so the module picks up the mocks.
const { readJsonFile, withLockedState, writeJsonFile } = await import("./io.js");

describe("state/io", () => {
  beforeEach(() => {
    mkdir.mockReset();
    open.mockReset();
    readFile.mockReset();
    rename.mockReset();
    rm.mockReset();
    stat.mockReset();
    writeFile.mockReset();
    mkdir.mockResolvedValue(undefined);
    rename.mockResolvedValue(undefined);
    rm.mockResolvedValue(undefined);
    writeFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("readJsonFile", () => {
    it("returns parsed JSON for an existing file", async () => {
      readFile.mockResolvedValue('{"a":1}\n');
      await expect(readJsonFile("/tmp/state.json", { fallback: true })).resolves.toEqual({ a: 1 });
    });

    it("returns the fallback value for ENOENT", async () => {
      const error = Object.assign(new Error("not found"), { code: "ENOENT" });
      readFile.mockRejectedValue(error);
      await expect(readJsonFile("/missing.json", { fallback: true })).resolves.toEqual({
        fallback: true,
      });
    });

    it("rethrows non-ENOENT errors", async () => {
      const error = Object.assign(new Error("permission"), { code: "EACCES" });
      readFile.mockRejectedValue(error);
      await expect(readJsonFile("/protected.json", null)).rejects.toThrow("permission");
    });
  });

  describe("writeJsonFile", () => {
    it("writes to a temp file then renames", async () => {
      await writeJsonFile("/tmp/dir/state.json", { a: 1 });
      expect(mkdir).toHaveBeenCalledWith("/tmp/dir", { recursive: true });
      expect(writeFile).toHaveBeenCalledWith("/tmp/dir/state.json.tmp", '{\n  "a": 1\n}\n', "utf8");
      expect(rename).toHaveBeenCalledWith("/tmp/dir/state.json.tmp", "/tmp/dir/state.json");
    });
  });

  describe("withLockedState", () => {
    it("runs the action and releases the lock on success", async () => {
      const close = vi.fn().mockResolvedValue(undefined);
      open.mockResolvedValue({ close });

      const action = vi.fn().mockResolvedValue("ok");
      const result = await withLockedState("/tmp/state.json", action);

      expect(result).toBe("ok");
      expect(open).toHaveBeenCalledWith("/tmp/state.json.lock", "wx");
      expect(close).toHaveBeenCalledOnce();
      expect(rm).toHaveBeenCalledWith("/tmp/state.json.lock", { force: true });
    });

    it("releases the lock even if the action throws", async () => {
      const close = vi.fn().mockResolvedValue(undefined);
      open.mockResolvedValue({ close });
      const action = vi.fn().mockRejectedValue(new Error("boom"));
      await expect(withLockedState("/tmp/state.json", action)).rejects.toThrow("boom");
      expect(close).toHaveBeenCalled();
      expect(rm).toHaveBeenCalled();
    });

    it("rethrows non-EEXIST mkdir errors immediately", async () => {
      open.mockRejectedValue(Object.assign(new Error("perm"), { code: "EACCES" }));
      await expect(withLockedState("/tmp/state.json", vi.fn())).rejects.toThrow("perm");
    });

    it("removes stale lockfiles and retries", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-08T12:00:00Z"));
      const close = vi.fn().mockResolvedValue(undefined);
      open
        .mockRejectedValueOnce(Object.assign(new Error("exists"), { code: "EEXIST" }))
        .mockResolvedValueOnce({ close });
      stat.mockResolvedValueOnce({ mtimeMs: Date.now() - 10 * 60 * 1000 });
      const action = vi.fn().mockResolvedValue("ok");
      const promise = withLockedState("/tmp/state.json", action);
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBe("ok");
      expect(rm).toHaveBeenCalledWith("/tmp/state.json.lock", { force: true });
    });

    it("waits and retries when the lock is fresh", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-08T12:00:00Z"));
      const close = vi.fn().mockResolvedValue(undefined);
      open
        .mockRejectedValueOnce(Object.assign(new Error("exists"), { code: "EEXIST" }))
        .mockResolvedValueOnce({ close });
      stat.mockResolvedValueOnce({ mtimeMs: Date.now() - 1000 });
      const action = vi.fn().mockResolvedValue("ok");
      const promise = withLockedState("/tmp/state.json", action);
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBe("ok");
    });

    it("continues retrying when stat itself fails (broken lock)", async () => {
      vi.useFakeTimers();
      const close = vi.fn().mockResolvedValue(undefined);
      open
        .mockRejectedValueOnce(Object.assign(new Error("exists"), { code: "EEXIST" }))
        .mockResolvedValueOnce({ close });
      stat.mockRejectedValueOnce(new Error("stat failed"));
      const action = vi.fn().mockResolvedValue("ok");
      const promise = withLockedState("/tmp/state.json", action);
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBe("ok");
    });

    it("throws after exhausting retries", async () => {
      vi.useFakeTimers();
      open.mockRejectedValue(Object.assign(new Error("exists"), { code: "EEXIST" }));
      stat.mockResolvedValue({ mtimeMs: Date.now() });
      const action = vi.fn();
      const promise = withLockedState("/tmp/state.json", action);
      // Attach a catch handler immediately so the rejection is never unhandled.
      const caught = promise.catch((error: unknown) =>
        error instanceof Error ? error.message : String(error),
      );
      await vi.runAllTimersAsync();
      await expect(caught).resolves.toContain("Timed out while waiting for the state lock");
      expect(action).not.toHaveBeenCalled();
    });

    // CLI commands (feedback, list-alerts, policy) run concurrently with the
    // background scanner. A single scan holds the lock through IMAP fetch +
    // LLM classification, which routinely exceeds the original 10s window.
    // Guard against an accidental revert: the retry budget must stay at or
    // above 30 seconds so concurrent CLI calls don't time out.
    it("retry budget covers at least 30 seconds of contention", async () => {
      const { DEFAULT_STATE_LOCK_RETRY_ATTEMPTS, DEFAULT_STATE_LOCK_RETRY_DELAY_MS } = await import(
        "../constants.js"
      );
      const windowMs = DEFAULT_STATE_LOCK_RETRY_ATTEMPTS * DEFAULT_STATE_LOCK_RETRY_DELAY_MS;
      expect(windowMs).toBeGreaterThanOrEqual(30_000);
    });
  });
});
