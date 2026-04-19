import type { CommandOptions } from "../types.js";

export interface ParsedArgs {
  command: string | undefined;
  options: CommandOptions;
}

export const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const args = [...argv];
  const command = args.shift();
  const options: CommandOptions = { json: false };
  if (command === "sources" && args[0] !== undefined && !String(args[0]).startsWith("--")) {
    options.subcommand = args.shift();
  }
  const keyedOptions = new Set(["--instance", "--config-path", "--signal-id", "--action", "--id"]);
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--latest") {
      options.latest = true;
      continue;
    }
    if (token === undefined || !keyedOptions.has(token)) {
      throw new Error(`Unknown argument: ${token}`);
    }
    if (args.length === 0) {
      throw new Error(`Missing value for ${token}`);
    }
    const value = args.shift() as string;
    if (token === "--instance") options.instance = value;
    if (token === "--config-path") options.configPath = value;
    if (token === "--signal-id") options.signalId = value;
    if (token === "--action") options.action = value;
    if (token === "--id") options.id = value;
  }
  return { command, options };
};
