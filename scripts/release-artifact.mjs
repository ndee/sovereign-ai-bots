#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, posix, relative, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const PACKAGE_NAME = "sovereign-ai-bots";
const EXPECTED_BOT_IDS = [
  "bitcoin-skill-match",
  "mail-sentinel",
  "node-operator",
  "project-sentinel",
  "reality-alignment",
];
const ROOT_ENTRYPOINTS = ["dist/probe-mail-sentinel-chat-model.js", "dist/validate-catalog.js"];
const BOT_ENTRYPOINTS = [
  "bots/mail-sentinel/workspace/bin/dist/mail-sentinel.js",
  "bots/project-sentinel/workspace/bin/dist/project-sentinel.js",
  "bots/reality-alignment/workspace/bin/dist/reality-alignment.js",
];
const CURRENT_AVATARS = ["bots/mail-sentinel/avatar.png", "bots/node-operator/avatar.png"];
const ALL_ENTRYPOINTS = [...ROOT_ENTRYPOINTS, ...BOT_ENTRYPOINTS];
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);
const SECRET_PATTERNS = [
  /sk-or-v1-[A-Za-z0-9_-]+/g,
  /syt_[A-Za-z0-9_-]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /gh[pousr]_[A-Za-z0-9]+/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function walkFiles(rootDir, prefix = "") {
  const result = [];
  const visit = async (directory, relativeDirectory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      invariant(
        !entry.isSymbolicLink(),
        `Symlinks are not allowed in release artifacts: ${relativePath}`,
      );
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        result.push(prefix ? `${prefix}/${relativePath}` : relativePath);
      }
    }
  };
  await visit(rootDir, "");
  return result;
}

function parseOptions(args) {
  const options = {};
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  for (let index = 0; index < normalizedArgs.length; index += 2) {
    const key = normalizedArgs[index];
    const value = normalizedArgs[index + 1];
    invariant(key?.startsWith("--"), `Expected an option, got: ${key ?? "<missing>"}`);
    invariant(value !== undefined, `Missing value for ${key}`);
    options[key.slice(2)] = value;
  }
  return options;
}

function runText(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

const TAR_BLOCK_SIZE = 512;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function readTarString(block, offset, length) {
  const field = block.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return utf8Decoder.decode(nul === -1 ? field : field.subarray(0, nul));
}

function readTarOctal(block, offset, length, fieldName) {
  const field = block.subarray(offset, offset + length);
  invariant((field[0] & 0x80) === 0, `Base-256 ${fieldName} is not allowed in release artifacts`);
  const value = field.toString("ascii").replace(/\0.*$/s, "").trim();
  invariant(/^[0-7]+$/.test(value), `Invalid tar ${fieldName}: ${JSON.stringify(value)}`);
  return Number.parseInt(value, 8);
}

function verifyTarChecksum(block) {
  const recorded = readTarOctal(block, 148, 8, "checksum");
  let calculated = 0;
  for (let index = 0; index < block.length; index += 1) {
    calculated += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  invariant(recorded === calculated, "Invalid tar header checksum");
}

function parsePaxAttributes(payload) {
  const attributes = {};
  let offset = 0;
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    invariant(space > offset, "Invalid PAX record length");
    const lengthText = payload.subarray(offset, space).toString("ascii");
    invariant(/^[1-9][0-9]*$/.test(lengthText), "Invalid PAX record length");
    const recordLength = Number.parseInt(lengthText, 10);
    const end = offset + recordLength;
    invariant(end <= payload.length && payload[end - 1] === 0x0a, "Truncated PAX record");
    const record = utf8Decoder.decode(payload.subarray(space + 1, end - 1));
    const equals = record.indexOf("=");
    invariant(equals > 0, "Invalid PAX key/value record");
    const key = record.slice(0, equals);
    invariant(attributes[key] === undefined, `Duplicate PAX attribute: ${key}`);
    invariant(key === "path", `PAX attribute is not allowed: ${key}`);
    attributes[key] = record.slice(equals + 1);
    offset = end;
  }
  invariant(
    typeof attributes.path === "string" && Object.keys(attributes).length === 1,
    "A local PAX header must contain exactly one path attribute",
  );
  return attributes;
}

function canonicalArchivePath(rawPath, isDirectory, rawPaths, normalizedPaths) {
  invariant(rawPath.length > 0, "Archive entry has an empty path");
  invariant(
    ![...rawPath].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    }),
    `Archive path contains a control character: ${JSON.stringify(rawPath)}`,
  );
  invariant(!rawPath.includes("\\"), `Archive path contains a backslash: ${rawPath}`);
  const comparable = isDirectory && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
  invariant(!rawPaths.has(comparable), `Duplicate archive path: ${comparable}`);
  rawPaths.add(comparable);

  invariant(!comparable.startsWith("/"), `Archive contains an absolute path: ${rawPath}`);
  const segments = comparable.split("/");
  invariant(
    !segments.some((segment) => segment === "" || segment === "." || segment === ".."),
    `Archive contains a non-canonical path: ${rawPath}`,
  );
  const unicodeNormalized = comparable.normalize("NFC");
  const normalized = posix.normalize(unicodeNormalized);
  invariant(
    !normalizedPaths.has(normalized),
    `Duplicate normalized archive path: ${rawPath} aliases ${normalized}`,
  );
  normalizedPaths.add(normalized);
  invariant(
    comparable === unicodeNormalized && comparable === normalized,
    `Archive contains a non-canonical path: ${rawPath}`,
  );
  invariant(
    normalized === "package" || normalized.startsWith("package/"),
    `Archive entry is outside the package root: ${rawPath}`,
  );
  return normalized;
}

function inspectTarBuffer(compressed) {
  let archive;
  try {
    archive = gunzipSync(compressed);
  } catch (error) {
    throw new Error(`Release artifact is not valid gzip: ${error}`);
  }
  const entries = [];
  const rawPaths = new Set();
  const normalizedPaths = new Set();
  let pendingPax;
  let offset = 0;
  let sawEnd = false;
  while (offset + TAR_BLOCK_SIZE <= archive.length) {
    const block = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
    offset += TAR_BLOCK_SIZE;
    if (block.every((byte) => byte === 0)) {
      sawEnd = true;
      break;
    }
    verifyTarChecksum(block);
    const size = readTarOctal(block, 124, 12, "size");
    const type = String.fromCharCode(block[156] || 0x30);
    const name = readTarString(block, 0, 100);
    const prefix = readTarString(block, 345, 155);
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const paddedSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    invariant(offset + paddedSize <= archive.length, `Truncated tar payload for ${headerPath}`);
    const payload = archive.subarray(offset, offset + size);
    offset += paddedSize;

    if (type === "x") {
      invariant(pendingPax === undefined, "Multiple PAX headers target one archive entry");
      pendingPax = parsePaxAttributes(payload);
      invariant(pendingPax.linkpath === undefined, "PAX link paths are not allowed");
      continue;
    }
    invariant(type !== "g", "Global PAX headers are not allowed in release artifacts");
    invariant(
      type === "0" || type === "5",
      `Archive entry type ${JSON.stringify(type)} is not a regular file or directory: ${headerPath}`,
    );
    const entryPath = pendingPax?.path ?? headerPath;
    pendingPax = undefined;
    const normalized = canonicalArchivePath(entryPath, type === "5", rawPaths, normalizedPaths);
    entries.push({ path: normalized, type: type === "5" ? "directory" : "file" });
  }
  invariant(sawEnd, "Tar archive has no end marker");
  invariant(pendingPax === undefined, "PAX header is missing its target entry");
  invariant(
    archive.subarray(offset).every((byte) => byte === 0),
    "Tar archive contains trailing non-zero data",
  );
  invariant(entries.length > 0, "Release artifact is empty");
  return entries;
}

function validateArchivePaths(artifactPath) {
  return inspectTarBuffer(readFileSync(artifactPath));
}

function writeTarString(block, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  invariant(bytes.length <= length, `Test tar field is too long: ${value}`);
  bytes.copy(block, offset);
}

function writeTarOctal(block, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  invariant(encoded.length === length - 1, `Test tar number is too large: ${value}`);
  block.write(encoded, offset, length - 1, "ascii");
  block[offset + length - 1] = 0;
}

function createTarFixture(entries) {
  const blocks = [];
  for (const entry of entries) {
    const contents = Buffer.from(entry.contents ?? "", "utf8");
    const header = Buffer.alloc(TAR_BLOCK_SIZE);
    writeTarString(header, 0, 100, entry.path);
    writeTarOctal(header, 100, 8, entry.mode ?? 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, contents.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    if (entry.linkname !== undefined) writeTarString(header, 157, 100, entry.linkname);
    writeTarString(header, 257, 6, "ustar");
    writeTarString(header, 263, 2, "00");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    const checksumText = checksum.toString(8).padStart(6, "0");
    header.write(checksumText, 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    blocks.push(header, contents);
    const padding = Math.ceil(contents.length / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE - contents.length;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));
  return gzipSync(Buffer.concat(blocks));
}

function createPaxRecord(key, value) {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 2;
  while (true) {
    const nextLength = Buffer.byteLength(body) + String(length).length + 1;
    if (nextLength === length) return `${length} ${body}`;
    length = nextLength;
  }
}

function expectArchiveRejection(label, entries, expectedMessage) {
  let message;
  try {
    inspectTarBuffer(createTarFixture(entries));
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  invariant(message !== undefined, `Unsafe ${label} archive was accepted`);
  invariant(
    message.includes(expectedMessage),
    `${label} archive failed for the wrong reason: ${message}`,
  );
}

function runArchivePreflightNegativeTests() {
  expectArchiveRejection(
    "duplicate-path",
    [{ path: "package/repeated" }, { path: "package/repeated" }],
    "Duplicate archive path",
  );
  expectArchiveRejection(
    "normalized-duplicate-path",
    [{ path: "package/caf\u00e9" }, { path: "package/cafe\u0301" }],
    "Duplicate normalized archive path",
  );
  expectArchiveRejection(
    "path-traversal",
    [{ path: "package/ok/../../outside" }],
    "non-canonical path",
  );
  for (const [label, type] of [
    ["hardlink", "1"],
    ["symlink", "2"],
    ["character-device", "3"],
    ["block-device", "4"],
    ["fifo", "6"],
  ]) {
    expectArchiveRejection(
      label,
      [{ path: `package/${label}`, type, linkname: "package/target" }],
      "is not a regular file or directory",
    );
  }
  for (const [label, key] of [
    ["PAX-size-override", "size"],
    ["PAX-GNU-sparse-override", "GNU.sparse.size"],
  ]) {
    expectArchiveRejection(
      label,
      [
        {
          path: `PaxHeaders/${label}`,
          type: "x",
          contents: createPaxRecord(key, "4096"),
        },
        { path: `package/${label}`, contents: "safe" },
      ],
      `PAX attribute is not allowed: ${key}`,
    );
  }
  console.log(
    "Rejected unsafe tar entry types, PAX overrides, duplicates, normalized aliases, and traversal",
  );
}

async function withExtractedArtifact(artifactPath, callback) {
  validateArchivePaths(artifactPath);
  const extractRoot = await mkdtemp(join(tmpdir(), "sovereign-ai-bots-artifact-"));
  try {
    execFileSync("tar", ["-xzf", artifactPath, "-C", extractRoot], { stdio: "pipe" });
    const packageRoot = join(extractRoot, "package");
    invariant(await exists(packageRoot), "Archive is missing its package/ root");
    return await callback(packageRoot);
  } finally {
    await rm(extractRoot, { recursive: true, force: true });
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function loadBots(packageRoot) {
  const bots = [];
  const botRoot = join(packageRoot, "bots");
  const entries = await readdir(botRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(botRoot, entry.name, "sovereign-bot.json");
    invariant(await exists(manifestPath), `Missing manifest for bot directory: ${entry.name}`);
    const manifest = await readJson(manifestPath);
    invariant(
      manifest.id === entry.name,
      `Manifest id does not match bot directory: ${entry.name}`,
    );
    invariant(SEMVER.test(manifest.version), `Invalid bot version for ${entry.name}`);
    invariant(
      SEMVER.test(manifest.agentTemplate?.version),
      `Invalid agent template version for ${entry.name}`,
    );
    bots.push({
      id: manifest.id,
      manifestVersion: manifest.version,
      templateVersion: manifest.agentTemplate.version,
    });
  }
  bots.sort((left, right) => left.id.localeCompare(right.id));
  invariant(
    JSON.stringify(bots.map(({ id }) => id)) === JSON.stringify(EXPECTED_BOT_IDS),
    `Artifact bot set must be exactly: ${EXPECTED_BOT_IDS.join(", ")}`,
  );
  return bots;
}

async function createComponentRelease(artifactPath, tag, commitSha) {
  return withExtractedArtifact(artifactPath, async (packageRoot) => {
    const packageJson = await readJson(join(packageRoot, "package.json"));
    invariant(packageJson.name === PACKAGE_NAME, `Unexpected package name: ${packageJson.name}`);
    invariant(SEMVER.test(packageJson.version), `Invalid catalog version: ${packageJson.version}`);
    invariant(
      tag === `v${packageJson.version}`,
      `Tag ${tag} does not match v${packageJson.version}`,
    );
    invariant(SHA.test(commitSha), `Invalid release commit SHA: ${commitSha}`);
    const artifactStat = await stat(artifactPath);
    return {
      schemaVersion: 1,
      component: PACKAGE_NAME,
      version: packageJson.version,
      tag,
      commitSha,
      assets: [
        {
          name: basename(artifactPath),
          size: artifactStat.size,
          sha256: await sha256(artifactPath),
        },
      ],
      bots: await loadBots(packageRoot),
    };
  });
}

function isAllowedArchiveFile(path) {
  if (
    path === "package/package.json" ||
    path === "package/pnpm-lock.yaml" ||
    path === "package/README.md" ||
    ROOT_ENTRYPOINTS.some((entrypoint) => path === `package/${entrypoint}`)
  ) {
    return true;
  }
  if (/^package\/(?:LICENSE|LICENCE|COPYING|NOTICE)(?:\.[^/]+)?$/i.test(path)) {
    return true;
  }
  return /^package\/bots\/[^/]+\/(?:sovereign-bot\.json|avatar\.png|workspace\/.+)$/.test(path);
}

function assertCuratedPaths(files) {
  for (const path of files) {
    invariant(isAllowedArchiveFile(path), `Unexpected file in release artifact: ${path}`);
    invariant(!/(?:^|\/)\.git(?:\/|$)/.test(path), `Git metadata leaked into artifact: ${path}`);
    invariant(
      !/(?:^|\/)\.(?:github|agent-deck)(?:\/|$)/.test(path),
      `CI/development metadata leaked into artifact: ${path}`,
    );
    invariant(!/(?:^|\/)src(?:\/|$)/.test(path), `Source leaked into artifact: ${path}`);
    invariant(!/(?:^|\/)__fixtures__(?:\/|$)/.test(path), `Fixture leaked into artifact: ${path}`);
    invariant(!/\.(?:test|spec)\.[^/]+$/.test(path), `Test leaked into artifact: ${path}`);
    invariant(!/\.map$/.test(path), `Source map leaked into artifact: ${path}`);
    invariant(!/\.log$/.test(path), `Log leaked into artifact: ${path}`);
    invariant(!/^package\/docs\//.test(path), `Documentation source leaked into artifact: ${path}`);
    invariant(
      !/^package\/(?:alert-room|service-bot)\.png$/.test(path),
      `Root screenshot/avatar leaked into artifact: ${path}`,
    );
    invariant(
      !/(?:^|\/)node_modules(?:\/|$)/.test(path),
      `node_modules leaked into artifact: ${path}`,
    );
  }
}

async function expectedSourcePayload(sourceRoot) {
  const expected = new Set([
    "package/package.json",
    "package/pnpm-lock.yaml",
    "package/README.md",
    ...ROOT_ENTRYPOINTS.map((path) => `package/${path}`),
  ]);
  const botsDir = join(sourceRoot, "bots");
  const botEntries = await readdir(botsDir, { withFileTypes: true });
  for (const botEntry of botEntries) {
    if (!botEntry.isDirectory()) continue;
    const botPrefix = `bots/${botEntry.name}`;
    const manifestPath = join(sourceRoot, botPrefix, "sovereign-bot.json");
    invariant(await exists(manifestPath), `Source bot is missing a manifest: ${botEntry.name}`);
    expected.add(`package/${botPrefix}/sovereign-bot.json`);
    const avatarPath = join(sourceRoot, botPrefix, "avatar.png");
    if (await exists(avatarPath)) expected.add(`package/${botPrefix}/avatar.png`);
    const workspacePath = join(sourceRoot, botPrefix, "workspace");
    for (const workspaceFile of await walkFiles(workspacePath)) {
      expected.add(`package/${botPrefix}/workspace/${workspaceFile}`);
    }
  }
  return [...expected].sort();
}

function assertEqualPaths(actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((path) => !actualSet.has(path));
  const extra = actual.filter((path) => !expectedSet.has(path));
  invariant(missing.length === 0, `Artifact is missing source payload:\n${missing.join("\n")}`);
  invariant(extra.length === 0, `Artifact has unexpected payload:\n${extra.join("\n")}`);
}

async function assertRequiredPayload(packageRoot, files, bots) {
  invariant(
    await exists(join(packageRoot, "pnpm-lock.yaml")),
    "Artifact is missing pnpm-lock.yaml",
  );
  for (const bot of bots) {
    const workspace = join(packageRoot, "bots", bot.id, "workspace");
    const workspaceFiles = await walkFiles(workspace);
    invariant(
      workspaceFiles.some((path) => path.endsWith(".md")),
      `Bot workspace has no Markdown prompt payload: ${bot.id}`,
    );
    const manifest = await readJson(join(packageRoot, "bots", bot.id, "sovereign-bot.json"));
    for (const resource of manifest.hostResources ?? []) {
      const source = resource?.spec?.source;
      if (typeof source === "string") {
        invariant(
          await exists(join(packageRoot, "bots", bot.id, source)),
          `Manifest resource is missing from artifact: bots/${bot.id}/${source}`,
        );
      }
    }
  }
  for (const avatar of CURRENT_AVATARS) {
    invariant(files.includes(`package/${avatar}`), `Required avatar is missing: ${avatar}`);
  }
  const actualBotEntrypoints = files
    .filter((path) => /^package\/bots\/[^/]+\/workspace\/bin\/dist\/[^/]+\.js$/.test(path))
    .map((path) => path.slice("package/".length))
    .sort();
  invariant(
    JSON.stringify(actualBotEntrypoints) === JSON.stringify(BOT_ENTRYPOINTS),
    `Compiled bot entrypoints must be exactly: ${BOT_ENTRYPOINTS.join(", ")}`,
  );
}

async function assertPackageDependencies(packageRoot) {
  const packageJson = await readJson(join(packageRoot, "package.json"));
  invariant(
    JSON.stringify(packageJson.dependencies) === JSON.stringify({ zod: "^4.1.5" }),
    "The production dependency contract must remain exactly zod ^4.1.5",
  );
  const entrypointSources = await Promise.all(
    ALL_ENTRYPOINTS.map((entrypoint) => readFile(join(packageRoot, entrypoint), "utf8")),
  );
  const importPattern = /(?:^|\n)\s*import\s+(?:(?:[^"'`;]+?)\s+from\s+)?["']([^"']+)["']/g;
  for (let index = 0; index < entrypointSources.length; index += 1) {
    for (const match of entrypointSources[index].matchAll(importPattern)) {
      const specifier = match[1];
      invariant(
        specifier.startsWith(".") || BUILTINS.has(specifier),
        `Unbundled runtime dependency in ${ALL_ENTRYPOINTS[index]}: ${specifier}`,
      );
    }
  }
}

async function assertNoSecrets(packageRoot, files) {
  for (const path of files) {
    const contents = await readFile(join(packageRoot, path.slice("package/".length)));
    const text = contents.toString("utf8");
    for (const pattern of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      invariant(!pattern.test(text), `Possible secret found in release artifact: ${path}`);
    }
  }
}

function runEntrypoint(path, args, packageRoot, expectedStatus) {
  const result = spawnSync(path, args, {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, OPENROUTER_API_KEY: "" },
  });
  invariant(
    result.error === undefined,
    `Could not execute ${relative(packageRoot, path)}: ${result.error}`,
  );
  invariant(
    result.status === expectedStatus,
    `${relative(packageRoot, path)} exited ${result.status}: ${result.stderr || result.stdout}`,
  );
  return result;
}

async function assertEntrypointsRun(packageRoot, bots, component) {
  for (const entrypoint of ALL_ENTRYPOINTS) {
    const path = join(packageRoot, entrypoint);
    const entrypointStat = await stat(path);
    invariant((entrypointStat.mode & 0o111) !== 0, `Entrypoint is not executable: ${entrypoint}`);
    invariant(
      (await readFile(path, "utf8")).startsWith("#!/usr/bin/env node\n"),
      `Entrypoint has no Node shebang: ${entrypoint}`,
    );
    await chmod(path, entrypointStat.mode | 0o700);
  }

  runEntrypoint(join(packageRoot, "dist/validate-catalog.js"), ["lint"], packageRoot, 0);
  runEntrypoint(join(packageRoot, "dist/probe-mail-sentinel-chat-model.js"), [], packageRoot, 0);
  const versionResult = runEntrypoint(
    join(packageRoot, "bots/mail-sentinel/workspace/bin/dist/mail-sentinel.js"),
    ["version", "--json"],
    packageRoot,
    0,
  );
  const versionJson = JSON.parse(versionResult.stdout);
  const mailManifestVersion = bots.find(({ id }) => id === "mail-sentinel")?.manifestVersion;
  invariant(
    versionJson.version === mailManifestVersion,
    `Mail Sentinel reports ${versionJson.version}, expected manifest version ${mailManifestVersion}`,
  );
  invariant(
    versionJson.commit === component.commitSha,
    `Mail Sentinel reports commit ${versionJson.commit}, expected ${component.commitSha}`,
  );
  invariant(
    versionJson.releaseId === component.tag,
    `Mail Sentinel reports release ${versionJson.releaseId}, expected ${component.tag}`,
  );
  invariant(versionJson.identityComplete === true, "Mail Sentinel build identity is incomplete");
  const projectResult = runEntrypoint(
    join(packageRoot, "bots/project-sentinel/workspace/bin/dist/project-sentinel.js"),
    [],
    packageRoot,
    1,
  );
  invariant(projectResult.stderr.includes("Expected a command"), "Project Sentinel did not start");
  const realityResult = runEntrypoint(
    join(packageRoot, "bots/reality-alignment/workspace/bin/dist/reality-alignment.js"),
    [],
    packageRoot,
    1,
  );
  invariant(realityResult.stderr.includes("Expected a command"), "Reality Alignment did not start");
}

async function verifyComponentRelease(component, artifactPath, packageRoot, bots) {
  const packageJson = await readJson(join(packageRoot, "package.json"));
  invariant(component.schemaVersion === 1, "Unsupported component-release schemaVersion");
  invariant(component.component === PACKAGE_NAME, "Unexpected component name");
  invariant(component.version === packageJson.version, "Component/catalog version mismatch");
  invariant(component.tag === `v${component.version}`, "Component tag/version mismatch");
  invariant(SHA.test(component.commitSha), "Invalid component commitSha");
  invariant(
    Array.isArray(component.assets) && component.assets.length === 1,
    "Expected one artifact asset",
  );
  const asset = component.assets[0];
  const artifactStat = await stat(artifactPath);
  invariant(asset.name === basename(artifactPath), "Component artifact name mismatch");
  invariant(asset.size === artifactStat.size, "Component artifact size mismatch");
  invariant(DIGEST.test(asset.sha256), "Invalid component artifact digest");
  invariant(asset.sha256 === (await sha256(artifactPath)), "Component artifact digest mismatch");
  invariant(
    JSON.stringify(component.bots) === JSON.stringify(bots),
    "Component bot versions mismatch",
  );
}

async function verifyReleaseArtifact(artifactPath, manifestPath, sourceRoot) {
  const component = await readJson(manifestPath);
  await withExtractedArtifact(artifactPath, async (packageRoot) => {
    const files = (await walkFiles(packageRoot, "package")).sort();
    assertCuratedPaths(files);
    if (sourceRoot !== undefined) {
      assertEqualPaths(files, await expectedSourcePayload(sourceRoot));
    }
    const bots = await loadBots(packageRoot);
    await assertRequiredPayload(packageRoot, files, bots);
    await assertPackageDependencies(packageRoot);
    await assertNoSecrets(packageRoot, files);
    await assertEntrypointsRun(packageRoot, bots, component);
    await verifyComponentRelease(component, artifactPath, packageRoot, bots);
    console.log(`Verified ${basename(artifactPath)} (${files.length} files)`);
  });
}

async function customPack(sourceRoot, outputDir) {
  const npmPackRoot = await mkdtemp(join(tmpdir(), "sovereign-ai-bots-npm-pack-"));
  try {
    const npmOutput = JSON.parse(
      runText("npm", ["pack", "--ignore-scripts", "--pack-destination", npmPackRoot, "--json"], {
        cwd: sourceRoot,
      }),
    );
    invariant(npmOutput.length === 1, "npm pack did not produce exactly one artifact");
    const npmArtifact = join(npmPackRoot, npmOutput[0].filename);
    validateArchivePaths(npmArtifact);
    const stagingRoot = join(npmPackRoot, "staging");
    await mkdir(stagingRoot);
    execFileSync("tar", ["-xzf", npmArtifact, "-C", stagingRoot], { stdio: "pipe" });
    await copyFile(
      join(sourceRoot, "pnpm-lock.yaml"),
      join(stagingRoot, "package", "pnpm-lock.yaml"),
    );

    await mkdir(outputDir, { recursive: true });
    const artifactPath = join(outputDir, npmOutput[0].filename);
    await rm(artifactPath, { force: true });
    execFileSync(
      "tar",
      [
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--format=posix",
        "--pax-option=delete=atime,delete=ctime",
        "-czf",
        artifactPath,
        "-C",
        stagingRoot,
        "package",
      ],
      { stdio: "pipe" },
    );
    return artifactPath;
  } finally {
    await rm(npmPackRoot, { recursive: true, force: true });
  }
}

async function buildReleaseArtifacts(options) {
  const sourceRoot = resolve(options["source-dir"] ?? process.cwd());
  const packageJson = await readJson(join(sourceRoot, "package.json"));
  const outputDir = resolve(options["output-dir"] ?? join(sourceRoot, "release-assets"));
  const tag = options.tag ?? `v${packageJson.version}`;
  const commitSha =
    options.commit ??
    process.env.SOURCE_COMMIT ??
    runText("git", ["rev-parse", "HEAD"], { cwd: sourceRoot });
  invariant(
    tag === `v${packageJson.version}`,
    `Tag ${tag} does not match package version ${packageJson.version}`,
  );
  invariant(SHA.test(commitSha), `Invalid release commit SHA: ${commitSha}`);

  const artifactPath = await customPack(sourceRoot, outputDir);
  const manifestPath = join(outputDir, "component-release.json");
  const component = await createComponentRelease(artifactPath, tag, commitSha);
  await writeFile(manifestPath, `${JSON.stringify(component, null, 2)}\n`, "utf8");
  await verifyReleaseArtifact(artifactPath, manifestPath, sourceRoot);
  console.log(JSON.stringify({ artifactPath, manifestPath }));
  return { artifactPath, manifestPath };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "build") {
    await buildReleaseArtifacts(parseOptions(args));
    return;
  }
  if (command === "verify") {
    const options = parseOptions(args);
    invariant(options.artifact !== undefined, "verify requires --artifact");
    invariant(options.manifest !== undefined, "verify requires --manifest");
    await verifyReleaseArtifact(
      resolve(options.artifact),
      resolve(options.manifest),
      options["source-dir"] === undefined ? undefined : resolve(options["source-dir"]),
    );
    return;
  }
  if (command === "test") {
    invariant(args.length === 0, "test does not accept options");
    runArchivePreflightNegativeTests();
    const sourceRoot = process.cwd();
    const packageJson = await readJson(join(sourceRoot, "package.json"));
    const tag = `v${packageJson.version}`;
    const commitSha = runText("git", ["rev-parse", "HEAD"], { cwd: sourceRoot });
    execFileSync("pnpm", ["build"], {
      cwd: sourceRoot,
      env: {
        ...process.env,
        SOURCE_COMMIT: commitSha,
        SOVEREIGN_RELEASE_ID: tag,
      },
      stdio: "inherit",
    });
    const outputDir = await mkdtemp(join(tmpdir(), "sovereign-ai-bots-contract-"));
    try {
      await buildReleaseArtifacts({ "output-dir": outputDir, tag, commit: commitSha });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
    return;
  }
  throw new Error(
    "Usage: release-artifact.mjs <build [--output-dir DIR --tag TAG --commit SHA] | verify --artifact FILE --manifest FILE [--source-dir DIR] | test>",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
