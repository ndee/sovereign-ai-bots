import { CATEGORY_LABELS } from "../constants.js";
import type { AlertSummary, StoredAlert } from "../types.js";
import { formatConfidenceLabel } from "../util/time.js";
import { formatSignalChip } from "./evidence.js";
import { deriveShortRef } from "./short-ref.js";

type AlertKind = AlertSummary["kind"];

// The short handle shown to users for an alert: the persisted `shortRef` when
// present, else a derived prefix of `alertId` so older stored alerts (minted
// before the field existed) still render and stay resolvable.
export const alertShortRef = (alert: Pick<StoredAlert, "alertId" | "shortRef">): string =>
  typeof alert.shortRef === "string" && alert.shortRef.length > 0
    ? alert.shortRef
    : deriveShortRef(alert.alertId);

export interface MatrixMessageBody {
  body: string;
  formattedBody: string;
}

const ALERT_FEEDBACK_OPTIONS = [
  "very important",
  "not important",
  "remind later",
  "always treat like this",
  "less of this",
] as const;

const DIGEST_FEEDBACK_OPTIONS = [
  "very important",
  "not important",
  "always treat like this",
  "less of this",
  "digest only",
] as const;

const ZONE_EMOJI: Record<string, string> = {
  red: "🔴",
  amber: "🟠",
  gray: "⚪",
};

const DIGEST_SUBJECT_MAX = 120;
export const DIGEST_VISIBLE_LIMIT = 10;

const categoryLabel = (category: string): string => CATEGORY_LABELS[category] ?? category;

const zoneLabel = (zone: unknown): string => String(zone ?? "red").toUpperCase();

const DEFAULT_ZONE_EMOJI = "🔴";

const zoneEmoji = (zone: unknown): string => {
  const key = String(zone ?? "red").toLowerCase();
  return ZONE_EMOJI[key] ?? DEFAULT_ZONE_EMOJI;
};

const formatCategoryConfidence = (category: string, confidence: unknown): string =>
  `${categoryLabel(category)} · ${formatConfidenceLabel(confidence)}`;

// Conservatively shorten overly long subjects so a single item doesn't blow
// up the digest layout. Non-destructive: we only trim, never rewrite.
const trimSubject = (subject: string): string =>
  subject.length <= DIGEST_SUBJECT_MAX
    ? subject
    : `${subject.slice(0, DIGEST_SUBJECT_MAX - 1).trimEnd()}…`;

// Extract a calm operator-facing sender display from a raw From header.
// Preference order:
//   1. Display name, when present: `"Alice" <alice@example.com>` -> `Alice`.
//   2. Local part minus any `+alias` tag, when only a bare address is given:
//      `billing+invoice@privex.com` -> `billing`.
//      `sovereign-ai-node-test+decision@proton.me` -> `sovereign-ai-node-test`.
//   3. The raw string, trimmed, as a last resort.
// Full address is never lost: callers still have `alert.from` internally.
export const formatSenderDisplay = (from: string): string => {
  const displayName = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/u.exec(from);
  if (displayName !== null) {
    const name = (displayName[1] as string).trim();
    if (name.length > 0) {
      return name;
    }
  }
  const bareAddress = /^\s*([^\s<>@]+)@[^\s<>]+\s*$/u.exec(from);
  if (bareAddress !== null) {
    const localPart = (bareAddress[1] as string).split("+")[0] as string;
    if (localPart.length > 0) {
      return localPart;
    }
  }
  return from.trim();
};

// Strip synthetic/test suffix patterns that leak into visible subjects via
// the live e2e fixtures. Matches `e2e-<digits>` anywhere, plus any
// kebab-tag-wrapper directly preceding it (e.g. `invoice-overdue-e2e-123`),
// and any `—`/`-`/`:` separator immediately before. Preserves the stored
// subject; only the visible headline is cleaned.
const E2E_TAG_TOKEN = /\s*[—\-:]?\s*(?:[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*-)?e2e-\d+/giu;

export const cleanSubjectForDisplay = (subject: string): string =>
  subject
    .replace(E2E_TAG_TOKEN, "")
    .replace(/\s{2,}/gu, " ")
    .trim();

// HTML escape for interpolated user/sender/subject strings. Kept minimal
// because Matrix clients render a small HTML subset.
const escapeHtml = (value: string): string =>
  value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");

const renderCodeOptions = (options: readonly string[]): string =>
  options.map((option) => `<code>${escapeHtml(option)}</code>`).join(" · ");

// Render the message-evidence excerpt as a quote so it reads as "the email
// said". Plain text prefixes each line with `> `; HTML wraps the escaped,
// `<br>`-joined lines in a <blockquote>. The excerpt is already capped/escaped
// safe at the source (`buildExcerpt`), but we still HTML-escape on render so
// untrusted message content can never inject markup.
const renderExcerptLines = (excerpt: string): string[] =>
  excerpt.split("\n").map((line) => `> ${line}`);

const renderExcerptHtml = (excerpt: string): string =>
  `<blockquote>${excerpt.split("\n").map(escapeHtml).join("<br>")}</blockquote>`;

export const formatAlertLine = (
  alert: Pick<StoredAlert, "alertId" | "shortRef" | "zone" | "category" | "from" | "subject">,
): string =>
  `- [${alertShortRef(alert)}] ${zoneLabel(alert.zone)} | ${categoryLabel(alert.category)} | ${
    alert.from
  } | ${alert.subject}`;

export const mapAlertToSummary = (
  alert: StoredAlert,
  kind: AlertKind = "new-alert",
): AlertSummary => ({
  alertId: alert.alertId,
  shortRef: alertShortRef(alert),
  kind,
  zone: alert.zone,
  category: alert.category,
  subject: alert.subject,
  from: alert.from,
  why: alert.why,
  sentAt: kind === "reminder" ? (alert.lastReminderAt ?? alert.sentAt) : alert.sentAt,
  ...(typeof alert.confidence === "number" ? { confidence: alert.confidence } : {}),
  ...(alert.messageId === undefined ? {} : { messageId: alert.messageId }),
  ...(alert.feedbackState === "pending" ? {} : { feedbackState: alert.feedbackState }),
});

export const buildRedAlertMessage = (alert: StoredAlert, kind: AlertKind): MatrixMessageBody => {
  const subject = cleanSubjectForDisplay(alert.subject);
  const sender = formatSenderDisplay(alert.from);
  const confidence = formatConfidenceLabel(alert.confidence);
  const category = categoryLabel(alert.category);
  const zone = zoneLabel(alert.zone);
  const emoji = zoneEmoji(alert.zone);
  const reminderSuffix = kind === "reminder" ? " · reminder" : "";
  // Bracketed so the handle reads as a typeable reference, not prose. Users
  // reply "feedback <ref> not important" to target this exact alert.
  const ref = `[${alertShortRef(alert)}]`;
  // Evidence block: a quoted excerpt of what the mail said, plus a signal chip
  // naming the matched reasons in words. Both omitted cleanly when absent so
  // the rest of the alert is unchanged (#102).
  const excerpt = alert.excerpt;
  const signals = formatSignalChip(alert.reasons);

  const bodyLines = [
    `${emoji} ${zone} · ${category}${reminderSuffix}`,
    "",
    `${ref} ${subject}`,
    "",
    `From: ${sender}`,
    `Why it matters: ${alert.why}`,
    ...(excerpt === undefined ? [] : ["", ...renderExcerptLines(excerpt)]),
    ...(signals === undefined ? [] : [`Signals: ${signals}`]),
    `Confidence: ${confidence}`,
    "",
    "Reply in thread with:",
    ALERT_FEEDBACK_OPTIONS.join(" · "),
  ];

  // A <blockquote> is a block element and cannot live inside the meta <p>. With
  // an excerpt we close the <p> after "Why it matters", drop in the blockquote,
  // then resume the meta block (signals + confidence) in a fresh <p>. With no
  // excerpt the original single-<p> meta block (From/Why/[signals]/Confidence)
  // is preserved byte-for-byte so existing alerts render unchanged.
  const signalsHtmlLine =
    signals === undefined ? [] : [`<strong>Signals:</strong> ${escapeHtml(signals)}<br>`];
  const metaHtml =
    excerpt === undefined
      ? [
          "<p>",
          `<strong>From:</strong> ${escapeHtml(sender)}<br>`,
          `<strong>Why it matters:</strong> ${escapeHtml(alert.why)}<br>`,
          ...signalsHtmlLine,
          `<strong>Confidence:</strong> ${escapeHtml(confidence)}`,
          "</p>",
        ]
      : [
          "<p>",
          `<strong>From:</strong> ${escapeHtml(sender)}<br>`,
          `<strong>Why it matters:</strong> ${escapeHtml(alert.why)}`,
          "</p>",
          renderExcerptHtml(excerpt),
          "<p>",
          ...signalsHtmlLine,
          `<strong>Confidence:</strong> ${escapeHtml(confidence)}`,
          "</p>",
        ];

  const formattedBody = [
    `<p>${emoji} <strong>${escapeHtml(`${zone} · ${category}${reminderSuffix}`)}</strong></p>`,
    `<p><code>${escapeHtml(ref)}</code> <strong>${escapeHtml(subject)}</strong></p>`,
    ...metaHtml,
    "<p>",
    "Reply in thread with:<br>",
    renderCodeOptions(ALERT_FEEDBACK_OPTIONS),
    "</p>",
  ].join("\n");

  return { body: bodyLines.join("\n"), formattedBody };
};

export const buildDigestMessage = (
  alerts: readonly StoredAlert[],
  interval: string,
): MatrixMessageBody => {
  const count = alerts.length;
  const zone = "AMBER";
  const emoji = zoneEmoji("amber");
  const headerText = `${zone} DIGEST · ${String(count)} item${count === 1 ? "" : "s"}`;
  const windowLine = `Window: last ${interval}`;
  const visible = alerts.slice(0, DIGEST_VISIBLE_LIMIT);

  const bodyLines: string[] = [`${emoji} ${headerText}`, windowLine];
  const htmlParts: string[] = [
    `<p>${emoji} <strong>${escapeHtml(headerText)}</strong><br>`,
    `${escapeHtml(windowLine)}</p>`,
  ];

  visible.forEach((alert, index) => {
    const subject = trimSubject(cleanSubjectForDisplay(alert.subject));
    const sender = formatSenderDisplay(alert.from);
    const confidence = formatCategoryConfidence(alert.category, alert.confidence);
    const position = String(index + 1);
    // The position is digest-scoped (it shifts between digests); the bracketed
    // ref is stable, so both are shown and either targets this item.
    const ref = `[${alertShortRef(alert)}]`;
    // Per-item evidence so the digest is judgeable without opening the mail:
    // quoted excerpt + signal chip, each omitted cleanly when absent (#102).
    const excerpt = alert.excerpt;
    const signals = formatSignalChip(alert.reasons);

    bodyLines.push(
      "",
      `${position}. ${ref} ${subject}`,
      `From: ${sender}`,
      confidence,
      `Why it matters: ${alert.why}`,
      ...(excerpt === undefined ? [] : renderExcerptLines(excerpt)),
      ...(signals === undefined ? [] : [`Signals: ${signals}`]),
    );
    // A <blockquote> is a block element and cannot sit inside the item <p>, so
    // when an excerpt is present we close the <p> after "Why it matters", emit
    // the blockquote, then carry the signal chip in its own trailing <p>. With
    // no excerpt the chip just appends inside the item <p> (after a <br>).
    htmlParts.push(
      "<p>",
      `<strong>${position}.</strong> <code>${escapeHtml(ref)}</code> <strong>${escapeHtml(subject)}</strong><br>`,
      `<strong>From:</strong> ${escapeHtml(sender)}<br>`,
      `${escapeHtml(confidence)}<br>`,
      `<strong>Why it matters:</strong> ${escapeHtml(alert.why)}${
        excerpt === undefined && signals !== undefined ? "<br>" : ""
      }`,
    );
    if (excerpt === undefined) {
      if (signals !== undefined) {
        htmlParts.push(`<strong>Signals:</strong> ${escapeHtml(signals)}`);
      }
      htmlParts.push("</p>");
    } else {
      htmlParts.push("</p>", renderExcerptHtml(excerpt));
      if (signals !== undefined) {
        htmlParts.push("<p>", `<strong>Signals:</strong> ${escapeHtml(signals)}`, "</p>");
      }
    }
  });

  if (alerts.length > DIGEST_VISIBLE_LIMIT) {
    const overflow = String(alerts.length - DIGEST_VISIBLE_LIMIT);
    bodyLines.push("", `... and ${overflow} more.`);
    htmlParts.push(`<p>… and ${escapeHtml(overflow)} more.</p>`);
  }

  bodyLines.push("", "Reply in thread with:", DIGEST_FEEDBACK_OPTIONS.join(" · "));
  htmlParts.push(
    "<p>",
    "Reply in thread with:<br>",
    renderCodeOptions(DIGEST_FEEDBACK_OPTIONS),
    "</p>",
  );

  return { body: bodyLines.join("\n"), formattedBody: htmlParts.join("\n") };
};
