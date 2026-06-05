import type { BulkConfig, ParsedMessage, Zone } from "../types.js";

/**
 * Outcome of bulk/newsletter detection for a single message. Deterministic,
 * header- and text-based only — no network, no LLM. `signals` is the reusable,
 * human-readable list of named cues (shared with #106's explain surface), and
 * `ceiling` is the zone cap this detection implies (or `null` when the message
 * is not bulk and nothing should be suppressed).
 */
export interface BulkDetectionResult {
  isBulk: boolean;
  /** 0..1, the share of the weighted signal budget the message tripped. */
  confidence: number;
  signals: string[];
  ceiling: Zone | null;
}

const NEUTRAL_RESULT: BulkDetectionResult = {
  isBulk: false,
  confidence: 0,
  signals: [],
  ceiling: null,
};

// Bulk-infra headers beyond list-unsubscribe that mailing platforms attach.
// Presence of any one is a single "bulk infrastructure" signal (not one per
// header) so a heavily-instrumented campaign does not run away with the score.
const BULK_INFRA_HEADERS = [
  "list-id",
  "list-unsubscribe-post",
  "feedback-id",
  "x-campaign",
  "x-campaignid",
  "x-mailgun-campaign-id",
  "x-csa-complaints",
] as const;

// Campaign / newsletter language across subject + body. English and German
// markers — matches the bilingual posture of the heuristic rules.
const CAMPAIGN_LANGUAGE_RE =
  /\b(view (?:this email )?in (?:your )?browser|unsubscribe|manage (?:your )?(?:email )?preferences|update your preferences|you(?:'re| are) receiving this|this email was sent to|email was sent to|newsletter|abmelden|im browser ansehen|newsletter abbestellen|keine e-?mails mehr)\b/iu;

// Sender local-parts typical of automated bulk senders.
const NOREPLY_SENDER_RE =
  /^(?:no-?reply|do-?not-?reply|newsletter|news|mailer|mailing|notifications?|marketing|campaign|updates?)\b/iu;

const URL_RE = /https?:\/\//giu;

// Confidence is a count divided by a positive denominator, so it is never
// negative — only the upper bound can be exceeded (clamped signal counts).
const clampUpper = (value: number): number => (value > 1 ? 1 : value);

const localPart = (address: string): string => {
  const at = address.indexOf("@");
  return (at === -1 ? address : address.slice(0, at)).toLowerCase();
};

/**
 * Detect bulk/newsletter signals on a message and map them to a zone ceiling.
 *
 * Conservative by design: a message is only treated as bulk when it trips at
 * least `config.minSignals` distinct signals (default 2). This protects
 * transactional mail riding bulk infrastructure — a receipt from `noreply@`
 * carrying a lone `list-unsubscribe` header has one signal and is left alone.
 *
 * Confidence is the weighted share of signals present; `config.grayConfidence`
 * splits the cap between `gray` (clearly bulk) and `amber` (likely bulk).
 * Returns a neutral, non-suppressing result when detection is disabled.
 */
export const detectBulkSignals = (
  message: Pick<ParsedMessage, "headers" | "subject" | "text" | "fromAddress" | "from">,
  config: BulkConfig,
): BulkDetectionResult => {
  if (!config.enabled) {
    return NEUTRAL_RESULT;
  }

  const signals: string[] = [];
  const headers = message.headers;

  if (typeof headers["list-unsubscribe"] === "string" && headers["list-unsubscribe"].length > 0) {
    signals.push("list-unsubscribe header");
  }

  if (
    BULK_INFRA_HEADERS.some(
      (name) => typeof headers[name] === "string" && (headers[name] as string).length > 0,
    ) ||
    /\bbulk\b/iu.test(headers.precedence ?? "")
  ) {
    signals.push("bulk-mail infrastructure headers");
  }

  const linkCount = (message.text.match(URL_RE) ?? []).length;
  if (linkCount >= config.minLinks) {
    signals.push(`high link density (${String(linkCount)} links)`);
  }

  const haystack = `${message.subject}\n${message.text}`;
  if (CAMPAIGN_LANGUAGE_RE.test(haystack)) {
    signals.push("newsletter / campaign language");
  }

  const sender = localPart(message.fromAddress ?? message.from);
  if (NOREPLY_SENDER_RE.test(sender)) {
    signals.push("automated bulk sender address");
  }

  // Confidence is the share of the (capped) signal budget that fired. The
  // denominator is the number of signals required to call something bulk
  // "with full confidence" — twice the threshold — so tripping exactly
  // `minSignals` lands mid-range and the gray/amber split is meaningful.
  const fullConfidenceSignals = Math.max(config.minSignals * 2, config.minSignals + 1);
  const confidence = clampUpper(signals.length / fullConfidenceSignals);

  if (signals.length < config.minSignals) {
    return { isBulk: false, confidence, signals, ceiling: null };
  }

  const ceiling: Zone = confidence >= config.grayConfidence ? "gray" : "amber";
  return { isBulk: true, confidence, signals, ceiling };
};
