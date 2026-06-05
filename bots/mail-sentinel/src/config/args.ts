import type { CommandOptions } from "../types.js";

export interface ParsedArgs {
  command: string | undefined;
  options: CommandOptions;
}

export const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const args = [...argv];
  const command = args.shift();
  const options: CommandOptions = {
    json: false,
  };
  if (command === "policy" && args[0] !== undefined && !String(args[0]).startsWith("--")) {
    options.subcommand = args.shift();
  }
  const keyedOptions = new Set([
    "--instance",
    "--config-path",
    "--alert-id",
    "--ref",
    "--action",
    "--delay",
    "--view",
    "--limit",
    "--type",
    "--match",
    "--min-zone",
    "--max-zone",
    "--boost",
    "--reason",
    "--id",
    "--category",
    "--schedule",
    "--pattern",
    "--scope",
    "--target",
    "--contains",
    "--amount-threshold",
    "--query",
  ]);
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--announce") {
      options.announce = true;
      continue;
    }
    if (token === "--latest") {
      options.latest = true;
      continue;
    }
    if (token === "--dry-run") {
      options.dryRun = true;
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
    if (token === "--alert-id") options.alertId = value;
    if (token === "--ref") options.ref = value;
    if (token === "--action") options.action = value as CommandOptions["action"];
    if (token === "--delay") options.delay = value;
    if (token === "--view") options.view = value;
    if (token === "--limit") options.limit = value;
    if (token === "--type") options.type = value;
    if (token === "--match") options.match = value;
    if (token === "--min-zone") options.minZone = value;
    if (token === "--max-zone") options.maxZone = value;
    if (token === "--boost") options.boost = value;
    if (token === "--reason") options.reason = value;
    if (token === "--id") options.id = value;
    if (token === "--category") options.category = value;
    if (token === "--schedule") options.schedule = value;
    if (token === "--pattern") options.pattern = value;
    if (token === "--scope") options.scope = value;
    if (token === "--target") options.target = value;
    if (token === "--contains") options.contains = value;
    if (token === "--amount-threshold") options.amountThreshold = value;
    if (token === "--query") options.query = value;
  }
  return {
    command,
    options,
  };
};
