import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { WealthState } from "./types.js";
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

export const createDefaultState = (): WealthState => ({
  version: 1,
  counters: { documents: 0, transactions: 0 },
  documents: [],
  accounts: [],
  transactions: [],
  assets: [],
  liabilities: [],
  snapshots: [],
});

export const migrateState = (value: unknown): WealthState => {
  const source = (value ?? {}) as Partial<WealthState>;
  const defaults = createDefaultState();
  return {
    version: 1,
    lastImportAt: source.lastImportAt,
    lastParseAt: source.lastParseAt,
    counters: {
      documents: Number(source.counters?.documents ?? 0),
      transactions: Number(source.counters?.transactions ?? 0),
    },
    documents: Array.isArray(source.documents) ? source.documents : defaults.documents,
    accounts: Array.isArray(source.accounts) ? source.accounts : defaults.accounts,
    transactions: Array.isArray(source.transactions) ? source.transactions : defaults.transactions,
    assets: Array.isArray(source.assets) ? source.assets : defaults.assets,
    liabilities: Array.isArray(source.liabilities) ? source.liabilities : defaults.liabilities,
    snapshots: Array.isArray(source.snapshots) ? source.snapshots : defaults.snapshots,
  };
};

export const loadState = async (statePath: string): Promise<WealthState> =>
  migrateState(await readJsonFile(statePath, createDefaultState()));

export const saveState = async (statePath: string, state: WealthState): Promise<void> => {
  await writeJsonFile(statePath, state);
};
