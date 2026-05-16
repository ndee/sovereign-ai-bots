import { isAbsolute, resolve } from "node:path";

export const nowIso = (): string => new Date().toISOString();

export const stripSingleTrailingNewline = (value: string): string => value.replace(/\r?\n$/, "");

export const resolveRelativeToBase = (value: string, baseDir: string): string =>
  isAbsolute(value) ? value : resolve(baseDir, value);

export const compactText = (value: unknown): string =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

export const isYearMonth = (value: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

export const currentYearMonth = (now: Date = new Date()): string => {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  return `${String(year)}-${String(month).padStart(2, "0")}`;
};

export const yearMonthOf = (isoDate: string): string | undefined => {
  const match = /^(\d{4})-(\d{2})/.exec(isoDate);
  if (match === null) {
    return undefined;
  }
  return `${match[1] as string}-${match[2] as string}`;
};

export const previousYearMonth = (yearMonth: string): string => {
  const parts = yearMonth.split("-");
  const year = Number.parseInt(parts[0] as string, 10);
  const month = Number.parseInt(parts[1] as string, 10);
  if (month <= 1) {
    return `${String(year - 1)}-12`;
  }
  return `${String(year)}-${String(month - 1).padStart(2, "0")}`;
};

export const formatAmount = (amount: number, currency: string): string => {
  const sign = amount < 0 ? "-" : "";
  const absolute = Math.abs(amount);
  const fixed = absolute.toFixed(2);
  return `${sign}${currency} ${fixed}`;
};

export const round2 = (value: number): number => Math.round(value * 100) / 100;

export const sumAmounts = (values: readonly number[]): number =>
  round2(values.reduce((total, value) => total + value, 0));

export const dedupeStrings = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
};
