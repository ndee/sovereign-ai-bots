import { randomUUID } from "node:crypto";

import type { RealityAlignmentState, ResistancePattern } from "./types.js";
import { ensureNonEmptyString, nowIso } from "./util.js";

const matches = (pattern: ResistancePattern, query: string): boolean => {
  if (pattern.id === query) {
    return true;
  }
  return pattern.label.toLowerCase() === query.toLowerCase();
};

export const findResistance = (
  state: RealityAlignmentState,
  query: string,
): ResistancePattern | undefined => {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return state.resistance.find((pattern) => matches(pattern, trimmed));
};

export const upsertResistance = (
  state: RealityAlignmentState,
  input: { label: string; description?: string | undefined; linkedWishIds?: string[] | undefined },
): { pattern: ResistancePattern; created: boolean } => {
  const label = ensureNonEmptyString(input.label, "label");
  const at = nowIso();
  const existing = findResistance(state, label);
  if (existing !== undefined) {
    existing.recurrenceCount += 1;
    existing.lastSeenAt = at;
    if (existing.status === "archived" || existing.status === "reduced") {
      existing.status = "active";
    }
    if (input.description !== undefined && input.description.trim().length > 0) {
      existing.description = input.description.trim();
    }
    if (input.linkedWishIds !== undefined) {
      const merged = new Set([...existing.linkedWishIds, ...input.linkedWishIds]);
      existing.linkedWishIds = Array.from(merged);
    }
    return { pattern: existing, created: false };
  }
  const pattern: ResistancePattern = {
    id: randomUUID(),
    label,
    ...(input.description !== undefined && input.description.trim().length > 0
      ? { description: input.description.trim() }
      : {}),
    linkedWishIds: input.linkedWishIds ?? [],
    recurrenceCount: 1,
    lastSeenAt: at,
    status: "active",
  };
  state.resistance.push(pattern);
  return { pattern, created: true };
};

export const resolveResistance = (
  state: RealityAlignmentState,
  query: string,
): ResistancePattern => {
  const pattern = findResistance(state, query);
  if (pattern === undefined) {
    throw new Error(`No resistance pattern matched '${query}'`);
  }
  pattern.status = "reduced";
  pattern.lastSeenAt = nowIso();
  return pattern;
};

export const recurringResistance = (
  state: RealityAlignmentState,
  minRecurrence = 2,
): ResistancePattern[] =>
  state.resistance
    .filter((pattern) => pattern.status === "active" && pattern.recurrenceCount >= minRecurrence)
    .slice()
    .sort((left, right) => right.recurrenceCount - left.recurrenceCount);
