/**
 * Immutable build identity for the running Node Operator bundle.
 *
 * The values below are replaced at BUILD time by tsup `define` (see
 * tsup.config.ts). They are compile-time literals in the shipped bundle, so
 * the running process reports what was actually built — not what a mutable
 * checkout, a branch name, or a JSON file on disk happens to say right now.
 *
 * The release bundle deliberately strips `.git`, so `git describe` at runtime
 * is impossible by design, and the Pro updater must not accept
 * `sovereign-bot.json` as proof that the installed code actually runs — the
 * `version --json` output of THIS module is what
 * `pro-update.sh`'s runtime-identity verification executes and compares.
 *
 * When a value could not be determined at build time it is reported as
 * `unknown` rather than guessed. Callers must render that honestly.
 */

declare const __NODE_OPERATOR_VERSION__: string | undefined;
declare const __NODE_OPERATOR_COMMIT__: string | undefined;
declare const __SOVEREIGN_RELEASE_ID__: string | undefined;
declare const __BUILD_TIMESTAMP__: string | undefined;

/** Reported when a build-time value was unavailable or the code runs unbundled. */
export const UNKNOWN_BUILD_VALUE = "unknown";

/** Bound so a malformed/hostile define can never produce unbounded output. */
const MAX_FIELD_LENGTH = 200;

export interface BuildInfo {
  readonly component: "node-operator";
  /** Semantic version of the built bundle, or `unknown`. */
  readonly version: string;
  /** Full lowercase source commit SHA, or `unknown`. */
  readonly commit: string;
  /** Supported release tuple this bundle was built for, or `unknown`. */
  readonly releaseId: string;
  /** ISO-8601 UTC build timestamp, or `unknown`. */
  readonly buildTimestamp: string;
}

/**
 * Normalize a build-time value, falling back to `unknown`.
 *
 * Exported so the sanitization rules are directly tested: the tsup `define`
 * substitution itself cannot run under vitest, but everything we do with the
 * substituted value can and must be.
 */
export const readDefine = (value: unknown): string => {
  if (typeof value !== "string") {
    return UNKNOWN_BUILD_VALUE;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return UNKNOWN_BUILD_VALUE;
  }
  return trimmed.slice(0, MAX_FIELD_LENGTH);
};

/*  Reading the defines is the one part the test runner cannot reach: vitest
    imports this TypeScript directly, so the identifiers are never substituted
    and only the `undefined` arm exists at test time. The normalization applied
    to whatever comes back is covered by the readDefine tests. */
/* v8 ignore start -- tsup `define` substitution never occurs under vitest. */
const rawVersion = (): unknown =>
  typeof __NODE_OPERATOR_VERSION__ === "undefined" ? undefined : __NODE_OPERATOR_VERSION__;
const rawCommit = (): unknown =>
  typeof __NODE_OPERATOR_COMMIT__ === "undefined" ? undefined : __NODE_OPERATOR_COMMIT__;
const rawReleaseId = (): unknown =>
  typeof __SOVEREIGN_RELEASE_ID__ === "undefined" ? undefined : __SOVEREIGN_RELEASE_ID__;
const rawBuildTimestamp = (): unknown =>
  typeof __BUILD_TIMESTAMP__ === "undefined" ? undefined : __BUILD_TIMESTAMP__;
/* v8 ignore stop */

/** Resolve the immutable identity of the running bundle. */
export const getBuildInfo = (): BuildInfo => ({
  component: "node-operator",
  version: readDefine(rawVersion()),
  commit: readDefine(rawCommit()),
  releaseId: readDefine(rawReleaseId()),
  buildTimestamp: readDefine(rawBuildTimestamp()),
});

/** Short commit form for chat output. Full hash stays available in JSON. */
export const shortCommit = (commit: string): string =>
  commit === UNKNOWN_BUILD_VALUE ? UNKNOWN_BUILD_VALUE : commit.slice(0, 7);

/** True when every optional build field resolved — used to flag partial identity. */
export const isBuildIdentityComplete = (info: BuildInfo): boolean =>
  info.version !== UNKNOWN_BUILD_VALUE &&
  info.commit !== UNKNOWN_BUILD_VALUE &&
  info.releaseId !== UNKNOWN_BUILD_VALUE;
