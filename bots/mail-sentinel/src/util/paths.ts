import { isAbsolute, resolve } from "node:path";

import { stripSingleTrailingNewline } from "./normalize.js";

export const resolveRelativeToBase = (value: string, baseDir: string): string =>
  isAbsolute(value) ? value : resolve(baseDir, value);

export const parseJsonSafely = (raw: string): unknown => {
  try {
    return JSON.parse(stripSingleTrailingNewline(raw));
  } catch {
    return null;
  }
};

/**
 * Parse JSON that may be preceded by non-JSON preamble on the same stream.
 *
 * `lobster exec --shell` runs its command line through `/bin/sh -lc` — a
 * *login* shell — so anything `/etc/profile.d/*` prints lands on stdout ahead
 * of the real payload. On Raspberry Pi OS `wifi-check.sh` emits "Wi-Fi is
 * currently blocked by rfkill." via `gettext -s` (stdout, not stderr), which
 * made every semantic review fail with "returned invalid JSON output" even
 * though the classifier itself was healthy.
 *
 * Strict `JSON.parse` is tried first so clean output keeps its exact current
 * behaviour. Only when that fails do we scan for the first `{` or `[` and
 * retry from there, which recovers the payload without masking a genuinely
 * absent or malformed one (those still return `null`).
 */
export const parseJsonAfterPreamble = (raw: string): unknown => {
  const strict = parseJsonSafely(raw);
  if (strict !== null) {
    return strict;
  }
  const text = stripSingleTrailingNewline(raw);
  const start = text.search(/[[{]/u);
  if (start < 0) {
    return null;
  }
  const candidate = text.slice(start);
  const direct = parseJsonSafely(candidate);
  if (direct !== null) {
    return direct;
  }
  // Trailing noise too (e.g. a closing ``` fence). Walk back from the last
  // matching bracket so the longest valid prefix wins, without attempting a
  // full brace-matching parse.
  const closer = candidate.startsWith("[") ? "]" : "}";
  for (
    let end = candidate.lastIndexOf(closer);
    end > 0;
    end = candidate.lastIndexOf(closer, end - 1)
  ) {
    const parsed = parseJsonSafely(candidate.slice(0, end + 1));
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
};

export const parseRuntimeConfigDocument = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    // JSON5-style runtime config: evaluate as a JS expression inside strict mode.
    // The runtime config is a trusted file shipped alongside the installer.
    return new Function(`"use strict"; return (${raw});`)();
  }
};
