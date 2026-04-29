import { isAbsolute, resolve } from "node:path";

export const stripSingleTrailingNewline = (value: string): string => value.replace(/\r?\n$/, "");

export const resolveRelativeToBase = (value: string, baseDir: string): string =>
  isAbsolute(value) ? value : resolve(baseDir, value);

export const parseRuntimeConfigDocument = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return new Function(`"use strict"; return (${raw});`)();
  }
};

export const nowIso = (): string => new Date().toISOString();

export const compactText = (value: unknown): string =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

export const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

export const clampScore = (value: unknown): 1 | 2 | 3 | 4 | 5 => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error("Expected a numeric score between 1 and 5");
  }
  const rounded = Math.round(numeric);
  if (rounded < 1 || rounded > 5) {
    throw new Error("Expected a score between 1 and 5");
  }
  return rounded as 1 | 2 | 3 | 4 | 5;
};

export const ensureNonEmptyString = (value: unknown, fieldName: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Expected a non-empty value for ${fieldName}`);
  }
  return value.trim();
};
