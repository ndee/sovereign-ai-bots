/**
 * Signal mails the shipped rules do not lift to the candidate threshold yet,
 * with the score they get today. They are reported on every run instead of
 * failing it. The list may only shrink: a gap that starts clearing the
 * threshold fails the suite until it is removed here and asserted like every
 * other signal in `scoring/rules-recall.test.ts`.
 */
export const KNOWN_GAPS: readonly { id: string; score: number }[] = [];
