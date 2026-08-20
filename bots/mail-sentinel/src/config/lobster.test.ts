import { describe, expect, it, vi } from "vitest";

const userInfo = vi.fn();
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, userInfo };
});

const {
  describeLobsterNotFound,
  LOBSTER_COMMAND,
  LOBSTER_EXECUTABLE_ENV,
  resolveLobsterExecutable,
} = await import("./lobster.js");

const acceptOnly = (...paths: string[]) => {
  const accepted = new Set(paths);
  return vi.fn(async (path: string) => {
    if (!accepted.has(path)) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
  });
};

describe("config/lobster", () => {
  describe("resolveLobsterExecutable", () => {
    it("uses the env override verbatim without probing", async () => {
      const probe = acceptOnly();
      const result = await resolveLobsterExecutable({
        env: { [LOBSTER_EXECUTABLE_ENV]: "  /opt/lobster/bin/lobster  ", PATH: "/usr/bin" },
        probe,
      });
      expect(result).toEqual({
        executable: "/opt/lobster/bin/lobster",
        source: "override",
        searched: [],
      });
      expect(probe).not.toHaveBeenCalled();
    });

    it("ignores a blank override and falls through to probing", async () => {
      const probe = acceptOnly("/usr/bin/lobster");
      const result = await resolveLobsterExecutable({
        env: { [LOBSTER_EXECUTABLE_ENV]: "   ", PATH: "/usr/bin" },
        probe,
        passwdHome: () => undefined,
      });
      expect(result.executable).toBe("/usr/bin/lobster");
      expect(result.source).toBe("path");
    });

    it("prefers a PATH hit over every other location", async () => {
      const probe = acceptOnly("/usr/local/bin/lobster", "/var/lib/svc/.npm-global/bin/lobster");
      const result = await resolveLobsterExecutable({
        env: {
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/bin",
          HOME: "/var/lib/svc/openclaw-home",
        },
        probe,
        passwdHome: () => "/var/lib/svc",
      });
      expect(result).toEqual({
        executable: "/usr/local/bin/lobster",
        source: "path",
        searched: ["/usr/local/sbin/lobster", "/usr/local/bin/lobster"],
      });
    });

    // The cathouse-pi shape (#150): the scan unit's PATH is the system default,
    // HOME is the openclaw-home override, and the node installer put lobster
    // into the service user's passwd-home npm prefix.
    it("falls back to the service user's npm prefix when PATH has no lobster", async () => {
      const probe = acceptOnly("/var/lib/sovereign-node/.npm-global/bin/lobster");
      const result = await resolveLobsterExecutable({
        env: {
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          HOME: "/var/lib/sovereign-node/openclaw-home",
        },
        probe,
        passwdHome: () => "/var/lib/sovereign-node",
      });
      expect(result.executable).toBe("/var/lib/sovereign-node/.npm-global/bin/lobster");
      expect(result.source).toBe("service-home");
      expect(result.searched).toEqual([
        "/usr/local/sbin/lobster",
        "/usr/local/bin/lobster",
        "/usr/sbin/lobster",
        "/usr/bin/lobster",
        "/sbin/lobster",
        "/bin/lobster",
        "/var/lib/sovereign-node/.npm-global/bin/lobster",
      ]);
    });

    it("probes $HOME's npm prefix after the service home", async () => {
      const probe = acceptOnly("/home/dev/.npm-global/bin/lobster");
      const result = await resolveLobsterExecutable({
        env: { PATH: "/usr/bin", HOME: "/home/dev" },
        probe,
        passwdHome: () => "/var/lib/sovereign-node",
      });
      expect(result.executable).toBe("/home/dev/.npm-global/bin/lobster");
      expect(result.source).toBe("home");
    });

    it("probes the system prefixes last and dedupes paths already covered by PATH", async () => {
      const probe = acceptOnly("/usr/local/bin/lobster");
      const result = await resolveLobsterExecutable({
        env: { PATH: "/usr/bin::/usr/bin", HOME: "" },
        probe,
        passwdHome: () => undefined,
      });
      expect(result.executable).toBe("/usr/local/bin/lobster");
      expect(result.source).toBe("system");
      // "/usr/bin" appears once from PATH and is not repeated from the system list;
      // the empty PATH segment and empty HOME contribute nothing.
      expect(result.searched).toEqual(["/usr/bin/lobster", "/usr/local/bin/lobster"]);
    });

    it("returns the bare command with the searched list when nothing is found", async () => {
      const probe = acceptOnly();
      const result = await resolveLobsterExecutable({
        env: {},
        probe,
        passwdHome: () => "/var/lib/svc",
      });
      expect(result).toEqual({
        executable: LOBSTER_COMMAND,
        source: "unresolved",
        searched: [
          "/var/lib/svc/.npm-global/bin/lobster",
          "/usr/local/bin/lobster",
          "/usr/bin/lobster",
        ],
      });
    });

    it("uses the real probe and the passwd home by default", async () => {
      userInfo.mockReturnValue({ homedir: "/nonexistent/passwd-home" });
      const result = await resolveLobsterExecutable({ env: {} });
      // Nothing under these paths exists on a test runner, so the real
      // `access` probe rejects all of them and the bare command comes back.
      expect(result.source).toBe("unresolved");
      expect(result.searched).toEqual([
        "/nonexistent/passwd-home/.npm-global/bin/lobster",
        "/usr/local/bin/lobster",
        "/usr/bin/lobster",
      ]);
    });

    it("skips the service-home candidate when the passwd entry has no home", async () => {
      userInfo.mockReturnValue({ homedir: "" });
      const result = await resolveLobsterExecutable({ env: {}, probe: acceptOnly() });
      expect(result.searched).toEqual(["/usr/local/bin/lobster", "/usr/bin/lobster"]);
    });

    it("skips the service-home candidate when the uid has no passwd entry", async () => {
      userInfo.mockImplementation(() => {
        throw Object.assign(new Error("no passwd entry"), { code: "ENOENT" });
      });
      const result = await resolveLobsterExecutable({ env: {}, probe: acceptOnly() });
      expect(result.searched).toEqual(["/usr/local/bin/lobster", "/usr/bin/lobster"]);
    });

    it("reads process.env when no env is given", async () => {
      const previous = process.env[LOBSTER_EXECUTABLE_ENV];
      process.env[LOBSTER_EXECUTABLE_ENV] = "/from/process/env/lobster";
      try {
        const result = await resolveLobsterExecutable();
        expect(result).toEqual({
          executable: "/from/process/env/lobster",
          source: "override",
          searched: [],
        });
      } finally {
        if (previous === undefined) {
          delete process.env[LOBSTER_EXECUTABLE_ENV];
        } else {
          process.env[LOBSTER_EXECUTABLE_ENV] = previous;
        }
      }
    });
  });

  describe("describeLobsterNotFound", () => {
    it("names the override when one was configured", () => {
      expect(
        describeLobsterNotFound({ executable: "/opt/x/lobster", source: "override", searched: [] }),
      ).toBe(`lobster CLI not found at /opt/x/lobster (configured via ${LOBSTER_EXECUTABLE_ENV})`);
    });

    it("names the resolved path when a found binary later fails to spawn", () => {
      expect(
        describeLobsterNotFound({
          executable: "/usr/bin/lobster",
          source: "path",
          searched: ["/usr/bin/lobster"],
        }),
      ).toBe("lobster CLI at /usr/bin/lobster could not be executed");
    });

    it("lists every probed location when nothing was found", () => {
      expect(
        describeLobsterNotFound({
          executable: LOBSTER_COMMAND,
          source: "unresolved",
          searched: ["/usr/bin/lobster", "/var/lib/svc/.npm-global/bin/lobster"],
        }),
      ).toBe(
        `lobster CLI not found (searched: /usr/bin/lobster, /var/lib/svc/.npm-global/bin/lobster); install @clawdbot/lobster for the service user or set ${LOBSTER_EXECUTABLE_ENV}`,
      );
    });

    it("says so when there were no candidate paths at all", () => {
      expect(
        describeLobsterNotFound({
          executable: LOBSTER_COMMAND,
          source: "unresolved",
          searched: [],
        }),
      ).toContain("searched: <no candidate paths>");
    });
  });
});
