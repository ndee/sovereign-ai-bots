import {
  type BuildInfo,
  getBuildInfo,
  isBuildIdentityComplete,
  shortCommit,
  UNKNOWN_BUILD_VALUE,
} from "../build-info.js";

/**
 * Read-only runtime identity of the running Mail Sentinel bundle.
 *
 * Deliberately requires no `--instance` and touches no configuration: it must
 * answer even on a node whose IMAP instance is unconfigured or broken, because
 * its whole purpose is to prove which code is live when something is wrong.
 *
 * It exposes build metadata only — never configuration, credentials, mailbox
 * data, room ids, or filesystem paths.
 */
export interface VersionCommandResult {
  readonly component: "mail-sentinel";
  readonly version: string;
  /** Full commit SHA; chat rendering shortens it. */
  readonly commit: string;
  readonly releaseId: string;
  readonly buildTimestamp: string;
  /** Wall-clock UTC at which this invocation reported. */
  readonly reportedAt: string;
  /** False when any build field is `unknown` — surfaced, never hidden. */
  readonly identityComplete: boolean;
}

export const version = (
  now: Date = new Date(),
  info: BuildInfo = getBuildInfo(),
): VersionCommandResult => ({
  component: info.component,
  version: info.version,
  commit: info.commit,
  releaseId: info.releaseId,
  buildTimestamp: info.buildTimestamp,
  reportedAt: now.toISOString(),
  identityComplete: isBuildIdentityComplete(info),
});

/** `2026-07-25 14:32 UTC` — matches the project's UTC-everywhere convention. */
const formatUtcMinute = (iso: string): string => {
  if (iso === UNKNOWN_BUILD_VALUE) {
    return UNKNOWN_BUILD_VALUE;
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return UNKNOWN_BUILD_VALUE;
  }
  return `${parsed.toISOString().slice(0, 16).replace("T", " ")} UTC`;
};

/**
 * Calm, operator-facing rendering for Matrix.
 *
 * Mail Sentinel is a systemd *oneshot* — it starts, scans, and exits — so it
 * deliberately reports when this answer was produced rather than a process
 * uptime or a "running" claim, either of which would be fabricated.
 */
export const formatVersionResult = (result: VersionCommandResult): string => {
  const lines = [
    `Mail Sentinel ${result.version}`,
    `Release: ${result.releaseId}`,
    `Commit: ${shortCommit(result.commit)}`,
    `Built: ${formatUtcMinute(result.buildTimestamp)}`,
    `Reported: ${formatUtcMinute(result.reportedAt)}`,
  ];
  if (!result.identityComplete) {
    lines.push(
      "Build identity is incomplete — this bundle was built without full release metadata.",
    );
  }
  return lines.join("\n");
};
