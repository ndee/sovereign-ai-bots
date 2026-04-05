#!/usr/bin/env node

import { resolve } from "node:path";

import { parseCatalogCommand, runCatalogCommand } from "../catalog/validate.js";

async function main(): Promise<number> {
  const command = parseCatalogCommand(process.argv.slice(2));
  return runCatalogCommand(command, resolve(process.cwd()));
}

main().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
