import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

export const compactText = (value: unknown): string =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

export const stripSingleTrailingNewline = (value: string): string => value.replace(/\r?\n$/, "");

export const resolveRelativeToBase = (value: string, baseDir: string): string =>
  isAbsolute(value) ? value : resolve(baseDir, value);

export const parseJsonSafely = (raw: string): unknown => {
  try {
    return JSON.parse(stripSingleTrailingNewline(raw));
  } catch {
    return null;
  }
};

export const parseRuntimeConfigDocument = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return new Function(`"use strict"; return (${raw});`)();
  }
};

export const ensureTrailingSlash = (value: string): string =>
  value.endsWith("/") ? value : `${value}/`;

export const nowIso = (): string => new Date().toISOString();

export const normalizeTimestamp = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
};

export const parseDurationMs = (value: unknown): number => {
  const match = String(value)
    .trim()
    .toLowerCase()
    .match(/^([0-9]+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/);
  if (match === null) {
    throw new Error(`Unsupported duration '${String(value)}'`);
  }
  const amount = Number.parseInt(match[1] as string, 10);
  const unit = match[2] as string;
  const multiplier = unit.startsWith("d")
    ? 24 * 60 * 60 * 1000
    : unit.startsWith("h")
      ? 60 * 60 * 1000
      : 60 * 1000;
  return amount * multiplier;
};

export const formatConfidenceLabel = (confidence: unknown): string => {
  if (typeof confidence !== "number") {
    return "unknown";
  }
  if (confidence >= 75) {
    return `high (${confidence}%)`;
  }
  if (confidence >= 40) {
    return `medium (${confidence}%)`;
  }
  return `low (${confidence}%)`;
};

export const mergeUniqueStrings = (
  ...groups: ReadonlyArray<readonly string[] | undefined>
): string[] => {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const group of groups) {
    for (const value of group ?? []) {
      if (typeof value !== "string") {
        continue;
      }
      const normalized = compactText(value);
      if (normalized.length === 0 || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      merged.push(normalized);
    }
  }
  return merged;
};

export const normalizeComparable = (value: unknown): string => compactText(value).toLowerCase();

export const countMatchingPhrases = (text: string, candidates: readonly string[]): number => {
  const normalizedText = normalizeComparable(text);
  const matched = new Set<string>();
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeComparable(candidate);
    if (normalizedCandidate.length === 0) {
      continue;
    }
    if (normalizedText.includes(normalizedCandidate)) {
      matched.add(normalizedCandidate);
    }
  }
  return matched.size;
};

export const computeHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

export const decodeHtmlEntities = (value: string): string => {
  const named = value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
  return named
    .replace(/&#([0-9]+);/g, (_match, value_) => String.fromCodePoint(Number(value_)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, value_) =>
      String.fromCodePoint(Number.parseInt(value_, 16)),
    );
};

export const stripHtml = (value: unknown): string =>
  compactText(decodeHtmlEntities(String(value ?? "").replace(/<[^>]+>/g, " ")));

export const createExcerpt = (value: unknown, maxLength: number = 280): string => {
  const normalized = compactText(stripHtml(value));
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
};
