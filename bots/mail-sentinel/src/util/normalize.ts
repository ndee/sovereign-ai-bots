export const normalizeMessageId = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.toLowerCase();
  }
  return trimmed.includes("@") ? `<${trimmed.toLowerCase()}>` : trimmed.toLowerCase();
};

export const normalizeEmailAddress = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = value.match(/<([^>]+)>/);
  const candidate = (match?.[1] ?? value).trim().toLowerCase();
  return candidate.length === 0 ? undefined : candidate;
};

export const extractDomain = (address: unknown): string | undefined => {
  if (typeof address !== "string") {
    return undefined;
  }
  const index = address.lastIndexOf("@");
  if (index < 0 || index === address.length - 1) {
    return undefined;
  }
  return address.slice(index + 1).toLowerCase();
};

export const compactText = (value: unknown): string =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

export const stripSingleTrailingNewline = (value: string): string => value.replace(/\r?\n$/, "");

export const ensureTrailingSlash = (value: string): string =>
  value.endsWith("/") ? value : `${value}/`;

export const normalizeThreadSubject = (value: unknown): string =>
  compactText(
    String(value ?? "")
      .toLowerCase()
      .replace(/^(re|aw|fw|fwd):\s*/i, ""),
  );

export const buildMessageKey = (messageId: string | undefined, uid: unknown): string =>
  messageId === undefined ? `uid:${String(uid)}` : `msg:${messageId}`;

export const matchGlob = (value: unknown, pattern: unknown): boolean => {
  if (typeof value !== "string" || typeof pattern !== "string") {
    return false;
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "iu").test(value);
};

export const createRegex = (rule: { pattern: string; flags?: string | undefined }): RegExp =>
  new RegExp(rule.pattern, rule.flags ?? "iu");
