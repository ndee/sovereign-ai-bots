import type { AmountSignal, ParsedMessage } from "../types.js";
import {
  buildMessageKey,
  compactText,
  extractDomain,
  normalizeEmailAddress,
  normalizeMessageId,
  normalizeThreadSubject,
} from "../util/normalize.js";

export const parseAddressFromList = (addresses: unknown): string => {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return "(unknown sender)";
  }
  return String(addresses[0]);
};

export const normalizeHeaderMap = (value: unknown): Record<string, string> => {
  if (Array.isArray(value)) {
    const entries = value.flatMap((entry) => {
      if (entry && typeof entry === "object") {
        const record = entry as { key?: unknown; name?: unknown; value?: unknown };
        const key = compactText(record.key ?? record.name ?? "").toLowerCase();
        const headerValue = record.value;
        if (key.length > 0 && typeof headerValue === "string") {
          return [[key, compactText(headerValue)] as const];
        }
      }
      return [] as const;
    });
    return Object.fromEntries(entries);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).flatMap(([key, headerValue]) => {
        if (Array.isArray(headerValue)) {
          return [[key.toLowerCase(), compactText(headerValue.join(", "))] as const];
        }
        if (typeof headerValue === "string") {
          return [[key.toLowerCase(), compactText(headerValue)] as const];
        }
        return [] as const;
      }),
    );
  }
  return {};
};

export const parseHighestAmount = (text: unknown): AmountSignal | null => {
  const raw = String(text ?? "");
  const patterns = [
    /(?:€|eur|euro|\$|usd)\s*([0-9][0-9.,]*)/giu,
    /([0-9][0-9.,]*)\s*(?:€|eur|euro|\$|usd)/giu,
  ];
  let best: AmountSignal | null = null;
  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern)) {
      // Capture group [1] is guaranteed to exist when the regex matches.
      const numericText = String(match[1]);
      const normalized = numericText
        .replace(/\.(?=.*[,])/g, "")
        .replace(/,(?=\d{3}(?:\D|$))/g, "")
        .replace(/,/g, ".");
      const amount = Number.parseFloat(normalized);
      if (Number.isFinite(amount) && (best === null || amount > best.amount)) {
        best = { amount };
      }
    }
  }
  return best;
};

export const detectDeadlineSignal = (text: unknown): boolean =>
  /\b(heute|today|morgen|tomorrow|friday|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?)\b/i.test(
    String(text ?? ""),
  );

interface ImapSummary {
  uid?: number;
  messageId?: unknown;
  from?: unknown;
  subject?: unknown;
}

interface ImapReadResult {
  message: {
    uid?: number;
    messageId?: unknown;
    from?: unknown;
    to?: unknown;
    cc?: unknown;
    subject?: unknown;
    text?: unknown;
    date?: unknown;
    headers?: unknown;
  };
}

/**
 * Normalize one or more raw address sources (arrays or comma-joined strings)
 * into a de-duplicated, order-preserving list of canonical addresses.
 */
export const collectAddresses = (...sources: unknown[]): string[] => {
  const seen = new Set<string>();
  const add = (raw: unknown): void => {
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        const addr = normalizeEmailAddress(entry);
        if (addr !== undefined) {
          seen.add(addr);
        }
      }
    } else if (typeof raw === "string" && raw.length > 0) {
      for (const part of raw.split(",")) {
        const addr = normalizeEmailAddress(part.trim());
        if (addr !== undefined) {
          seen.add(addr);
        }
      }
    }
  };
  for (const source of sources) {
    add(source);
  }
  return [...seen];
};

export const parseReceiverAddresses = (
  to: unknown,
  cc: unknown,
  headers: Record<string, string>,
): string[] => collectAddresses(to, cc, headers.to, headers.cc, headers["delivered-to"]);

/** Per-recipient-field address buckets, tagged by where the address appeared. */
export interface ReceiverBuckets {
  /** Union of every recipient (backward-compatible `toAddresses`). */
  toAddresses: string[];
  /** Cc recipients only (Cc field + `cc` header). */
  ccAddresses: string[];
  /** Addresses from the `Delivered-To` header. */
  deliveredToAddresses: string[];
  /** Alias / catch-all from `x-original-to`, `envelope-to`, `x-forwarded-to`. */
  aliasTargets: string[];
}

export const parseReceiverBuckets = (
  to: unknown,
  cc: unknown,
  headers: Record<string, string>,
): ReceiverBuckets => ({
  toAddresses: parseReceiverAddresses(to, cc, headers),
  ccAddresses: collectAddresses(cc, headers.cc),
  deliveredToAddresses: collectAddresses(headers["delivered-to"]),
  aliasTargets: collectAddresses(
    headers["x-original-to"],
    headers["envelope-to"],
    headers["x-forwarded-to"],
  ),
});

export const parseMessage = (summary: ImapSummary, readResult: ImapReadResult): ParsedMessage => {
  const message = readResult.message;
  const messageId = normalizeMessageId(message.messageId ?? summary.messageId);
  const from = parseAddressFromList(message.from ?? summary.from);
  const fromAddress = normalizeEmailAddress(from);
  const text = compactText(message.text ?? "");
  const domain = extractDomain(fromAddress);
  const headers = normalizeHeaderMap(message.headers);
  const buckets = parseReceiverBuckets(message.to, message.cc, headers);
  return {
    key: buildMessageKey(messageId, message.uid),
    uid: message.uid as number,
    ...(messageId === undefined ? {} : { messageId }),
    subject: compactText(message.subject ?? summary.subject ?? "(no subject)"),
    normalizedThreadSubject: normalizeThreadSubject(message.subject ?? summary.subject ?? ""),
    from,
    ...(fromAddress === undefined ? {} : { fromAddress }),
    ...(domain === undefined ? {} : { domain }),
    ...(typeof message.date === "string" ? { date: message.date } : {}),
    text,
    snippet: text.slice(0, 500),
    ...(typeof message.text === "string" ? { bodyText: message.text } : {}),
    headers,
    toAddresses: buckets.toAddresses,
    ...(buckets.ccAddresses.length === 0 ? {} : { ccAddresses: buckets.ccAddresses }),
    ...(buckets.deliveredToAddresses.length === 0
      ? {}
      : { deliveredToAddresses: buckets.deliveredToAddresses }),
    ...(buckets.aliasTargets.length === 0 ? {} : { aliasTargets: buckets.aliasTargets }),
    amountSignal: parseHighestAmount(`${message.subject ?? ""}\n${text}`),
    deadlineDetected: detectDeadlineSignal(`${message.subject ?? ""}\n${text}`),
  };
};
