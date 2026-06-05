import { SHORT_REF_START_LENGTH } from "../constants.js";

// Reduce an alertId to the stable character pool a short ref is drawn from:
// dashes stripped, lowercased. For a UUID this yields its 32 hex digits, but
// any non-empty alertId works — we fall back to the raw value if stripping
// dashes would leave nothing.
const refPool = (alertId: string): string => {
  const stripped = alertId.replace(/-/g, "").toLowerCase();
  return stripped.length > 0 ? stripped : alertId.toLowerCase();
};

/**
 * Derive the canonical short ref for an alertId at a given length, without any
 * collision handling. Used for read-side fallbacks (e.g. summarizing an older
 * stored alert that predates the persisted `shortRef`) so a handle is always
 * available. The result is a prefix of {@link refPool}; if the pool is shorter
 * than `length`, the whole pool is returned.
 */
export const deriveShortRef = (alertId: string, length: number = SHORT_REF_START_LENGTH): string =>
  refPool(alertId).slice(0, Math.max(1, length));

/**
 * Mint a short ref for `alertId` that does not collide with any ref in
 * `existingRefs`. Starts at {@link SHORT_REF_START_LENGTH} and lengthens one
 * character at a time until the prefix is unique, capping at the full pool
 * length (UUIDs cannot collide at full length unless the alertId itself
 * repeats, which the caller prevents).
 */
export const mintShortRef = (
  alertId: string,
  existingRefs: Iterable<string>,
  start: number = SHORT_REF_START_LENGTH,
): string => {
  const taken = new Set<string>();
  for (const ref of existingRefs) {
    taken.add(ref.toLowerCase());
  }
  const pool = refPool(alertId);
  const maxLength = Math.max(start, pool.length);
  for (let length = Math.max(1, start); length <= maxLength; length += 1) {
    const candidate = pool.slice(0, length);
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  // Pool exhausted without a free prefix — every prefix up to the full pool is
  // taken, which means another alert already owns the identical alertId pool.
  // Return the full pool; the caller's alertId uniqueness keeps this unreachable
  // in practice.
  return pool;
};
