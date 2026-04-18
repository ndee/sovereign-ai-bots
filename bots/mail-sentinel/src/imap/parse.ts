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

export const parseReceiverAddresses = (
  to: unknown,
  cc: unknown,
  headers: Record<string, string>,
): string[] => {
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
  add(to);
  add(cc);
  for (const headerKey of ["to", "cc", "delivered-to"]) {
    const value = headers[headerKey];
    if (typeof value === "string" && value.length > 0) {
      add(value);
    }
  }
  return [...seen];
};

export const parseMessage = (summary: ImapSummary, readResult: ImapReadResult): ParsedMessage => {
  const message = readResult.message;
  const messageId = normalizeMessageId(message.messageId ?? summary.messageId);
  const from = parseAddressFromList(message.from ?? summary.from);
  const fromAddress = normalizeEmailAddress(from);
  const text = compactText(message.text ?? "");
  const domain = extractDomain(fromAddress);
  const headers = normalizeHeaderMap(message.headers);
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
    headers,
    toAddresses: parseReceiverAddresses(message.to, message.cc, headers),
    amountSignal: parseHighestAmount(`${message.subject ?? ""}\n${text}`),
    deadlineDetected: detectDeadlineSignal(`${message.subject ?? ""}\n${text}`),
  };
};
