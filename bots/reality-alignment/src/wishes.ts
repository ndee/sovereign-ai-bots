import { randomUUID } from "node:crypto";

import type { RealityAlignmentState, Wish, WishStatus } from "./types.js";
import { ensureNonEmptyString, nowIso } from "./util.js";

export const findWish = (state: RealityAlignmentState, query: string): Wish | undefined => {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  const byId = state.wishes.find((wish) => wish.id === trimmed);
  if (byId !== undefined) {
    return byId;
  }
  const byExactTitle = state.wishes.find((wish) => wish.title.toLowerCase() === lower);
  if (byExactTitle !== undefined) {
    return byExactTitle;
  }
  return state.wishes.find((wish) => wish.title.toLowerCase().includes(lower));
};

export const addWish = (
  state: RealityAlignmentState,
  input: { title: string; description?: string | undefined },
): Wish => {
  const title = ensureNonEmptyString(input.title, "title");
  const at = nowIso();
  const wish: Wish = {
    id: randomUUID(),
    title,
    ...(input.description !== undefined ? { description: input.description } : {}),
    status: "active",
    createdAt: at,
    updatedAt: at,
  };
  state.wishes.push(wish);
  return wish;
};

export const setWishStatus = (
  state: RealityAlignmentState,
  query: string,
  status: WishStatus,
): Wish => {
  const wish = findWish(state, query);
  if (wish === undefined) {
    throw new Error(`No wish matched '${query}'`);
  }
  wish.status = status;
  wish.updatedAt = nowIso();
  return wish;
};

export const activeWishes = (state: RealityAlignmentState): Wish[] =>
  state.wishes.filter((wish) => wish.status === "active");
