import type { CommandOptions } from "./types.js";

export interface ParsedArgs {
  command: string | undefined;
  options: CommandOptions;
}

const KEYED_OPTIONS = new Set([
  "--instance",
  "--config-path",
  "--id",
  "--path",
  "--kind",
  "--month",
  "--currency",
  "--institution",
  "--notes",
]);

export const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const args = [...argv];
  const command = args.shift();
  const options: CommandOptions = { json: false };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === undefined || !KEYED_OPTIONS.has(token)) {
      throw new Error(`Unknown argument: ${String(token)}`);
    }
    if (args.length === 0) {
      throw new Error(`Missing value for ${token}`);
    }
    const value = args.shift() as string;
    if (token === "--instance") options.instance = value;
    if (token === "--config-path") options.configPath = value;
    if (token === "--id") options.id = value;
    if (token === "--path") options.path = value;
    if (token === "--kind") options.kind = value;
    if (token === "--month") options.month = value;
    if (token === "--currency") options.currency = value;
    if (token === "--institution") options.institution = value;
    if (token === "--notes") options.notes = value;
  }
  return { command, options };
};
