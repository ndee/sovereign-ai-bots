import {
  type BuildInfo,
  getBuildInfo,
  isBuildIdentityComplete,
  shortCommit,
  UNKNOWN_BUILD_VALUE,
} from "../build-info.js";

/**
 * Read-only runtime identity of the running Node Operator bundle.
 *
 * Requires no configuration and touches nothing on the node: it must answer
 * even when the node CLI is missing or broken, because its purpose is to
 * prove which code is live when something is wrong. The JSON form is what the
 * Pro updater's runtime-identity verification executes and compares against
 * the signed release manifest.
 *
 * It exposes build metadata only — never configuration, credentials, room
 * ids, or filesystem paths.
 */
export interface VersionCommandResult {
  readonly component: "node-operator";
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

export const formatVersionResult = (result: VersionCommandResult): string => {
  const lines = [
    `Node Operator ${result.version}`,
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
