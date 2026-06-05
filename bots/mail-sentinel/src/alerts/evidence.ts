import { compactText } from "../util/normalize.js";

/**
 * Maximum excerpt size carried on an alert and rendered into Matrix messages.
 * Caps keep the message Matrix-compact and bound the duplicated field copied
 * onto every {@link StoredAlert} at scan time. The line cap is a safety net:
 * snippets are whitespace-collapsed (single line) today, but a future
 * multi-line snippet source must not blow up the layout.
 */
export const EXCERPT_MAX_CHARS = 320;
export const EXCERPT_MAX_LINES = 5;

/**
 * How many signal reasons to surface in the chip before collapsing the rest
 * into a `+N more` suffix. Mirrors `summarizeReasons`' own top-3 cut so the
 * chip and the persisted `reasons` stay aligned.
 */
export const SIGNAL_CHIP_LIMIT = 3;

/**
 * Build the message-evidence excerpt copied onto an alert at scan time.
 *
 * Derived solely from the local message snippet — never a remote fetch — so
 * the alert stays self-contained and survives pruning. The result is capped to
 * {@link EXCERPT_MAX_LINES} lines and {@link EXCERPT_MAX_CHARS} characters, with
 * a trailing `…` when either cap truncates the text. Returns `undefined` when
 * the snippet is missing or empty so callers omit the excerpt block cleanly
 * rather than rendering an empty quote.
 *
 * Truncation is codepoint-safe: we slice via the spread iterator, never by raw
 * UTF-16 units, so a multi-byte character is never split mid-codepoint.
 */
export const buildExcerpt = (snippet: unknown): string | undefined => {
  if (typeof snippet !== "string") {
    return undefined;
  }
  const lines = snippet
    .split(/\r?\n/u)
    .map((line) => compactText(line))
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return undefined;
  }
  let truncated = false;
  let kept = lines;
  if (kept.length > EXCERPT_MAX_LINES) {
    kept = kept.slice(0, EXCERPT_MAX_LINES);
    truncated = true;
  }
  let text = kept.join("\n");
  const codepoints = [...text];
  if (codepoints.length > EXCERPT_MAX_CHARS) {
    // Leave room for the ellipsis so the visible result honours the char cap.
    text = codepoints
      .slice(0, EXCERPT_MAX_CHARS - 1)
      .join("")
      .trimEnd();
    truncated = true;
  }
  return truncated ? `${text}…` : text;
};

/**
 * Render an alert's `reasons` as a compact, human-readable signal chip —
 * `deadline · amount · "DOWN"` style — capping at {@link SIGNAL_CHIP_LIMIT}
 * with a `+N more` suffix when there are extra reasons.
 *
 * This is the single reason-rendering helper: the excerpt's signal chip and
 * (later) the explain output both flow through here so there is one renderer of
 * `reasons`, not two divergent ones. Reasons are compacted and de-duplicated;
 * blank entries are dropped. Returns `undefined` when there is nothing useful
 * to show so callers omit the chip entirely.
 */
export const formatSignalChip = (
  reasons: readonly string[] | undefined,
  limit: number = SIGNAL_CHIP_LIMIT,
): string | undefined => {
  if (!Array.isArray(reasons)) {
    return undefined;
  }
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const reason of reasons) {
    const value = compactText(reason);
    if (value.length === 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    cleaned.push(value);
  }
  if (cleaned.length === 0) {
    return undefined;
  }
  const shown = cleaned.slice(0, limit);
  const overflow = cleaned.length - shown.length;
  const chip = shown.join(" · ");
  return overflow > 0 ? `${chip} · +${String(overflow)} more` : chip;
};
