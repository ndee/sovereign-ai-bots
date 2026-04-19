import { existsSync } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";

import { commandSchema, manifestSchema } from "./schema.js";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export type CatalogCommand = z.infer<typeof commandSchema>;
type Manifest = z.infer<typeof manifestSchema>;

interface RawPackage {
  dir: string;
  manifestPath: string;
  manifest: unknown;
}

interface ParsedPackage extends RawPackage {
  manifest: Manifest;
}

interface CatalogResult {
  readonly errors: readonly string[];
}

export interface LintResult extends CatalogResult {
  readonly jsonFileCount: number;
}

export interface TypecheckResult extends CatalogResult {
  readonly packageCount: number;
}

export interface TestResult extends CatalogResult {
  readonly packageCount: number;
}

export interface SmokeResult extends CatalogResult {
  readonly packageCount: number;
  readonly lines: readonly string[];
}

export interface CatalogOutput {
  log(line: string): void;
  error(line: string): void;
}

export const consoleCatalogOutput: CatalogOutput = {
  log: (line) => {
    console.log(line);
  },
  error: (line) => {
    console.error(line);
  },
};

export function parseCatalogCommand(args: readonly string[]): CatalogCommand {
  const result = commandSchema.safeParse(args[0]);
  if (result.success) {
    return result.data;
  }
  throw new Error("Usage: validate-catalog <lint|typecheck|test|smoke>");
}

export async function listBotDirectories(rootDir: string): Promise<string[]> {
  const botsDir = join(rootDir, "bots");
  try {
    const entries = await readdir(botsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(botsDir, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Missing bot catalog directory: ${botsDir}`);
    }
    throw error;
  }
}

const NON_CATALOG_DIRECTORIES = new Set(["node_modules", "src", "dist", ".turbo", ".tsbuildinfo"]);

const NON_CATALOG_FILENAMES = new Set([
  "tsconfig.json",
  "tsconfig.build.json",
  "package.json",
  "package-lock.json",
]);

export async function listJsonFiles(rootDir: string): Promise<string[]> {
  return walkFiles(
    join(rootDir, "bots"),
    (path) => extname(path) === ".json" && !NON_CATALOG_FILENAMES.has(basename(path)),
    (dirName) => !NON_CATALOG_DIRECTORIES.has(dirName),
  );
}

export async function lintCatalog(rootDir: string): Promise<LintResult> {
  const errors: string[] = [];
  const jsonFiles = await listJsonFiles(rootDir);
  for (const filePath of jsonFiles) {
    const relativePath = toRelative(rootDir, filePath);
    try {
      const parsed = await readJsonFile(filePath);
      const rawText = await readUtf8File(filePath);
      const canonical = canonicalJsonStringify(parsed);
      if (rawText !== canonical) {
        errors.push(`${relativePath} is not formatted with two-space canonical JSON`);
      }
    } catch (error) {
      errors.push(`${relativePath} ${formatReadJsonError(error)}`);
    }
  }
  return {
    errors,
    jsonFileCount: jsonFiles.length,
  };
}

export async function typecheckCatalog(rootDir: string): Promise<TypecheckResult> {
  const { parsedPackages, errors } = await loadAndValidatePackages(rootDir);
  return {
    errors,
    packageCount: parsedPackages.length,
  };
}

export async function testCatalog(rootDir: string): Promise<TestResult> {
  const { parsedPackages, errors } = await loadAndValidatePackages(rootDir);
  for (const parsedPackage of parsedPackages) {
    errors.push(...validatePackageInvariants(rootDir, parsedPackage));
  }
  errors.push(...validateRepoInvariants(parsedPackages));
  return {
    errors,
    packageCount: parsedPackages.length,
  };
}

export async function smokeCatalog(rootDir: string): Promise<SmokeResult> {
  const { parsedPackages, errors } = await loadAndValidatePackages(rootDir);
  for (const parsedPackage of parsedPackages) {
    errors.push(...validatePackageInvariants(rootDir, parsedPackage));
  }
  errors.push(...validateRepoInvariants(parsedPackages));
  if (errors.length > 0) {
    return {
      errors,
      packageCount: parsedPackages.length,
      lines: [],
    };
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-bot-catalog-"));
  const lines: string[] = [];
  try {
    for (const parsedPackage of parsedPackages) {
      const destinationRoot = join(tempRoot, parsedPackage.manifest.id);
      let copied = 0;
      for (const resource of parsedPackage.manifest.hostResources) {
        const sourcePath = resource.spec.source;
        if (typeof sourcePath !== "string") {
          continue;
        }
        const source = join(parsedPackage.dir, sourcePath);
        const destination = join(destinationRoot, sourcePath);
        await ensureDirectory(dirname(destination));
        await copyFile(source, destination);
        copied += 1;
      }
      lines.push(
        `Smoked ${parsedPackage.manifest.id}@${parsedPackage.manifest.version} with ${copied} source-backed host resources.`,
      );
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  return {
    errors,
    packageCount: parsedPackages.length,
    lines,
  };
}

export async function runCatalogCommand(
  command: CatalogCommand,
  rootDir: string,
  output: CatalogOutput = consoleCatalogOutput,
): Promise<number> {
  const absoluteRoot = resolve(rootDir);
  if (command === "lint") {
    const result = await lintCatalog(absoluteRoot);
    return finishCatalogCommand(result.errors, output, () => {
      output.log(`Lint passed for ${result.jsonFileCount} JSON files.`);
    });
  }
  if (command === "typecheck") {
    const result = await typecheckCatalog(absoluteRoot);
    return finishCatalogCommand(result.errors, output, () => {
      output.log(`Typecheck passed for ${result.packageCount} bot packages.`);
    });
  }
  if (command === "test") {
    const result = await testCatalog(absoluteRoot);
    return finishCatalogCommand(result.errors, output, () => {
      output.log(`Catalog tests passed for ${result.packageCount} bot packages.`);
    });
  }

  const result = await smokeCatalog(absoluteRoot);
  return finishCatalogCommand(result.errors, output, () => {
    for (const line of result.lines) {
      output.log(line);
    }
  });
}

async function loadAndValidatePackages(rootDir: string): Promise<{
  parsedPackages: ParsedPackage[];
  errors: string[];
}> {
  const { packages, errors } = await loadPackages(rootDir);
  const parsedPackages: ParsedPackage[] = [];
  for (const pkg of packages) {
    const validation = validateManifestTypes(rootDir, pkg);
    errors.push(...validation.errors);
    if (validation.manifest) {
      parsedPackages.push({
        ...pkg,
        manifest: validation.manifest,
      });
    }
  }
  return { parsedPackages, errors };
}

async function loadPackages(
  rootDir: string,
): Promise<{ packages: RawPackage[]; errors: string[] }> {
  const packages: RawPackage[] = [];
  const errors: string[] = [];
  for (const packageDir of await listBotDirectories(rootDir)) {
    const manifestPath = join(packageDir, "sovereign-bot.json");
    try {
      await access(manifestPath);
    } catch {
      errors.push(`${toRelative(rootDir, packageDir)} is missing sovereign-bot.json`);
      continue;
    }
    try {
      packages.push({
        dir: packageDir,
        manifestPath,
        manifest: await readJsonFile(manifestPath),
      });
    } catch (error) {
      errors.push(`${toRelative(rootDir, manifestPath)} ${formatReadJsonError(error)}`);
    }
  }
  return { packages, errors };
}

function validateManifestTypes(
  rootDir: string,
  pkg: RawPackage,
): {
  manifest?: Manifest;
  errors: string[];
} {
  const result = manifestSchema.safeParse(pkg.manifest);
  if (result.success) {
    return { manifest: result.data, errors: [] };
  }
  return {
    errors: result.error.issues.map(
      (issue) => `${toRelative(rootDir, pkg.manifestPath)}: ${formatIssue(issue)}`,
    ),
  };
}

function validatePackageInvariants(rootDir: string, pkg: ParsedPackage): string[] {
  const errors: string[] = [];
  const manifestPath = toRelative(rootDir, pkg.manifestPath);
  if (pkg.manifest.id !== basename(pkg.dir)) {
    errors.push(
      `${manifestPath}: manifest id '${pkg.manifest.id}' must match directory '${basename(pkg.dir)}'`,
    );
  }
  if (pkg.manifest.agentTemplate.id !== pkg.manifest.id) {
    errors.push(`${manifestPath}: agentTemplate.id must match manifest id`);
  }
  if (pkg.manifest.agentTemplate.version !== pkg.manifest.version) {
    errors.push(`${manifestPath}: agentTemplate.version must match manifest version`);
  }
  if (
    pkg.manifest.agentTemplate.matrix.localpartPrefix !==
    pkg.manifest.matrixIdentity.localpartPrefix
  ) {
    errors.push(
      `${manifestPath}: agentTemplate.matrix.localpartPrefix must match matrixIdentity.localpartPrefix`,
    );
  }

  const localToolRefs = pkg.manifest.toolTemplates.map((entry) => `${entry.id}@${entry.version}`);
  if (!hasUniqueValues(localToolRefs)) {
    errors.push(`${manifestPath}: toolTemplates must use unique id@version pairs`);
  }

  const toolInstanceIds = pkg.manifest.toolInstances.map((entry) => entry.id);
  if (!hasUniqueValues(toolInstanceIds)) {
    errors.push(`${manifestPath}: toolInstances must use unique ids`);
  }

  const declaredAgentRefs = [
    ...pkg.manifest.agentTemplate.requiredToolTemplates,
    ...pkg.manifest.agentTemplate.optionalToolTemplates,
  ].map((entry) => `${entry.id}@${entry.version}`);
  if (!hasUniqueValues(declaredAgentRefs)) {
    errors.push(
      `${manifestPath}: agentTemplate tool template refs must be unique across required and optional lists`,
    );
  }

  const allowedRefs = new Set<string>([...localToolRefs, ...declaredAgentRefs]);
  const localTemplatesByRef = new Map<string, Manifest["toolTemplates"][number]>(
    pkg.manifest.toolTemplates.map((entry) => [`${entry.id}@${entry.version}`, entry] as const),
  );
  for (const [index, instance] of pkg.manifest.toolInstances.entries()) {
    if (!allowedRefs.has(instance.templateRef)) {
      errors.push(
        `${manifestPath}: toolInstances[${index}].templateRef '${instance.templateRef}' is not declared by the package`,
      );
      continue;
    }
    const localTemplate = localTemplatesByRef.get(instance.templateRef);
    if (!localTemplate) {
      continue;
    }

    const configKeys = new Set(Object.keys(instance.config));
    const secretKeys = new Set(Object.keys(instance.secretRefs));
    const missingConfig = localTemplate.requiredConfigKeys.filter((key) => !configKeys.has(key));
    const missingSecrets = localTemplate.requiredSecretRefs.filter((key) => !secretKeys.has(key));
    if (missingConfig.length > 0) {
      errors.push(
        `${manifestPath}: toolInstances[${index}] is missing required config bindings: ${missingConfig.join(", ")}`,
      );
    }
    if (missingSecrets.length > 0) {
      errors.push(
        `${manifestPath}: toolInstances[${index}] is missing required secret bindings: ${missingSecrets.join(", ")}`,
      );
    }
  }

  const hostResourceIds = pkg.manifest.hostResources.map((entry) => entry.id);
  if (!hasUniqueValues(hostResourceIds)) {
    errors.push(`${manifestPath}: hostResources ids must be unique`);
  }

  const sourcePaths = pkg.manifest.hostResources.flatMap((entry, index) => {
    const sourcePath = entry.spec.source;
    if (typeof sourcePath !== "string") {
      return [];
    }

    if (!isSafeRelativePath(sourcePath)) {
      errors.push(
        `${manifestPath}: hostResources[${index}].spec.source must be a safe relative path`,
      );
      return [sourcePath];
    }
    if (!sourcePath.startsWith("workspace/")) {
      errors.push(
        `${manifestPath}: hostResources[${index}].spec.source must stay under workspace/`,
      );
    }
    const resolvedSource = join(pkg.dir, sourcePath);
    if (!existsSyncLike(resolvedSource)) {
      errors.push(
        `${manifestPath}: hostResources[${index}].spec.source '${sourcePath}' does not exist`,
      );
    }
    return [sourcePath];
  });
  if (!hasUniqueValues(sourcePaths)) {
    errors.push(`${manifestPath}: hostResources source paths must be unique`);
  }

  if (
    pkg.manifest.matrixRouting?.defaultAccount &&
    pkg.manifest.matrixIdentity.mode !== "dedicated-account"
  ) {
    errors.push(
      `${manifestPath}: matrixRouting.defaultAccount requires matrixIdentity.mode = dedicated-account`,
    );
  }
  return errors;
}

function validateRepoInvariants(packages: readonly ParsedPackage[]): string[] {
  const errors: string[] = [];
  const ids = packages.map((pkg) => pkg.manifest.id);
  if (!hasUniqueValues(ids)) {
    errors.push("Bot package ids must be unique across the catalog");
  }
  const defaultAccounts = packages
    .filter((pkg) => pkg.manifest.matrixRouting?.defaultAccount === true)
    .map((pkg) => pkg.manifest.id);
  if (defaultAccounts.length > 1) {
    errors.push(
      `Only one bot package may set matrixRouting.defaultAccount=true; found ${defaultAccounts.sort().join(", ")}`,
    );
  }
  return errors;
}

async function walkFiles(
  currentDir: string,
  predicate: (path: string) => boolean,
  directoryPredicate: (name: string) => boolean,
): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (!directoryPredicate(entry.name)) {
        continue;
      }
      files.push(...(await walkFiles(entryPath, predicate, directoryPredicate)));
      continue;
    }
    if (entry.isFile() && predicate(entryPath)) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readUtf8File(path));
}

async function readUtf8File(path: string): Promise<string> {
  const buffer = await readFile(path);
  try {
    return utf8Decoder.decode(buffer);
  } catch {
    throw new Error("is not valid UTF-8 text");
  }
}

function canonicalJsonStringify(value: unknown): string {
  return `${escapeNonAscii(JSON.stringify(value, null, 2))}\n`;
}

function escapeNonAscii(value: string): string {
  return value.replace(/[\u0080-\u{10FFFF}]/gu, (character) => {
    const codePoint = character.codePointAt(0) as number;
    if (codePoint <= 0xffff) {
      return `\\u${codePoint.toString(16).padStart(4, "0")}`;
    }
    const adjusted = codePoint - 0x10000;
    const highSurrogate = 0xd800 + (adjusted >> 10);
    const lowSurrogate = 0xdc00 + (adjusted & 0x3ff);
    return `\\u${highSurrogate.toString(16).padStart(4, "0")}\\u${lowSurrogate
      .toString(16)
      .padStart(4, "0")}`;
  });
}

function formatReadJsonError(error: unknown): string {
  if (error instanceof Error && error.message === "is not valid UTF-8 text") {
    return error.message;
  }
  if (error instanceof SyntaxError) {
    return `is not valid JSON: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function formatIssue(issue: z.ZodIssue): string {
  const issuePath = issue.path.filter(
    (part): part is string | number => typeof part === "string" || typeof part === "number",
  );
  const path = issuePath.length > 0 ? formatIssuePath(issuePath) : "manifest";
  return `${path} ${issue.message}`;
}

function formatIssuePath(path: readonly (string | number)[]): string {
  let formatted = "";
  for (const part of path) {
    if (typeof part === "number") {
      formatted += `[${part}]`;
      continue;
    }
    formatted += formatted === "" ? part : `.${part}`;
  }
  return formatted;
}

function toRelative(rootDir: string, path: string): string {
  return relative(rootDir, path) || ".";
}

function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function isSafeRelativePath(value: string): boolean {
  if (value.trim() === "" || isAbsolute(value)) {
    return false;
  }
  return !value.split("/").includes("..");
}

function existsSyncLike(path: string): boolean {
  return existsSync(path);
}

function finishCatalogCommand(
  errors: readonly string[],
  output: CatalogOutput,
  onSuccess: () => void,
): number {
  if (errors.length > 0) {
    for (const error of errors) {
      output.error(`ERROR: ${error}`);
    }
    return 1;
  }
  onSuccess();
  return 0;
}

export const catalogInternals = {
  canonicalJsonStringify,
  existsSyncLike,
  formatIssuePath,
  formatReadJsonError,
  hasUniqueValues,
  isSafeRelativePath,
  toRelative,
};
