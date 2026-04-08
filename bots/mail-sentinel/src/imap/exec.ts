import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { stripSingleTrailingNewline } from "../util/normalize.js";

const execFileAsyncImpl = promisify(execFile);

type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options?: Parameters<typeof execFileAsyncImpl>[2],
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

let currentExecFile: ExecFileAsync = execFileAsyncImpl as unknown as ExecFileAsync;

/** Replace the process runner (testing seam). Returns the previous runner. */
export const setExecFileAsync = (next: ExecFileAsync): ExecFileAsync => {
  const previous = currentExecFile;
  currentExecFile = next;
  return previous;
};

export const execFileAsync: ExecFileAsync = (file, args, options) =>
  currentExecFile(file, args, options);

export const resolveSecretRefValue = async (secretRef: unknown): Promise<string> => {
  if (typeof secretRef !== "string" || secretRef.length === 0) {
    throw new Error("Missing secret reference");
  }
  if (secretRef.startsWith("file:")) {
    const value = stripSingleTrailingNewline(await readFile(secretRef.slice(5), "utf8"));
    if (value.length === 0) {
      throw new Error(`Secret file for ${secretRef} is empty`);
    }
    return value;
  }
  if (secretRef.startsWith("env:")) {
    const key = secretRef.slice(4);
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    throw new Error(`Environment variable ${key} is not set`);
  }
  throw new Error(`Unsupported secretRef format: ${secretRef}`);
};
