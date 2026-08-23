import { compactText } from "../util/normalize.js";

/**
 * Minimum-necessary body text for the semantic reviewer (pro#377).
 *
 * The first 500 characters of a mail body used to go to the LLM verbatim —
 * quoted replies (other people's mail), signature blocks (names, titles, phone
 * numbers), tracking URLs, and account identifiers included. None of that is
 * needed to decide whether a mail needs a decision, has financial relevance,
 * or signals risk. This module is pure: it strips the parts that carry
 * third-party or identifying data, masks what is left, and caps the result.
 *
 * Order matters: quotes and signatures are cut on the raw, line-structured
 * text (a `>` prefix and a `-- ` line only exist before whitespace is
 * collapsed), then URL/IBAN/phone masking runs on the survivor, then the
 * result is compacted and capped.
 */

/** Hard cap applied after stripping, in characters. */
export const MAX_LLM_SNIPPET_LENGTH = 300;

/** Placeholder the reviewer sees instead of a full URL. */
const URL_PLACEHOLDER = (domain: string): string => `<url:${domain}>`;
const PHONE_PLACEHOLDER = "<phone>";
const IBAN_PLACEHOLDER = "<iban>";

// Lines that start a quoted reply. Everything from the first match onward is
// dropped. Patterns are anchored to a line start and kept deliberately narrow:
// an "On ... wrote:" header must end with "wrote:" (optionally on the next
// line, since clients wrap it), "Von:" / "From:" must be a bare header line.
const QUOTE_HEADER_LINE_RE =
  /^(?:\s*(?:on|am)\s.{0,200}?(?:wrote|schrieb)(?:\s.{0,40})?:\s*$|\s*-{2,}\s*(?:original message|ursprüngliche nachricht|urspruengliche nachricht|forwarded message|weitergeleitete nachricht)\s*-{2,}\s*$|\s*(?:von|from|de):\s+\S.*$)/iu;

// Multi-line "On <date>\n<person> wrote:" header: the first line starts with
// "On"/"Am" and a later line (within two) ends with "wrote:"/"schrieb:".
const QUOTE_HEADER_START_RE = /^\s*(?:on|am)\s/iu;
const QUOTE_HEADER_END_RE = /(?:wrote|schrieb)(?:\s.{0,40})?:\s*$/iu;

// RFC 3676 signature separator: dash-dash-space on its own line (the space is
// often stripped by clients, so a bare "--" line counts too).
const SIGNATURE_SEPARATOR_RE = /^--\s?$/u;

// Trailing sign-off lines. Only applied to the tail of the surviving lines so
// a mail that happens to open with "Thanks" is not emptied.
const SIGN_OFF_LINE_RE =
  /^\s*(?:(?:best|kind|warm)\s+regards|regards|best|cheers|thanks(?:\s+again)?|thank\s+you|sincerely|yours\s+(?:sincerely|truly)|sent\s+from\s+my\s+\S+|mit\s+freundlichen\s+grüßen|mit\s+freundlichen\s+gruessen|freundliche\s+grüße|viele\s+grüße|liebe\s+grüße|beste\s+grüße|schöne\s+grüße|gruß|grüße|mfg|vg|lg)\s*[,.!]?\s*$/iu;

const MAX_SIGN_OFF_TAIL_LINES = 5;

const URL_RE = /\b(?:https?:\/\/|www\.)([^\s/?#<>"']+)[^\s<>"']*/giu;

// International or national numbers with at least 7 digits in total,
// separated by spaces, dots, dashes, slashes or parentheses. The digit count
// is checked in the replacer so that years, amounts and short codes survive.
const PHONE_CANDIDATE_RE = /(?:\+|\(?\b0)\d[\d\s()./-]{5,}\d\b/gu;
const MIN_PHONE_DIGITS = 7;

// IBAN: two letters, two check digits, 11–30 alphanumerics, optional spaces
// every four characters. Anchored on word boundaries so ordinary words are
// not eaten.
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/gu;

const countDigits = (value: string): number => value.replace(/\D/gu, "").length;

const isQuoteHeaderAt = (lines: readonly string[], index: number): boolean => {
  const line = lines[index] as string;
  if (QUOTE_HEADER_LINE_RE.test(line)) {
    return true;
  }
  if (!QUOTE_HEADER_START_RE.test(line)) {
    return false;
  }
  // Clients wrap the attribution line; look ahead up to two more lines.
  for (let lookahead = 1; lookahead <= 2; lookahead += 1) {
    const next = lines[index + lookahead];
    if (next === undefined) {
      return false;
    }
    if (QUOTE_HEADER_END_RE.test(next)) {
      return true;
    }
  }
  return false;
};

/** Drop quoted replies: `>`-prefixed lines and everything from a quote header onward. */
export const stripQuotedReplies = (text: string): string => {
  const lines = text.split(/\r?\n/u);
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (isQuoteHeaderAt(lines, index)) {
      break;
    }
    if (/^\s*>/u.test(line)) {
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
};

/** Drop the signature block (`-- ` separator onward) and trailing sign-off lines. */
export const stripSignature = (text: string): string => {
  const lines = text.split(/\r?\n/u);
  const separatorIndex = lines.findIndex((line) => SIGNATURE_SEPARATOR_RE.test(line));
  const body = separatorIndex === -1 ? lines : lines.slice(0, separatorIndex);
  // Trim trailing blank lines, then cut at the last sign-off line if it sits
  // in the final third of the text (a sign-off is followed only by the
  // signature, which is what we want to drop).
  let end = body.length;
  while (end > 0 && (body[end - 1] as string).trim().length === 0) {
    end -= 1;
  }
  const trimmed = body.slice(0, end);
  // A sign-off is followed by a short signature (name, title, company, phone),
  // so it is searched for in the last third of the text or the last five
  // lines, whichever reaches further up.
  const floor = Math.max(
    0,
    Math.min(Math.floor((trimmed.length * 2) / 3), trimmed.length - MAX_SIGN_OFF_TAIL_LINES),
  );
  for (let index = trimmed.length - 1; index >= floor; index -= 1) {
    if (SIGN_OFF_LINE_RE.test(trimmed[index] as string)) {
      return trimmed.slice(0, index).join("\n");
    }
  }
  return trimmed.join("\n");
};

/** Replace URLs with `<url:domain>` so tracking paths and tokens never leave the node. */
export const maskUrls = (text: string): string =>
  text.replace(URL_RE, (_match, host: string) => URL_PLACEHOLDER(host.toLowerCase()));

/** Mask phone-number-like digit runs (7+ digits with phone separators). */
export const maskPhoneNumbers = (text: string): string =>
  text.replace(PHONE_CANDIDATE_RE, (match) =>
    countDigits(match) >= MIN_PHONE_DIGITS ? PHONE_PLACEHOLDER : match,
  );

/** Mask IBAN-like account identifiers. */
export const maskIbans = (text: string): string => text.replace(IBAN_RE, IBAN_PLACEHOLDER);

/**
 * Produce the snippet the semantic reviewer receives: quoted replies and
 * signatures removed, URLs/phones/IBANs masked, whitespace compacted, capped
 * at {@link MAX_LLM_SNIPPET_LENGTH} characters. Always returns a string.
 */
export const sanitizeSnippet = (text: unknown): string => {
  const raw = typeof text === "string" ? text : "";
  const withoutQuotes = stripQuotedReplies(raw);
  const withoutSignature = stripSignature(withoutQuotes);
  // IBANs before phones: a phone mask would otherwise eat the digit groups of
  // an IBAN and leave its country/check prefix behind.
  const masked = maskPhoneNumbers(maskIbans(maskUrls(withoutSignature)));
  return compactText(masked).slice(0, MAX_LLM_SNIPPET_LENGTH);
};
