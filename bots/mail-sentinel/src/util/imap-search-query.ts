import { DEFAULT_LOOKBACK_WINDOW } from "../constants.js";
import { parseDurationMs } from "./time.js";

/**
 * Extra slack subtracted from the lookback bound before it is turned into an
 * IMAP `SINCE` date. IMAP `SEARCH SINCE` compares INTERNALDATE at *day*
 * granularity in the server's notion of the date, so a bound of "one hour ago"
 * that lands just after midnight, or a server whose clock/timezone leads ours,
 * would otherwise drop mail that is inside the window. One extra day covers
 * every timezone skew (max ±14h) plus midnight rollover.
 */
export const IMAP_SEARCH_SINCE_SLACK_MS = 24 * 60 * 60 * 1000;

const formatIsoDate = (value: Date): string => value.toISOString().slice(0, 10);

/**
 * Resolves the earliest calendar day (UTC, `YYYY-MM-DD`) that an IMAP search
 * must cover so that every message inside `lookbackWindow` is returned.
 *
 * An unparseable `lookbackWindow` falls back to {@link DEFAULT_LOOKBACK_WINDOW}
 * rather than to an unbounded search: the whole point of the bound is that a
 * scan must never ask the server for the entire mailbox (bots#142).
 */
export const resolveImapSearchSinceDate = (lookbackWindow: string, now: Date): string => {
  let lookbackMs: number;
  try {
    lookbackMs = parseDurationMs(lookbackWindow);
  } catch {
    lookbackMs = parseDurationMs(DEFAULT_LOOKBACK_WINDOW);
  }
  return formatIsoDate(new Date(now.getTime() - lookbackMs - IMAP_SEARCH_SINCE_SLACK_MS));
};

/**
 * Builds the `imap-search-mail --query` value for a scan.
 *
 * The lookback window is pushed INTO the IMAP search (`SINCE <date>`) instead
 * of being applied after the fact. `SEARCH ALL` makes the server enumerate
 * every UID the mailbox has ever held, which on a real, long-lived mailbox
 * exceeds the tool's socket timeout and fails every scan; `--limit` cannot
 * help because it is applied client-side after the server-side search
 * (bots#142). `since:` is understood by sovereign-tool's query parser and is
 * emitted as an RFC 3501 `SINCE dd-Mon-yyyy` search key.
 */
export const buildLookbackImapSearchQuery = (lookbackWindow: string, now: Date): string =>
  `since:${resolveImapSearchSinceDate(lookbackWindow, now)}`;
