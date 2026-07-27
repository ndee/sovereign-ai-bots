import { open, rm } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";

import type { MailSentinelRuntime } from "../config/runtime.js";
import { readJsonFile, writeJsonFile } from "../state/io.js";
import type { DegradationState } from "./degradation.js";
import { shouldAnnounce } from "./degradation.js";

/**
 * Debounced Matrix notice for the degradation state machine (F-01).
 *
 * Follows the `announce-build` pattern exactly, and for the same reasons: a
 * narrow runtime dependency, a non-blocking sidecar lock rather than the shared
 * ~30s state lock, and persistence only after Matrix confirms delivery so a
 * failed send retries on the next scan instead of being silently swallowed.
 *
 * Message content is deliberately starved of mail data. These notices fire
 * exactly when something is wrong, which is exactly when a well-meaning
 * "include some context" instinct would leak a subject line into a room. There
 * is no code path here that reads a message, an alert, or a sender: the notice
 * renders from a fixed string table keyed by state, so there is nothing to
 * leak even if the caller passes contaminated state.
 */

/** Sits beside the state file, like the build-identity record: operational metadata, not state. */
export const DEGRADATION_NOTICE_FILENAME = "mail-sentinel-degradation-notice.json";

interface AnnouncedNoticeRecord {
  /** The last SUCCESSFULLY announced degradation state. */
  announcedState?: unknown;
  announcedAt?: unknown;
}

export interface NoticeOutcome {
  announced: boolean;
  reason: "unchanged" | "announced" | "send-failed";
}

/**
 * Resolve the record path from the state path.
 *
 * Derived from the already-resolved statePath rather than from any caller
 * input, so no untrusted value reaches the filesystem.
 */
export const degradationNoticePathFor = (statePath: string): string =>
  resolvePath(dirname(statePath), DEGRADATION_NOTICE_FILENAME);

const KNOWN_STATES = new Set<string>(["healthy", "classification-degraded", "scans-failing"]);

const readAnnouncedState = async (path: string): Promise<DegradationState | undefined> => {
  let record: AnnouncedNoticeRecord;
  try {
    record = await readJsonFile<AnnouncedNoticeRecord>(path, {});
  } catch {
    // A corrupted or unreadable record must not wedge the bot. Treat it as
    // "nothing announced yet" and let this run rewrite it cleanly.
    return undefined;
  }
  const value = record.announcedState;
  return typeof value === "string" && KNOWN_STATES.has(value)
    ? (value as DegradationState)
    : undefined;
};

interface NoticeText {
  body: string;
  formattedBody: string;
}

/**
 * Fixed copy per state. Stable `SAN-*` codes give support something to search
 * on; the prose explains the IMPACT, because an operator reading a Matrix room
 * needs to know what stopped working, not which function threw.
 */
const NOTICE_TEXT: Record<DegradationState, NoticeText> = {
  "classification-degraded": {
    body: [
      "⚠️ Mail Sentinel: classification degraded (SAN-LLM-001).",
      "Mail is still being retrieved, but the semantic reviewer is unavailable,",
      "so messages are not being escalated to red. Alerts continue at reduced confidence.",
    ].join(" "),
    formattedBody: [
      "<b>⚠️ Mail Sentinel: classification degraded (SAN-LLM-001).</b><br/>",
      "Mail is still being retrieved, but the semantic reviewer is unavailable, ",
      "so messages are not being escalated to red. Alerts continue at reduced confidence.",
    ].join(""),
  },
  "scans-failing": {
    body: [
      "🔴 Mail Sentinel: mailbox scans are failing (SAN-MAIL-001).",
      "New mail is not being retrieved, so no alerts are being raised at all.",
      "Check the mailbox connection.",
    ].join(" "),
    formattedBody: [
      "<b>🔴 Mail Sentinel: mailbox scans are failing (SAN-MAIL-001).</b><br/>",
      "New mail is not being retrieved, so no alerts are being raised at all. ",
      "Check the mailbox connection.",
    ].join(""),
  },
  healthy: {
    body: "✅ Mail Sentinel: back to normal. Mail is being retrieved and classified again.",
    formattedBody: [
      "<b>✅ Mail Sentinel: back to normal.</b><br/>",
      "Mail is being retrieved and classified again.",
    ].join(""),
  },
};

/**
 * Render the notice for a state.
 *
 * Takes only the state — no message, alert, or runtime value reaches this
 * function, which is what makes "no mail content ever leaves this module" a
 * property of the type signature rather than of reviewer diligence.
 */
export const formatDegradationNotice = (state: DegradationState): NoticeText => NOTICE_TEXT[state];

/**
 * Announce a degradation state change once, if it differs from the last
 * announced one.
 *
 * Never throws: the caller is the scan path (including its failure path), and a
 * notice is strictly less important than the scan it rides on.
 */
export const announceDegradationIfChanged = async (
  runtime: Pick<MailSentinelRuntime, "statePath" | "sendMatrixRoomMessage">,
  state: DegradationState,
  now: Date = new Date(),
): Promise<NoticeOutcome> => {
  const recordPath = degradationNoticePathFor(runtime.statePath);

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
  const outcome = await announceUnderLock(runtime, state, now, recordPath);
  await lock.close();
  // `force` already tolerates an absent lock, so this needs no extra guard.
  await rm(lockPath, { force: true });
  return outcome;
};

const announceUnderLock = async (
  runtime: Pick<MailSentinelRuntime, "statePath" | "sendMatrixRoomMessage">,
  state: DegradationState,
  now: Date,
  recordPath: string,
): Promise<NoticeOutcome> => {
  try {
    const previous = await readAnnouncedState(recordPath);
    if (!shouldAnnounce(previous, state)) {
      // Either the state is holding, or this is a fresh node whose first
      // observation is healthy. Record the baseline so a later recovery notice
      // has something to transition away from, but stay quiet.
      if (previous !== state) {
        await writeJsonFile(recordPath, {
          announcedState: state,
          announcedAt: now.toISOString(),
        });
      }
      return { announced: false, reason: "unchanged" };
    }

    await runtime.sendMatrixRoomMessage(formatDegradationNotice(state));
    // Persist ONLY after Matrix accepted the message. If the send threw we
    // never get here, so the next scan retries rather than silently losing the
    // notice — which for a degradation alert is the whole point.
    await writeJsonFile(recordPath, {
      announcedState: state,
      announcedAt: now.toISOString(),
    });
    return { announced: true, reason: "announced" };
  } catch {
    // Covers a failed send and an unwritable record. The scan continues.
    return { announced: false, reason: "send-failed" };
  }
};
