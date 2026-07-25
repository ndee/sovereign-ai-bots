import { open, rm } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";

import { type BuildInfo, buildIdentityKey, getBuildInfo, shortCommit } from "../build-info.js";
import type { MailSentinelRuntime } from "../config/runtime.js";
import { readJsonFile, writeJsonFile } from "../state/io.js";

/**
 * One-time "Mail Sentinel updated" notice.
 *
 * Mail Sentinel is a systemd *oneshot*: it starts on a timer, scans, and exits.
 * There is no daemon lifecycle to hang a startup hook on, so the announcement
 * rides the first scan that observes a new build identity. That is also the
 * first moment Matrix connectivity is actually demonstrated rather than assumed
 * — the notice is posted through the same authenticated room-send the alert
 * path uses, so a delivered notice proves the room is reachable.
 *
 * The identity compared is version+commit+releaseId, not version alone: a
 * rebuild at the same version but a different commit is a different build and
 * an operator verifying an update needs to see it.
 *
 * Persistence happens ONLY after Matrix confirms delivery. A failed send leaves
 * the record untouched so the next scan retries, and a send failure never
 * prevents Mail Sentinel from doing its actual work.
 */

/** Sits beside the state file, not inside it: this is deployment metadata, not operational state. */
export const BUILD_IDENTITY_FILENAME = "mail-sentinel-build-identity.json";

interface AnnouncedIdentityRecord {
  /** version+commit+releaseId of the last SUCCESSFULLY announced build. */
  announcedIdentity?: unknown;
  announcedAt?: unknown;
}

export interface AnnounceOutcome {
  announced: boolean;
  reason: "first-run-recorded" | "unchanged" | "announced" | "send-failed" | "not-configured";
}

/**
 * Resolve the record path from the state path.
 *
 * Derived from the already-resolved statePath rather than from any caller
 * input, so no untrusted value reaches the filesystem.
 */
export const buildIdentityPathFor = (statePath: string): string =>
  resolvePath(dirname(statePath), BUILD_IDENTITY_FILENAME);

const readAnnouncedIdentity = async (path: string): Promise<string | undefined> => {
  let record: AnnouncedIdentityRecord;
  try {
    record = await readJsonFile<AnnouncedIdentityRecord>(path, {});
  } catch {
    // A corrupted or unreadable record must not wedge the bot. Treat it as
    // "nothing announced yet" and let this run rewrite it cleanly.
    return undefined;
  }
  const value = record.announcedIdentity;
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

export const formatUpdateAnnouncement = (
  info: BuildInfo,
): { body: string; formattedBody: string } => {
  const body = [
    "Mail Sentinel updated",
    "",
    `Version: ${info.version}`,
    `Release: ${info.releaseId}`,
    `Commit: ${shortCommit(info.commit)}`,
  ].join("\n");
  const formattedBody = [
    "<b>Mail Sentinel updated</b><br/><br/>",
    `Version: ${escapeHtml(info.version)}<br/>`,
    `Release: ${escapeHtml(info.releaseId)}<br/>`,
    `Commit: ${escapeHtml(shortCommit(info.commit))}`,
  ].join("");
  return { body, formattedBody };
};

/** Build values are baked at build time, but never render unescaped into a room. */
const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * Announce this build once, if it differs from the last announced one.
 *
 * Never throws: the caller is the scan path, and a notice is strictly less
 * important than the scan it rides on.
 */
export const announceBuildIfChanged = async (
  runtime: Pick<MailSentinelRuntime, "statePath" | "sendMatrixRoomMessage">,
  info: BuildInfo = getBuildInfo(),
  now: Date = new Date(),
): Promise<AnnounceOutcome> => {
  const identity = buildIdentityKey(info);
  const recordPath = buildIdentityPathFor(runtime.statePath);

  // A single non-blocking exclusive-create lock, deliberately NOT the shared
  // state lock: that one retries for ~30s, and a notice must never delay a
  // scan. If another run holds it, this run simply defers to it.
  const lockPath = `${recordPath}.lock`;
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(lockPath, "wx");
  } catch {
    return { announced: false, reason: "unchanged" };
  }

  // Every failure below is caught and turned into an outcome, so cleanup is
  // reached on one path and needs no `finally`.
  const outcome = await announceUnderLock(runtime, info, now, identity, recordPath);
  await lock.close();
  // `force` already tolerates an absent lock, so this needs no extra guard.
  await rm(lockPath, { force: true });
  return outcome;
};

const announceUnderLock = async (
  runtime: Pick<MailSentinelRuntime, "statePath" | "sendMatrixRoomMessage">,
  info: BuildInfo,
  now: Date,
  identity: string,
  recordPath: string,
): Promise<AnnounceOutcome> => {
  try {
    const previous = await readAnnouncedIdentity(recordPath);
    if (previous === identity) {
      return { announced: false, reason: "unchanged" };
    }

    if (previous === undefined) {
      // First run on a node that has never recorded an identity. Record it
      // silently: the bot was installed, not updated, and announcing here
      // would post a spurious "updated" notice on every fresh install.
      await writeJsonFile(recordPath, {
        announcedIdentity: identity,
        announcedAt: now.toISOString(),
      });
      return { announced: false, reason: "first-run-recorded" };
    }

    await runtime.sendMatrixRoomMessage(formatUpdateAnnouncement(info));
    // Persist ONLY after Matrix accepted the message. If the send threw we
    // never get here, so the next scan retries rather than silently losing
    // the notice.
    await writeJsonFile(recordPath, {
      announcedIdentity: identity,
      announcedAt: now.toISOString(),
    });
    return { announced: true, reason: "announced" };
  } catch {
    // Covers a failed send and an unwritable record. The scan continues.
    return { announced: false, reason: "send-failed" };
  }
};
