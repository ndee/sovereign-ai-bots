/**
 * Trusted bridge to the `sovereign-node` CLI.
 *
 * This module is the ONLY place Node Operator executes anything, and it only
 * ever executes the node CLI with a fixed, code-controlled argument vector via
 * `execFile` (argv array, no shell, no interpolation). The Matrix agent's exec
 * allowlist grants it just this bot's own binary; whatever free text a room
 * member types can therefore never become arguments to `sovereign-node` —
 * the deterministic commands in `commands/` decide the argv, not the LLM.
 *
 * Output handling is equally strict: stdout is parsed as JSON and validated;
 * on any failure the caller gets a typed error, never raw stderr, because
 * command output may contain paths or system detail that must not reach chat.
 */

import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";

/** Where the node CLI lives, in probe order. */
export const NODE_CLI_CANDIDATES = [
  // Git/open-core installs and maintained nodes with the CLI shim.
  "/usr/local/bin/sovereign-node",
  // Web-installed maintained nodes: the core package inside the Pro API tree.
  "/opt/sovereign-pro-api/node_modules/sovereign-ai-node/dist/sovereign-node.js",
] as const;

/** Hard bound on captured CLI output. Diagnostics JSON is a few KiB. */
export const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Diagnostics runs the doctor's systemd probes; give it room, but bounded. */
export const NODE_CLI_TIMEOUT_MS = 60_000;

export type NodeCliInvocation = {
  command: string;
  args: string[];
};

export type NodeCliRunner = (args: readonly string[]) => Promise<NodeCliResult>;

export type NodeCliResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: "cli-not-found" | "exec-failed" };

type FileExists = (path: string) => Promise<boolean>;

const defaultFileExists: FileExists = async (path) => {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Locate the node CLI. `SOVEREIGN_NODE_CLI` wins when set (used by tests and
 * unusual layouts); `.js` candidates run under the current node binary so the
 * probe works regardless of the script's exec bit.
 */
export const resolveNodeCli = async (
  env: Record<string, string | undefined> = process.env,
  fileExists: FileExists = defaultFileExists,
): Promise<NodeCliInvocation | undefined> => {
  const override = env.SOVEREIGN_NODE_CLI?.trim();
  const candidates = override?.startsWith("/")
    ? [override, ...NODE_CLI_CANDIDATES]
    : [...NODE_CLI_CANDIDATES];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate.endsWith(".js")
        ? { command: process.execPath, args: [candidate] }
        : { command: candidate, args: [] };
    }
  }
  return undefined;
};

/**
 * Execute the node CLI with a fixed argv. Never throws: callers render a safe
 * message from the typed reason instead of an exception trace.
 */
export const runNodeCli = async (
  args: readonly string[],
  resolve: () => Promise<NodeCliInvocation | undefined> = resolveNodeCli,
): Promise<NodeCliResult> => {
  const resolved = await resolve();
  if (resolved === undefined) {
    return { ok: false, reason: "cli-not-found" };
  }
  return await new Promise<NodeCliResult>((resolve) => {
    execFile(
      resolved.command,
      [...resolved.args, ...args],
      {
        timeout: NODE_CLI_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: process.env,
      },
      (error, stdout) => {
        if (error !== null) {
          resolve({ ok: false, reason: "exec-failed" });
          return;
        }
        resolve({ ok: true, stdout });
      },
    );
  });
};
