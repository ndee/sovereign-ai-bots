import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: [
      "src/bin/validate-catalog.ts",
      "src/bin/probe-mail-sentinel-chat-model.ts",
    ],
    format: "esm",
    dts: true,
    outDir: "dist",
    target: "node22",
    clean: true,
    splitting: false,
    sourcemap: false,
  },
  {
    entry: { "mail-sentinel": "bots/mail-sentinel/src/cli.ts" },
    format: "esm",
    dts: false,
    outDir: "bots/mail-sentinel/workspace/bin/dist",
    target: "node22",
    clean: true,
    splitting: false,
    sourcemap: true,
    shims: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
