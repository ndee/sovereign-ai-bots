import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KNOWN_GAPS } from "../__fixtures__/recall/known-gaps.js";
import { parseMessage } from "../imap/parse.js";
import { evaluatePolicy } from "../policy/engine.js";
import { createDefaultPolicy, createDefaultState } from "../state/schema.js";
import type { RulesDocument } from "../types.js";
import { scoreMessage } from "./heuristics.js";

// Recall of the shipped keyword rules over synthetic look-alike mails, with no
// LLM and no network. A mail below the candidate threshold is graded gray
// "rules-only" by scan and never reaches the semantic reviewer, so every mail
// in the signal set must clear it on rules alone.

const MAIL_CLASSES = ["signal", "noise", "daily", "edge"] as const;
type MailClass = (typeof MAIL_CLASSES)[number];

/** One mail as the `imap-read-mail` tool delivers it to `parseMessage`. */
interface RecallFixture {
  id: string;
  why: string;
  message: {
    uid: number;
    messageId: string;
    from: string[];
    to: string[];
    subject?: string;
    date: string;
    text: string;
    headers: { key: string; value: string }[];
  };
}

interface RecallOutcome {
  id: string;
  mailClass: MailClass;
  score: number;
  scoreModifier: number;
  threshold: number;
  reachesReview: boolean;
  matchedRuleIds: string[];
}

const readJson = <T>(relativePath: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf-8")) as T;

const rules = readJson<RulesDocument>("../../workspace/config/default-rules.json");

const fixtures: Record<MailClass, RecallFixture[]> = Object.fromEntries(
  MAIL_CLASSES.map((mailClass) => [
    mailClass,
    readJson<RecallFixture[]>(`../__fixtures__/recall/${mailClass}.json`),
  ]),
) as Record<MailClass, RecallFixture[]>;

const evaluate = (fixture: RecallFixture, mailClass: MailClass): RecallOutcome => {
  const { message } = fixture;
  const summary = {
    uid: message.uid,
    messageId: message.messageId,
    from: message.from,
    subject: message.subject,
  };
  const parsed = parseMessage(summary, { message });
  // A fresh state and an empty policy: nothing learned, no alerts to continue
  // a thread from, no operator policy. Only the shipped rules decide.
  const scored = scoreMessage(parsed, createDefaultState(), rules);
  const policyResult = evaluatePolicy(
    parsed,
    scored,
    createDefaultPolicy(),
    new Date(message.date),
  );
  // The inverse of the condition under which scan records a mail as gray
  // "rules-only" without asking the reviewer.
  const reachesReview = !(
    !scored.candidate &&
    policyResult.zoneFloor === null &&
    scored.score + policyResult.scoreModifier < rules.thresholds.candidate
  );
  return {
    id: fixture.id,
    mailClass,
    score: scored.score,
    scoreModifier: policyResult.scoreModifier,
    threshold: rules.thresholds.candidate,
    reachesReview,
    matchedRuleIds: scored.matchedRuleIds,
  };
};

const outcomes: Record<MailClass, RecallOutcome[]> = Object.fromEntries(
  MAIL_CLASSES.map((mailClass) => [
    mailClass,
    fixtures[mailClass].map((fixture) => evaluate(fixture, mailClass)),
  ]),
) as Record<MailClass, RecallOutcome[]>;

const knownGapIds = new Set(KNOWN_GAPS.map((gap) => gap.id));

const rulesText = (outcome: RecallOutcome): string =>
  outcome.matchedRuleIds.length === 0 ? "no rule matched" : outcome.matchedRuleIds.join(", ");

const describeOutcome = (outcome: RecallOutcome): string =>
  `${outcome.id}: score ${String(outcome.score)} + policy ${String(outcome.scoreModifier)} < ${String(outcome.threshold)} (${rulesText(outcome)})`;

describe("rules recall over the synthetic mail set", () => {
  it("has a non-trivial, well-formed fixture set", () => {
    const all = MAIL_CLASSES.flatMap((mailClass) =>
      fixtures[mailClass].map((fixture) => ({ mailClass, fixture })),
    );
    for (const mailClass of MAIL_CLASSES) {
      expect(fixtures[mailClass].length, `${mailClass} fixtures`).toBeGreaterThan(0);
    }
    expect(fixtures.signal.length).toBeGreaterThanOrEqual(20);
    for (const { mailClass, fixture } of all) {
      expect(fixture.id.startsWith(`${mailClass}-`), fixture.id).toBe(true);
      expect(fixture.why.length, fixture.id).toBeGreaterThan(0);
    }
    const ids = all.map(({ fixture }) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
    const uids = all.map(({ fixture }) => fixture.message.uid);
    expect(new Set(uids).size).toBe(uids.length);
  });

  it("lifts every signal mail outside KNOWN_GAPS to the candidate threshold on the shipped rules", () => {
    const asserted = outcomes.signal.filter((outcome) => !knownGapIds.has(outcome.id));
    const misses = asserted.filter((outcome) => !outcome.reachesReview);
    expect(
      misses.map(describeOutcome),
      `${String(misses.length)} of ${String(asserted.length)} asserted signal mails stay below the candidate threshold`,
    ).toEqual([]);
  });

  it("names only signal fixtures in KNOWN_GAPS", () => {
    const signalIds = new Set(fixtures.signal.map((fixture) => fixture.id));
    expect(KNOWN_GAPS.filter((gap) => !signalIds.has(gap.id))).toEqual([]);
    expect(knownGapIds.size).toBe(KNOWN_GAPS.length);
  });

  it("reports every known gap and fails once one clears the threshold", () => {
    const gaps = KNOWN_GAPS.map((gap) => ({
      gap,
      outcome: outcomes.signal.find((outcome) => outcome.id === gap.id) as RecallOutcome,
    }));
    const lines = gaps.map(
      ({ gap, outcome }) =>
        `${gap.id}: score ${String(outcome.score)} (recorded ${String(gap.score)}) < ${String(outcome.threshold)} (${rulesText(outcome)})`,
    );
    console.info(`rules recall known gaps (${String(gaps.length)})\n${lines.join("\n")}`);
    const cleared = gaps
      .filter(({ outcome }) => outcome.reachesReview)
      .map(
        ({ gap, outcome }) =>
          `${gap.id} now scores ${String(outcome.score)}: remove it from KNOWN_GAPS so it is asserted`,
      );
    expect(cleared).toEqual([]);
  });

  it("reports how many noise, daily and edge mails reach the reviewer", () => {
    // Reported, not asserted: these counts are a baseline to watch while the
    // rules change, not a contract yet.
    const lines = (["noise", "daily", "edge"] as const).map((mailClass) => {
      const reached = outcomes[mailClass].filter((outcome) => outcome.reachesReview);
      const names = reached.map((outcome) => `${outcome.id} (${String(outcome.score)})`);
      return `${mailClass}: ${String(reached.length)}/${String(outcomes[mailClass].length)} reach the reviewer${names.length === 0 ? "" : ` – ${names.join(", ")}`}`;
    });
    console.info(`rules recall baseline\n${lines.join("\n")}`);
    expect(lines).toHaveLength(3);
  });
});
