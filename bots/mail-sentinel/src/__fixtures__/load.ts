import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GOLDEN_DIR = resolve(__dirname, "golden");

/**
 * Load a captured golden fixture by its name (e.g. "scoreMessage",
 * "parseArgs.scan"). UUID tokens in the expected output are already
 * normalized to the sentinel 00000000-0000-0000-0000-000000000000 by the
 * capture script — see scripts/capture-mail-sentinel-fixtures.mjs.
 */
export const loadGolden = <T>(name: string): T => {
  const filePath = resolve(GOLDEN_DIR, `${name}.json`);
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
};

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const SENTINEL_UUID = "00000000-0000-0000-0000-000000000000";

/** Recursively replace every UUID in the given value with the sentinel UUID. */
export const normalizeUuids = <T>(value: T): T => {
  if (typeof value === "string") {
    return value.replace(UUID_RE, SENTINEL_UUID) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeUuids) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = normalizeUuids(entry);
    }
    return next as T;
  }
  return value;
};
