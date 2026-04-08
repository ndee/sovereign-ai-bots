import { isAbsolute, resolve } from "node:path";

import { stripSingleTrailingNewline } from "./normalize.js";

export const resolveRelativeToBase = (value: string, baseDir: string): string =>
  isAbsolute(value) ? value : resolve(baseDir, value);

export const parseJsonSafely = (raw: string): unknown => {
  try {
    return JSON.parse(stripSingleTrailingNewline(raw));
  } catch {
    return null;
  }
};

export const parseRuntimeConfigDocument = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    // JSON5-style runtime config: evaluate as a JS expression inside strict mode.
    // This mirrors the behavior of the original mail-sentinel.mjs — the runtime
    // config is a trusted file shipped alongside the installer.
    return new Function(`"use strict"; return (${raw});`)();
  }
};
