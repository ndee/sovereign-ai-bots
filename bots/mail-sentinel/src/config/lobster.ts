import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { userInfo } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Lobster CLI resolution (#150).
 *
 * The semantic reviewer is driven through the `lobster` CLI. Until now the
 * bot exec'd the bare command and trusted `PATH`. The scan unit rendered from
 * `sovereign-bot.json` sets a fixed system `PATH` — but the node installer
 * installs `@clawdbot/lobster` into the *service user's* npm prefix
 * (`<passwd home>/.npm-global/bin`), which that `PATH` does not contain. On
 * every node where lobster only lives there (Pro web installer, Pi image) the
 * reviewer therefore failed with `spawn lobster ENOENT` on every candidate,
 * while nodes with a second, root-installed copy under `/usr/bin` happened to
 * work. Nothing here changes *how* lobster is called; it only decides *which*
 * executable is called, and says where it looked when none is found.
 */

export const LOBSTER_EXECUTABLE_ENV = "SOVEREIGN_LOBSTER_EXECUTABLE";

/** The bare command name — the pre-#150 behaviour and the final fallback. */
export const LOBSTER_COMMAND = "lobster";

const NPM_GLOBAL_BIN_SEGMENTS = [".npm-global", "bin"] as const;

/** Well-known system prefixes a root-context `npm install -g` lands in. */
const SYSTEM_CANDIDATE_DIRS = ["/usr/local/bin", "/usr/bin"] as const;

export type LobsterExecutableSource =
  /** `SOVEREIGN_LOBSTER_EXECUTABLE` is set; used verbatim, never probed. */
  | "override"
  /** Found in a `PATH` directory. */
  | "path"
  /** Found in the service user's npm prefix (`<passwd home>/.npm-global/bin`). */
  | "service-home"
  /** Found in `$HOME/.npm-global/bin` (the unit's `HOME` override). */
  | "home"
  /** Found in a system prefix (`/usr/local/bin`, `/usr/bin`). */
  | "system"
  /** Nothing probed successfully; the bare command is used as before. */
  | "unresolved";

export interface LobsterResolution {
  executable: string;
  source: LobsterExecutableSource;
  /** Every absolute path that was probed, in order — for the failure message. */
  searched: string[];
}

export interface ResolveLobsterOptions {
  env?: NodeJS.ProcessEnv;
  /** Resolves when `path` exists and is executable; rejects otherwise. */
  probe?: (path: string) => Promise<void>;
  /** Home directory of the *process owner* from the passwd database, not `$HOME`. */
  passwdHome?: () => string | undefined;
}

const defaultProbe = (path: string): Promise<void> => access(path, fsConstants.X_OK);

// `os.userInfo()` reads the passwd entry for the current uid, which is where
// the node installer resolves the service home from (`getent passwd`). It
// throws when the uid has no passwd entry (some containers); that just means
// there is no service-home candidate.
const defaultPasswdHome = (): string | undefined => {
  try {
    const home = userInfo().homedir;
    return home.length > 0 ? home : undefined;
  } catch {
    return undefined;
  }
};

const npmGlobalBinary = (home: string): string =>
  join(home, ...NPM_GLOBAL_BIN_SEGMENTS, LOBSTER_COMMAND);

/**
 * Resolve the lobster executable: env override, `PATH`, the service user's
 * npm prefix, `$HOME`'s npm prefix, then the system prefixes. The first
 * executable candidate wins; when none is found the bare command is returned
 * (so the behaviour is exactly the old one) together with the list of paths
 * that were probed.
 */
export const resolveLobsterExecutable = async (
  options: ResolveLobsterOptions = {},
): Promise<LobsterResolution> => {
  const env = options.env ?? process.env;
  const probe = options.probe ?? defaultProbe;
  const passwdHome = options.passwdHome ?? defaultPasswdHome;

  const override = env[LOBSTER_EXECUTABLE_ENV]?.trim();
  if (override !== undefined && override.length > 0) {
    return { executable: override, source: "override", searched: [] };
  }

  const candidates: Array<{ path: string; source: LobsterExecutableSource }> = [];
  const seen = new Set<string>();
  const push = (path: string | undefined, source: LobsterExecutableSource): void => {
    if (path === undefined || path.length === 0 || seen.has(path)) {
      return;
    }
    seen.add(path);
    candidates.push({ path, source });
  };

  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir.length > 0) {
      push(join(dir, LOBSTER_COMMAND), "path");
    }
  }
  const serviceHome = passwdHome();
  push(serviceHome === undefined ? undefined : npmGlobalBinary(serviceHome), "service-home");
  const home = env.HOME?.trim();
  push(home === undefined || home.length === 0 ? undefined : npmGlobalBinary(home), "home");
  for (const dir of SYSTEM_CANDIDATE_DIRS) {
    push(join(dir, LOBSTER_COMMAND), "system");
  }

  const searched: string[] = [];
  for (const candidate of candidates) {
    searched.push(candidate.path);
    try {
      await probe(candidate.path);
      return { executable: candidate.path, source: candidate.source, searched };
    } catch {
      // not there / not executable — keep looking
    }
  }
  return { executable: LOBSTER_COMMAND, source: "unresolved", searched };
};

/**
 * Human-readable reason for a `spawn ENOENT` on the resolved executable, so
 * the per-candidate warning (and therefore SAN-LLM-001) says *why* the
 * reviewer is unavailable instead of the bare `spawn lobster ENOENT`.
 */
export const describeLobsterNotFound = (resolution: LobsterResolution): string => {
  if (resolution.source === "override") {
    return `lobster CLI not found at ${resolution.executable} (configured via ${LOBSTER_EXECUTABLE_ENV})`;
  }
  if (resolution.source !== "unresolved") {
    return `lobster CLI at ${resolution.executable} could not be executed`;
  }
  const searched =
    resolution.searched.length > 0 ? resolution.searched.join(", ") : "<no candidate paths>";
  return `lobster CLI not found (searched: ${searched}); install @clawdbot/lobster for the service user or set ${LOBSTER_EXECUTABLE_ENV}`;
};
