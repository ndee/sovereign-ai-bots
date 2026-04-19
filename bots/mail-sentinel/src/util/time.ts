import type { AlertSummary, StoredAlert } from "../types.js";

export const nowIso = (): string => new Date().toISOString();

export const parseDurationMs = (value: unknown): number => {
  const match = String(value)
    .trim()
    .toLowerCase()
    .match(/^([0-9]+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/);
  if (match === null) {
    throw new Error(`Unsupported duration '${String(value)}'`);
  }
  // Regex capture groups are guaranteed to exist when the regex matches.
  const amount = Number.parseInt(match[1] as string, 10);
  const unit = match[2] as string;
  const multiplier = unit.startsWith("d")
    ? 24 * 60 * 60 * 1000
    : unit.startsWith("h")
      ? 60 * 60 * 1000
      : 60 * 1000;
  return amount * multiplier;
};

export const clampLimit = (value: unknown, max: number): number => {
  if (value === undefined) {
    return max;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Expected a positive integer limit");
  }
  return Math.min(parsed, max);
};

export const startOfLocalDay = (value: string | Date | number): number => {
  const local = new Date(value);
  local.setHours(0, 0, 0, 0);
  return local.getTime();
};

export const isSameLocalDay = (value: string | Date | number, reference: Date): boolean => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && startOfLocalDay(parsed) === startOfLocalDay(reference);
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

export const sortAlertsNewestFirst = <T extends Pick<StoredAlert | AlertSummary, "sentAt">>(
  alerts: readonly T[],
): T[] => alerts.slice().sort((left, right) => right.sentAt.localeCompare(left.sentAt));
