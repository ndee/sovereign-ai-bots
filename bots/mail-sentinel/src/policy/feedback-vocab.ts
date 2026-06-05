import type { FeedbackAction } from "../types.js";

/**
 * The canonical feedback vocabulary — the single source of truth for how a
 * free-form user utterance becomes one of the system's {@link FeedbackAction}s.
 *
 * Internal action ids stay kebab-case (no enum rename, per #108): user phrasings
 * are *synonyms* that fold onto these ids. The deterministic Tier-1 table here is
 * the consistency anchor; when a control-plane LLM is asked to interpret a
 * low-confidence/unknown utterance it is constrained to *exactly* this action
 * set (see {@link FEEDBACK_ACTION_VOCABULARY}) so it can never invent an action.
 */

/** A canonical action paired with the plain-words label shown back to the user. */
export interface FeedbackActionVocabularyEntry {
  /** Internal kebab-case id used everywhere downstream. */
  action: FeedbackAction;
  /** Short label echoed in confirmations ("interpreted as …"). */
  label: string;
  /** Representative example phrases — also advertised as hints, never a grammar. */
  examples: readonly string[];
}

/**
 * The full canonical vocabulary, ordered for stable presentation. This is the
 * verbatim table handed to the LLM Tier-2 fallback so its output is bounded to
 * known actions.
 */
export const FEEDBACK_ACTION_VOCABULARY: readonly FeedbackActionVocabularyEntry[] = [
  {
    action: "always-like-this",
    label: "always alert",
    examples: ["always alert me", "always treat like this", "always notify me about these"],
  },
  {
    action: "digest-only",
    label: "digest only",
    examples: ["put these only in the digest", "digest only", "just summarize these"],
  },
  {
    action: "mute",
    label: "hide these",
    examples: ["hide these", "I don't want to see this anymore", "stop showing me these"],
  },
  {
    action: "less-often",
    label: "less of this",
    examples: ["less of this", "less often", "show me fewer of these"],
  },
  {
    action: "not-important",
    label: "not important",
    examples: ["not important", "this isn't important", "doesn't matter"],
  },
  {
    action: "important",
    label: "important",
    examples: ["this is important", "very important", "this matters"],
  },
  {
    action: "remind-later",
    label: "remind me later",
    examples: ["remind me later", "remind me about this later", "snooze this"],
  },
  {
    action: "reduce",
    label: "reduce these",
    examples: ["reduce these", "tone these down", "deprioritize these"],
  },
] as const;

/** Plain-words label for a canonical action (for confirmation microcopy). */
export const feedbackActionLabel = (action: FeedbackAction): string => {
  const entry = FEEDBACK_ACTION_VOCABULARY.find((candidate) => candidate.action === action);
  return entry === undefined ? action : entry.label;
};

/**
 * Synonym phrases mapped to canonical actions. Keys are normalized (lowercased,
 * punctuation stripped, whitespace collapsed) at match time, so authoring here
 * can stay readable. Order does not matter: an utterance that hits more than one
 * action is reported as ambiguous rather than silently resolved to the first.
 */
const SYNONYMS: ReadonlyArray<readonly [phrase: string, action: FeedbackAction]> = [
  // important
  ["important", "important"],
  ["this is important", "important"],
  ["thats important", "important"],
  ["very important", "important"],
  ["really important", "important"],
  ["super important", "important"],
  ["this matters", "important"],
  ["this matters to me", "important"],
  ["keep alerting me", "important"],
  ["mark as important", "important"],
  ["flag as important", "important"],
  // not-important
  ["not important", "not-important"],
  ["this isnt important", "not-important"],
  ["this is not important", "not-important"],
  ["unimportant", "not-important"],
  ["doesnt matter", "not-important"],
  ["dont care", "not-important"],
  ["not relevant", "not-important"],
  ["mark as not important", "not-important"],
  // less-often
  ["less of this", "less-often"],
  ["less often", "less-often"],
  ["fewer of these", "less-often"],
  ["show me fewer of these", "less-often"],
  ["show fewer", "less-often"],
  ["less frequently", "less-often"],
  ["not so often", "less-often"],
  // reduce
  ["reduce these", "reduce"],
  ["reduce", "reduce"],
  ["tone these down", "reduce"],
  ["tone it down", "reduce"],
  ["deprioritize these", "reduce"],
  ["deprioritise these", "reduce"],
  ["lower priority", "reduce"],
  // digest-only
  ["digest only", "digest-only"],
  ["only in the digest", "digest-only"],
  ["put these only in the digest", "digest-only"],
  ["put these in the digest", "digest-only"],
  ["just the digest", "digest-only"],
  ["just summarize these", "digest-only"],
  ["just summarise these", "digest-only"],
  ["summary only", "digest-only"],
  ["dont alert just digest", "digest-only"],
  // always-like-this
  ["always alert me", "always-like-this"],
  ["always alert", "always-like-this"],
  ["always treat like this", "always-like-this"],
  ["always like this", "always-like-this"],
  ["always notify me about these", "always-like-this"],
  ["always notify me", "always-like-this"],
  ["always treat these the same", "always-like-this"],
  // remind-later
  ["remind me later", "remind-later"],
  ["remind me about this later", "remind-later"],
  ["remind later", "remind-later"],
  ["snooze this", "remind-later"],
  ["snooze", "remind-later"],
  ["come back to this later", "remind-later"],
  // mute
  ["hide these", "mute"],
  ["hide this", "mute"],
  ["i dont want to see this anymore", "mute"],
  ["i dont want to see these anymore", "mute"],
  ["dont want to see this", "mute"],
  ["dont show me these", "mute"],
  ["dont show me this", "mute"],
  ["stop showing me these", "mute"],
  ["stop showing these", "mute"],
  ["mute these", "mute"],
  ["mute this", "mute"],
];

/** Confidence tiers returned by {@link normalizeFeedbackPhrase}. */
export type FeedbackPhraseConfidence = "exact" | "partial" | "none";

export interface FeedbackPhraseMatch {
  /** Resolved canonical action when a single action matched, else undefined. */
  action?: FeedbackAction;
  confidence: FeedbackPhraseConfidence;
  /** The normalized form of the input, for echoing back / debugging. */
  normalized: string;
  /**
   * The synonym phrase that produced an exact match, when {@link confidence}
   * is `"exact"`. Absent for partial/none/ambiguous outcomes.
   */
  matchedPhrase?: string;
  /**
   * Distinct candidate actions when the utterance matched more than one action
   * (ambiguous) — the caller should clarify rather than guess. Present only when
   * more than one action is in play.
   */
  candidates?: readonly FeedbackAction[];
}

// Lowercase, strip punctuation to spaces, collapse runs of whitespace. Keeps the
// matcher tolerant of trailing dots, apostrophes ("don't" -> "dont"), and casing.
const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/['’]/gu, "")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");

/**
 * Tier-1 deterministic normalizer: fold a free-form feedback utterance onto a
 * canonical {@link FeedbackAction}.
 *
 * Resolution discipline (mirrors the alert-target resolver): never silently pick
 * a winner when the evidence is ambiguous.
 *   - exact synonym hit (after normalization) → `{ action, confidence: "exact" }`
 *   - no exact hit → fall back to substring containment of synonym phrases;
 *     a single distinct action wins as `"partial"`; more than one distinct
 *     action → ambiguous (`confidence: "none"`, `candidates` listed, no action)
 *   - nothing matches → `{ confidence: "none" }` (caller escalates to the LLM)
 *
 * Tier-1 is offline, deterministic and fast; the LLM tier handles only the tail
 * it cannot resolve, and is itself constrained to {@link FEEDBACK_ACTION_VOCABULARY}.
 */
export const normalizeFeedbackPhrase = (text: string): FeedbackPhraseMatch => {
  const normalized = normalize(text);
  if (normalized.length === 0) {
    return { confidence: "none", normalized };
  }

  // Exact match first — the whole utterance is a known synonym phrase.
  for (const [phrase, action] of SYNONYMS) {
    if (normalize(phrase) === normalized) {
      return { action, confidence: "exact", normalized, matchedPhrase: phrase };
    }
  }

  // Partial: which synonym phrases are contained in the utterance? Collect the
  // distinct actions they imply. One → partial win; several → ambiguous.
  const matchedActions = new Set<FeedbackAction>();
  for (const [phrase, action] of SYNONYMS) {
    const needle = normalize(phrase);
    if (normalized.includes(needle)) {
      matchedActions.add(action);
    }
  }
  const distinct = [...matchedActions];
  if (distinct.length > 1) {
    return { confidence: "none", normalized, candidates: distinct };
  }
  const [first] = distinct;
  if (first !== undefined) {
    return { action: first, confidence: "partial", normalized };
  }
  return { confidence: "none", normalized };
};
