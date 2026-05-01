import type { CommandOptions } from "../types.js";

export interface ParsedArgs {
  command: string | undefined;
  options: CommandOptions;
}

const SUBCOMMAND_HOSTS = new Set(["wish", "checkin", "resistance", "step", "review"]);

const KEYED_OPTIONS = new Set([
  "--instance",
  "--config-path",
  "--title",
  "--description",
  "--query",
  "--label",
  "--note",
  "--energy",
  "--clarity",
  "--congruence",
  "--resistance",
  "--level",
  "--desired-level",
  "--wish",
  "--rationale",
]);

const NUMERIC_OPTIONS = new Set([
  "--energy",
  "--clarity",
  "--congruence",
  "--resistance",
  "--level",
  "--desired-level",
]);

export const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const args = [...argv];
  const command = args.shift();
  const options: CommandOptions = { json: false };
  if (
    typeof command === "string" &&
    SUBCOMMAND_HOSTS.has(command) &&
    args[0] !== undefined &&
    !String(args[0]).startsWith("--")
  ) {
    options.subcommand = args.shift();
  }
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === undefined || !KEYED_OPTIONS.has(token)) {
      throw new Error(`Unknown argument: ${token}`);
    }
    if (args.length === 0) {
      throw new Error(`Missing value for ${token}`);
    }
    const value = args.shift() as string;
    if (token === "--instance") options.instance = value;
    else if (token === "--config-path") options.configPath = value;
    else if (token === "--title") options.title = value;
    else if (token === "--description") options.description = value;
    else if (token === "--query") options.query = value;
    else if (token === "--label") options.label = value;
    else if (token === "--note") options.note = value;
    else if (token === "--wish") options.wish = value;
    else if (token === "--rationale") options.rationale = value;
    else if (NUMERIC_OPTIONS.has(token)) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        throw new Error(`Expected a number for ${token}`);
      }
      if (token === "--energy") options.energy = numeric;
      else if (token === "--clarity") options.clarity = numeric;
      else if (token === "--congruence") options.congruence = numeric;
      else if (token === "--resistance") options.resistance = numeric;
      else if (token === "--level") options.level = numeric;
      else if (token === "--desired-level") options.desiredLevel = numeric;
    }
  }
  return { command, options };
};
