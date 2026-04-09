import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  DEFAULT_STATE_LOCK_RETRY_ATTEMPTS,
  DEFAULT_STATE_LOCK_RETRY_DELAY_MS,
  DEFAULT_STATE_LOCK_STALE_MS,
} from "../constants.js";
import { stripSingleTrailingNewline } from "../util/normalize.js";

export const readJsonFile = async <T>(filePath: string, fallback: T): Promise<T> => {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(stripSingleTrailingNewline(raw)) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
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

export const withLockedState = async <T>(
  statePath: string,
  action: () => Promise<T>,
): Promise<T> => {
  const lockPath = `${statePath}.lock`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < DEFAULT_STATE_LOCK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(dirname(lockPath), { recursive: true });
      handle = await open(lockPath, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
        throw error;
      }
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > DEFAULT_STATE_LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      await new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, DEFAULT_STATE_LOCK_RETRY_DELAY_MS);
      });
    }
  }
  if (handle === undefined) {
    throw new Error(`Timed out while waiting for the state lock on ${statePath}`);
  }
  try {
    return await action();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
};
