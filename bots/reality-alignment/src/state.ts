import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { MAX_STORED_CHECKINS, MAX_STORED_STEPS } from "./constants.js";
import type {
  ActionStep,
  AlignmentCheckin,
  RealityAlignmentState,
  ResistancePattern,
  Wish,
} from "./types.js";
import { stripSingleTrailingNewline } from "./util.js";

export const readJsonFile = async <T>(filePath: string, fallback: T): Promise<T> => {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(stripSingleTrailingNewline(raw)) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
};

export const writeJsonFile = async (filePath: string, value: unknown): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
};

export const createDefaultState = (): RealityAlignmentState => ({
  version: 1,
  wishes: [],
  checkins: [],
  resistance: [],
  steps: [],
});

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

export const migrateState = (value: unknown): RealityAlignmentState => {
  const source = (value ?? {}) as Partial<RealityAlignmentState>;
  return {
    version: 1,
    wishes: asArray<Wish>(source.wishes),
    checkins: asArray<AlignmentCheckin>(source.checkins),
    resistance: asArray<ResistancePattern>(source.resistance),
    steps: asArray<ActionStep>(source.steps),
  };
};

export const pruneState = (state: RealityAlignmentState): RealityAlignmentState => {
  state.checkins = state.checkins
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-MAX_STORED_CHECKINS);
  state.steps = state.steps
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-MAX_STORED_STEPS);
  return state;
};
