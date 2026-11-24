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

const GERMAN_FOLDS: Readonly<Record<string, string>> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  Ä: "Ae",
  Ö: "Oe",
  Ü: "Ue",
  ß: "ss",
  ẞ: "SS",
};

/**
 * Rewrite text into the ASCII spelling the rule patterns use, so `\b` (which
 * only knows ASCII word characters) sees "Rückmeldung" as one word and
 * "rueckmeldung" matches it. German umlauts take their two-letter spelling;
 * every other diacritic is dropped.
 */
export const foldForMatching = (value: string): string =>
  value
    .normalize("NFC")
    .replace(/[äöüÄÖÜßẞ]/gu, (letter) => GERMAN_FOLDS[letter] as string)
    .normalize("NFD")
    .replace(/\p{M}/gu, "");

export const createRegex = (rule: { pattern: string; flags?: string | undefined }): RegExp =>
  new RegExp(rule.pattern, rule.flags ?? "iu");

/**
 * {@link createRegex} on the folded pattern. Folding can turn a valid character
 * range into an invalid one (`[x-ä]` becomes `[x-ae]`); such a rule then keeps
 * only its raw match instead of failing the whole scan.
 */
export const createFoldedRegex = (rule: {
  pattern: string;
  flags?: string | undefined;
}): RegExp | null => {
  try {
    return createRegex({ ...rule, pattern: foldForMatching(rule.pattern) });
  } catch {
    return null;
  }
};

/**
 * Escape every regex metacharacter in user-supplied text so it can be used as a
 * literal substring pattern. Unlike {@link matchGlob}, `*` is escaped literally
 * (no wildcard semantics) — this powers `policy add --contains <text>`.
 */
export const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
