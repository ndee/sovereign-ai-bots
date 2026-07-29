import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { defineConfig } from "tsup";

/**
 * Build identity baked into bot bundles.
 *
 * Resolved here, at build time, because the shipped release bundle strips
 * `.git` — the running process cannot derive any of this for itself, and the
 * updater must not trust on-disk JSON as proof that the installed code runs.
 *
 * Every value degrades to "unknown" rather than to a guess: a wrong commit is
 * far worse than an absent one, since the updater compares it against the
 * signed release manifest.
 */
const UNKNOWN = "unknown";

const readPackageVersion = (): string => {
  try {
    const parsed: unknown = JSON.parse(readFileSync("package.json", "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === "string" && version.length > 0) {
        return version;
      }
    }
  } catch {
    // Fall through to UNKNOWN — never guess a version.
  }
  return UNKNOWN;
};

const readGitCommit = (): string => {
  // SOURCE_COMMIT lets a build from an exported tree (no .git) still carry a
  // true commit, supplied by whoever did the export.
  const supplied = process.env.SOURCE_COMMIT?.trim();
  if (supplied !== undefined && /^[0-9a-f]{40}$/.test(supplied)) {
    return supplied;
  }
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
};

const readReleaseId = (): string => {
  const supplied = process.env.SOVEREIGN_RELEASE_ID?.trim();
  return supplied !== undefined && supplied.length > 0 ? supplied : UNKNOWN;
};

/**
 * A bot's version comes from its own manifest, not the root package.json:
 * bots version independently, and the updater compares each bot's runtime
 * identity against its own pin in the signed release manifest.
 */
const readBotManifestVersion = (botId: string): string => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(`bots/${botId}/sovereign-bot.json`, "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === "string" && version.length > 0) {
        return version;
      }
    }
  } catch {
    // Fall through to UNKNOWN — never guess a version.
  }
  return UNKNOWN;
};

const BUILD_DEFINES = {
  __MAIL_SENTINEL_VERSION__: JSON.stringify(readPackageVersion()),
  __MAIL_SENTINEL_COMMIT__: JSON.stringify(readGitCommit()),
  __SOVEREIGN_RELEASE_ID__: JSON.stringify(readReleaseId()),
  __BUILD_TIMESTAMP__: JSON.stringify(new Date().toISOString()),
};

const NODE_OPERATOR_DEFINES = {
  __NODE_OPERATOR_VERSION__: JSON.stringify(readBotManifestVersion("node-operator")),
  __NODE_OPERATOR_COMMIT__: JSON.stringify(readGitCommit()),
  __SOVEREIGN_RELEASE_ID__: JSON.stringify(readReleaseId()),
  __BUILD_TIMESTAMP__: JSON.stringify(new Date().toISOString()),
};

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
    define: BUILD_DEFINES,
  },
  {
    entry: { "node-operator": "bots/node-operator/src/cli.ts" },
    format: "esm",
    dts: false,
    outDir: "bots/node-operator/workspace/bin/dist",
    target: "node22",
    clean: true,
    splitting: false,
    sourcemap: true,
    shims: false,
    banner: { js: "#!/usr/bin/env node" },
    define: NODE_OPERATOR_DEFINES,
    // The workspace artifact runs standalone from the agent workspace — no
    // node_modules exists there. tsup externalizes package.json dependencies
    // by default, which left `import "zod"` unresolvable at runtime.
    noExternal: ["zod"],
  },
  {
    entry: { "project-sentinel": "bots/project-sentinel/src/cli.ts" },
    format: "esm",
    dts: false,
    outDir: "bots/project-sentinel/workspace/bin/dist",
    target: "node22",
    clean: true,
    splitting: false,
    sourcemap: true,
    shims: false,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: { "reality-alignment": "bots/reality-alignment/src/cli.ts" },
    format: "esm",
    dts: false,
    outDir: "bots/reality-alignment/workspace/bin/dist",
    target: "node22",
    clean: true,
    splitting: false,
    sourcemap: true,
    shims: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
