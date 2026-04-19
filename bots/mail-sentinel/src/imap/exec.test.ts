import { describe, expect, it, vi } from "vitest";

const readFile = vi.fn();
vi.mock("node:fs/promises", () => ({
  readFile,
  mkdir: vi.fn().mockResolvedValue(undefined),
  open: vi.fn(),
  rename: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

const { execFileAsync, resolveSecretRefValue, setExecFileAsync } = await import("./exec.js");

describe("imap/exec", () => {
  it("delegates execFileAsync to the current runner", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "ok", stderr: "" });
    const previous = setExecFileAsync(runner);
    try {
      const result = await execFileAsync("tool", ["--flag"], { maxBuffer: 1 });
      expect(runner).toHaveBeenCalledWith("tool", ["--flag"], { maxBuffer: 1 });
      expect(result.stdout).toBe("ok");
    } finally {
      setExecFileAsync(previous);
    }
  });

  describe("resolveSecretRefValue", () => {
    it("throws when the ref is missing", async () => {
      await expect(resolveSecretRefValue(undefined)).rejects.toThrow("Missing secret reference");
      await expect(resolveSecretRefValue("")).rejects.toThrow("Missing secret reference");
    });

    it("throws when the ref format is unknown", async () => {
      await expect(resolveSecretRefValue("unknown:foo")).rejects.toThrow(
        "Unsupported secretRef format",
      );
    });

    it("reads a file secret and strips a single trailing newline", async () => {
      readFile.mockResolvedValue("my-token\n");
      await expect(resolveSecretRefValue("file:/tmp/secret")).resolves.toBe("my-token");
      expect(readFile).toHaveBeenCalledWith("/tmp/secret", "utf8");
    });

    it("throws when a file secret is empty", async () => {
      readFile.mockResolvedValue("\n");
      await expect(resolveSecretRefValue("file:/tmp/secret")).rejects.toThrow("is empty");
    });

    it("reads an env secret", async () => {
      const previous = process.env.MAIL_SENTINEL_TEST_SECRET;
      process.env.MAIL_SENTINEL_TEST_SECRET = "env-token";
      try {
        await expect(resolveSecretRefValue("env:MAIL_SENTINEL_TEST_SECRET")).resolves.toBe(
          "env-token",
        );
      } finally {
        if (previous === undefined) {
          delete process.env.MAIL_SENTINEL_TEST_SECRET;
        } else {
          process.env.MAIL_SENTINEL_TEST_SECRET = previous;
        }
      }
    });

    it("throws when an env secret is not set", async () => {
      delete process.env.MAIL_SENTINEL_TEST_UNSET;
      await expect(resolveSecretRefValue("env:MAIL_SENTINEL_TEST_UNSET")).rejects.toThrow(
        "is not set",
      );
    });
  });
});
