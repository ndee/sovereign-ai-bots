import type { CommandOptions } from "./types.js";

export const printOutput = <T>(
  result: T,
  options: Pick<CommandOptions, "json">,
  formatter: (value: T) => string,
): void => {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatter(result)}\n`);
};

export const joinLines = (lines: ReadonlyArray<string | undefined>): string =>
  lines.filter((line): line is string => typeof line === "string").join("\n");
