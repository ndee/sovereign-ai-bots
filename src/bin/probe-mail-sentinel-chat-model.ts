#!/usr/bin/env node

import { resolve } from "node:path";

import { runMailSentinelModelProbe } from "../probe/mail-sentinel-chat-model.js";

async function main(): Promise<number> {
  const result = await runMailSentinelModelProbe(resolve(process.cwd()));
  process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  return result.exitCode;
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
