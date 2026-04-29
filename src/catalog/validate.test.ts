import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  catalogInternals,
  consoleCatalogOutput,
  lintCatalog,
  listBotDirectories,
  parseCatalogCommand,
  runCatalogCommand,
  smokeCatalog,
  testCatalog,
  typecheckCatalog,
} from "./validate.js";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const tempRoots: string[] = [];
const tempRepoPaths: string[] = [];

describe("catalog validator", () => {
  afterEach(async () => {
    await Promise.all(
      [...tempRoots.splice(0), ...tempRepoPaths.splice(0)].map(async (path) => {
        await rm(path, { recursive: true, force: true });
      }),
    );
  });

  it("passes lint, typecheck, test, and smoke for the current catalog", async () => {
    await ensureFile(
      repoRoot,
      "bots/mail-sentinel/workspace/bin/dist/mail-sentinel.js",
      "#!/usr/bin/env node\n",
    );
    await ensureFile(
      repoRoot,
      "bots/project-sentinel/workspace/bin/dist/project-sentinel.js",
      "#!/usr/bin/env node\n",
    );
    await ensureFile(
      repoRoot,
      "bots/wealth-alignment/workspace/bin/dist/wealth-alignment.js",
      "#!/usr/bin/env node\n",
    );
    await ensureFile(
      repoRoot,
      "bots/reality-alignment/workspace/bin/dist/reality-alignment.js",
      "#!/usr/bin/env node\n",
    );
<<<<<<< HEAD
    await expect(lintCatalog(repoRoot)).resolves.toMatchObject({ errors: [], jsonFileCount: 15 });
=======
    await expect(lintCatalog(repoRoot)).resolves.toMatchObject({ errors: [], jsonFileCount: 14 });
>>>>>>> docs/drift-review-2026-04-19
    await expect(typecheckCatalog(repoRoot)).resolves.toMatchObject({
      errors: [],
      packageCount: 6,
    });
    await expect(testCatalog(repoRoot)).resolves.toMatchObject({ errors: [], packageCount: 6 });
    const smoke = await smokeCatalog(repoRoot);
    expect(smoke.errors).toEqual([]);
    expect(smoke.lines).toHaveLength(6);
    expect(smoke.lines[0]).toContain("Smoked");
  });

  it("reports lint errors for invalid UTF-8, invalid JSON, and non-canonical JSON", async () => {
    const rootDir = await createCatalogRoot();
    const packageDir = join(rootDir, "bots", "bad-bot");
    await mkdir(join(packageDir, "workspace"), { recursive: true });
    await writeFile(join(packageDir, "workspace", "invalid.json"), Buffer.from([0xc3, 0x28]));
    await writeFile(join(packageDir, "workspace", "broken.json"), "{\n", "utf8");
    await writeFile(join(packageDir, "workspace", "loose.json"), '{"a":1}', "utf8");
    await writeCanonicalJson(
      join(packageDir, "sovereign-bot.json"),
      createValidManifest("bad-bot"),
    );

    const result = await lintCatalog(rootDir);
    expect(result.jsonFileCount).toBe(4);
    expect(result.errors).toHaveLength(3);
    expect(result.errors[0]).toContain("bots/bad-bot/workspace/broken.json is not valid JSON:");
    expect(result.errors[1]).toBe("bots/bad-bot/workspace/invalid.json is not valid UTF-8 text");
    expect(result.errors[2]).toBe(
      "bots/bad-bot/workspace/loose.json is not formatted with two-space canonical JSON",
    );
  });

  it("reports schema and invariant errors", async () => {
    const rootDir = await createCatalogRoot();
    await mkdir(join(rootDir, "bots", "missing-manifest"), { recursive: true });

    await writeCanonicalJson(
      join(rootDir, "bots", "alpha", "sovereign-bot.json"),
      createBrokenManifest("alpha", {
        kind: "wrong-kind",
        manifestVersion: 1,
        displayName: "   ",
        matrixIdentity: {
          mode: "service-account",
          localpartPrefix: "alpha",
        },
        matrixRouting: {
          defaultAccount: true,
        },
        toolTemplates: [createToolTemplate(), createToolTemplate()],
        toolInstances: [
          {
            id: "dup",
            templateRef: "missing@1.0.0",
            config: {},
            secretRefs: {},
            enabledWhen: {
              path: "state.flag",
              equals: {},
            },
          },
          {
            id: "dup",
            templateRef: "example-tool@1.0.0",
            config: {},
            secretRefs: {},
          },
        ],
        hostResources: [
          {
            id: "dup",
            kind: "directory",
            spec: {},
          },
          {
            id: "dup",
            kind: "managedFile",
            spec: {
              path: "workspace/readme.md",
            },
          },
          {
            id: "svc",
            kind: "systemdService",
            spec: {
              name: "svc",
            },
          },
          {
            id: "timer",
            kind: "systemdTimer",
            spec: {
              name: "timer",
            },
          },
          {
            id: "cron",
            kind: "openclawCron",
            spec: {
              id: "cron",
              agentId: "alpha",
              desiredState: "present",
            },
          },
          {
            id: "unsafe",
            kind: "managedFile",
            spec: {
              path: "workspace/unsafe.txt",
              source: "../unsafe.txt",
            },
          },
          {
            id: "missing-source",
            kind: "managedFile",
            spec: {
              path: "workspace/missing.txt",
              source: "config/missing.txt",
            },
          },
          {
            id: "same-source-a",
            kind: "managedFile",
            spec: {
              path: "workspace/a.txt",
              source: "workspace/shared.txt",
            },
          },
          {
            id: "same-source-b",
            kind: "managedFile",
            spec: {
              path: "workspace/b.txt",
              source: "workspace/shared.txt",
            },
          },
        ],
        agentTemplate: {
          id: "beta",
          version: "2.0.1",
          description: "broken agent",
          matrix: {
            localpartPrefix: "beta",
          },
          requiredToolTemplates: [
            {
              id: "remote-tool",
              version: "1.0.0",
            },
          ],
          optionalToolTemplates: [
            {
              id: "remote-tool",
              version: "1.0.0",
            },
          ],
        },
      }),
    );

    await writeCanonicalJson(
      join(rootDir, "bots", "alpha-copy", "sovereign-bot.json"),
      createValidManifest("alpha", {
        matrixRouting: {
          defaultAccount: true,
        },
      }),
    );
    await writeFile(
      join(rootDir, "bots", "alpha-copy", "workspace", "README.md"),
      "shared\n",
      "utf8",
    );

    await writeCanonicalJson(
      join(rootDir, "bots", "gamma", "sovereign-bot.json"),
      createValidManifest("alpha", {
        matrixRouting: {
          defaultAccount: true,
        },
      }),
    );
    await writeCanonicalJson(
      join(rootDir, "bots", "delta", "sovereign-bot.json"),
      createValidManifest("delta", {
        matrixIdentity: {
          mode: "service-account",
          localpartPrefix: "delta",
        },
        matrixRouting: {
          defaultAccount: true,
        },
        toolTemplates: [
          createToolTemplate({ requiredSecretRefs: ["token"] }),
          createToolTemplate({ requiredSecretRefs: ["token"] }),
        ],
        toolInstances: [
          {
            id: "dup",
            templateRef: "missing@1.0.0",
            config: {},
            secretRefs: {},
          },
          {
            id: "dup",
            templateRef: "example-tool@1.0.0",
            config: {},
            secretRefs: {},
          },
        ],
        hostResources: [
          {
            id: "dup",
            kind: "managedFile",
            spec: {
              path: "/delta/a.txt",
              source: "../unsafe.txt",
            },
          },
          {
            id: "dup",
            kind: "managedFile",
            spec: {
              path: "/delta/b.txt",
              source: "config/missing.txt",
            },
          },
          {
            id: "same-source-a",
            kind: "managedFile",
            spec: {
              path: "/delta/c.txt",
              source: "workspace/shared.txt",
            },
          },
          {
            id: "same-source-b",
            kind: "managedFile",
            spec: {
              path: "/delta/d.txt",
              source: "workspace/shared.txt",
            },
          },
        ],
        agentTemplate: {
          id: "delta-agent",
          version: "9.9.9",
          description: "delta agent",
          matrix: {
            localpartPrefix: "delta-agent",
          },
          requiredToolTemplates: [
            {
              id: "remote-tool",
              version: "1.0.0",
            },
          ],
          optionalToolTemplates: [
            {
              id: "remote-tool",
              version: "1.0.0",
            },
          ],
        },
      }),
    );

    const typecheck = await typecheckCatalog(rootDir);
    expect(typecheck.packageCount).toBe(3);
    expect(typecheck.errors).toContain(
      'bots/alpha/sovereign-bot.json: kind Invalid input: expected "sovereign-bot-package"',
    );
    expect(typecheck.errors).toContain("bots/alpha/sovereign-bot.json: manifestVersion must be 2");
    expect(typecheck.errors).toContain(
      "bots/alpha/sovereign-bot.json: displayName must not be empty",
    );
    expect(typecheck.errors).toContain(
      "bots/alpha/sovereign-bot.json: toolInstances[0].enabledWhen.equals Invalid input",
    );
    expect(typecheck.errors).toContain(
      "bots/alpha/sovereign-bot.json: hostResources[0].spec.path must be defined",
    );
    expect(typecheck.errors).toContain(
      "bots/alpha/sovereign-bot.json: hostResources[1].spec must define source or inlineContent",
    );
    expect(typecheck.errors).toContain(
      "bots/alpha/sovereign-bot.json: hostResources[2].spec.description must be defined",
    );
    expect(typecheck.errors).toContain(
      "bots/alpha/sovereign-bot.json: hostResources[3].spec.description must be defined",
    );
    expect(typecheck.errors).toContain(
      "bots/alpha/sovereign-bot.json: hostResources[4].spec.every must be defined when desiredState=present",
    );
    expect(typecheck.errors).toContain("bots/missing-manifest is missing sovereign-bot.json");

    const testResult = await testCatalog(rootDir);
    expect(testResult.errors).toContain(
      "bots/delta/sovereign-bot.json: agentTemplate.id must match manifest id",
    );
    expect(testResult.errors).toContain(
      "bots/delta/sovereign-bot.json: agentTemplate.version must match manifest version",
    );
    expect(testResult.errors).toContain(
      "bots/delta/sovereign-bot.json: agentTemplate.matrix.localpartPrefix must match matrixIdentity.localpartPrefix",
    );
    expect(testResult.errors).toContain(
      "bots/delta/sovereign-bot.json: toolTemplates must use unique id@version pairs",
    );
    expect(testResult.errors).toContain(
      "bots/delta/sovereign-bot.json: toolInstances must use unique ids",
    );
    expect(testResult.errors).toContain(
      "bots/delta/sovereign-bot.json: agentTemplate tool template refs must be unique across required and optional lists",
    );
    expect(testResult.errors).toContain(
      "bots/delta/sovereign-bot.json: toolInstances[0].templateRef 'missing@1.0.0' is not declared by the package",
    );
    expect(testResult.errors).toContain(
      "bots/delta/sovereign-bot.json: toolInstances[1] is missing required config bindings: path",
    );
    expect(testResult.errors).toContain(
      "bots/delta/sovereign-bot.json: toolInstances[1] is missing required secret bindings: token",
    );
    expect(testResult.errors).toContain(
      "bots/delta/sovereign-bot.json: hostResources ids must be unique",
    );
    expect(testResult.errors).toContain(
      "bots/delta/sovereign-bot.json: hostResources[0].spec.source must be a safe relative path",
    );
    expect(testResult.errors).toContain(
      "bots/delta/sovereign-bot.json: hostResources[1].spec.source must stay under workspace/",
    );
    expect(testResult.errors).toContain(
      "bots/delta/sovereign-bot.json: hostResources[1].spec.source 'config/missing.txt' does not exist",
    );
    expect(testResult.errors).toContain(
      "bots/delta/sovereign-bot.json: hostResources source paths must be unique",
    );
    expect(testResult.errors).toContain(
      "bots/delta/sovereign-bot.json: matrixRouting.defaultAccount requires matrixIdentity.mode = dedicated-account",
    );
    expect(testResult.errors).toContain("Bot package ids must be unique across the catalog");
    expect(testResult.errors).toContain(
      "Only one bot package may set matrixRouting.defaultAccount=true; found alpha, alpha, delta",
    );
  });

  it("runs the catalog CLI and reports usage errors", async () => {
    expect(parseCatalogCommand(["lint"])).toBe("lint");
    expect(() => parseCatalogCommand([])).toThrow(
      "Usage: validate-catalog <lint|typecheck|test|smoke>",
    );

    const lines: string[] = [];
    const errors: string[] = [];
    const exitCode = await runCatalogCommand("lint", repoRoot, {
      log: (line) => {
        lines.push(line);
      },
      error: (line) => {
        errors.push(line);
      },
    });

    expect(exitCode).toBe(0);
<<<<<<< HEAD
    expect(lines).toEqual(["Lint passed for 15 JSON files."]);
=======
    expect(lines).toEqual(["Lint passed for 14 JSON files."]);
>>>>>>> docs/drift-review-2026-04-19
    expect(errors).toEqual([]);
  });

  it("covers helper branches and failing command output", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    consoleCatalogOutput.log("hello");
    consoleCatalogOutput.error("oops");
    expect(logSpy).toHaveBeenCalledWith("hello");
    expect(errorSpy).toHaveBeenCalledWith("oops");
    logSpy.mockRestore();
    errorSpy.mockRestore();

    const noBotsRoot = await mkdtemp(join(tmpdir(), "sovereign-ai-bots-missing-"));
    tempRoots.push(noBotsRoot);
    await expect(listBotDirectories(noBotsRoot)).rejects.toThrow(
      `Missing bot catalog directory: ${join(noBotsRoot, "bots")}`,
    );

    const notDirectoryRoot = await mkdtemp(join(tmpdir(), "sovereign-ai-bots-notdir-"));
    tempRoots.push(notDirectoryRoot);
    await writeFile(join(notDirectoryRoot, "bots"), "not a directory\n", "utf8");
    await expect(listBotDirectories(notDirectoryRoot)).rejects.toThrow();

    expect(
      catalogInternals.canonicalJsonStringify({
        greeting: "Gr\u00fc\u00df Gott",
        wave: "\ud83d\udc4b",
      }),
    ).toBe('{\n  "greeting": "Gr\\u00fc\\u00df Gott",\n  "wave": "\\ud83d\\udc4b"\n}\n');
    expect(catalogInternals.formatReadJsonError(new Error("boom error"))).toBe("boom error");
    expect(catalogInternals.formatReadJsonError("boom")).toBe("boom");
    expect(catalogInternals.formatIssuePath(["a", 1, "b"])).toBe("a[1].b");
    expect(catalogInternals.toRelative(repoRoot, repoRoot)).toBe(".");
    expect(catalogInternals.hasUniqueValues(["a", "b"])).toBe(true);
    expect(catalogInternals.hasUniqueValues(["a", "a"])).toBe(false);
    expect(catalogInternals.isSafeRelativePath("workspace/file.txt")).toBe(true);
    expect(catalogInternals.isSafeRelativePath("")).toBe(false);
    expect(catalogInternals.isSafeRelativePath("../file.txt")).toBe(false);
    expect(catalogInternals.isSafeRelativePath("/tmp/file.txt")).toBe(false);
    expect(catalogInternals.existsSyncLike(join(repoRoot, "README.md"))).toBe(true);
    expect(catalogInternals.existsSyncLike(join(repoRoot, "missing.txt"))).toBe(false);

    const parseErrorRoot = await createCatalogRoot();
    await mkdir(join(parseErrorRoot, "bots", "bad-manifest"), { recursive: true });
    await writeFile(
      join(parseErrorRoot, "bots", "bad-manifest", "sovereign-bot.json"),
      "{\n",
      "utf8",
    );
    await expect(typecheckCatalog(parseErrorRoot)).resolves.toMatchObject({
      packageCount: 0,
      errors: [expect.stringContaining("bots/bad-manifest/sovereign-bot.json is not valid JSON:")],
    });

    const nonObjectRoot = await createCatalogRoot();
    await mkdir(join(nonObjectRoot, "bots", "array-manifest"), { recursive: true });
    await writeFile(
      join(nonObjectRoot, "bots", "array-manifest", "sovereign-bot.json"),
      "[]\n",
      "utf8",
    );
    await expect(typecheckCatalog(nonObjectRoot)).resolves.toMatchObject({
      packageCount: 0,
      errors: [
        expect.stringContaining(
          "bots/array-manifest/sovereign-bot.json: manifest Invalid input: expected object, received array",
        ),
      ],
    });

    const helperRoot = await createCatalogRoot();
    await ensureFile(helperRoot, "bots/helper/workspace/README.md", "helper\n");
    await ensureFile(helperRoot, "bots/helper/workspace/README.md", "helper\n");
    expect(
      catalogInternals.existsSyncLike(join(helperRoot, "bots/helper/workspace/README.md")),
    ).toBe(true);

    await ensureFile(
      repoRoot,
      "bots/mail-sentinel/workspace/bin/dist/mail-sentinel.js",
      "#!/usr/bin/env node\n",
    );
    await ensureFile(
      repoRoot,
      "bots/project-sentinel/workspace/bin/dist/project-sentinel.js",
      "#!/usr/bin/env node\n",
    );
    await ensureFile(
      repoRoot,
      "bots/wealth-alignment/workspace/bin/dist/wealth-alignment.js",
      "#!/usr/bin/env node\n",
    );
    await ensureFile(
      repoRoot,
      "bots/reality-alignment/workspace/bin/dist/reality-alignment.js",
      "#!/usr/bin/env node\n",
    );

    const commandLines: string[] = [];
    const commandErrors: string[] = [];
    await expect(
      runCatalogCommand("typecheck", repoRoot, {
        log: (line) => {
          commandLines.push(line);
        },
        error: (line) => {
          commandErrors.push(line);
        },
      }),
    ).resolves.toBe(0);
    await expect(
      runCatalogCommand("test", repoRoot, {
        log: (line) => {
          commandLines.push(line);
        },
        error: (line) => {
          commandErrors.push(line);
        },
      }),
    ).resolves.toBe(0);
    await expect(
      runCatalogCommand("smoke", repoRoot, {
        log: (line) => {
          commandLines.push(line);
        },
        error: (line) => {
          commandErrors.push(line);
        },
      }),
    ).resolves.toBe(0);
    expect(commandLines).toContain("Typecheck passed for 6 bot packages.");
    expect(commandLines).toContain("Catalog tests passed for 6 bot packages.");
    expect(commandLines.some((line) => line.startsWith("Smoked mail-sentinel@2.0.0"))).toBe(true);
    expect(commandLines.some((line) => line.startsWith("Smoked project-sentinel@2.0.0"))).toBe(
      true,
    );
    expect(commandErrors).toEqual([]);

    const failingRoot = await createCatalogRoot();
    const failingPackageDir = join(failingRoot, "bots", "broken");
    await mkdir(failingPackageDir, { recursive: true });
    await writeFile(join(failingPackageDir, "sovereign-bot.json"), "{\n", "utf8");
    const failingErrors: string[] = [];
    await expect(
      runCatalogCommand("smoke", failingRoot, {
        log: () => undefined,
        error: (line) => {
          failingErrors.push(line);
        },
      }),
    ).resolves.toBe(1);
    expect(failingErrors[0]).toContain("ERROR: bots/broken/sovereign-bot.json is not valid JSON:");
  });
});

async function createCatalogRoot(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "sovereign-ai-bots-test-"));
  tempRoots.push(rootDir);
  await mkdir(join(rootDir, "bots"), { recursive: true });
  return rootDir;
}

async function ensureFile(rootDir: string, relativePath: string, contents: string): Promise<void> {
  const filePath = join(rootDir, relativePath);
  try {
    await access(filePath);
    return;
  } catch {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, "utf8");
    if (rootDir === repoRoot) {
      tempRepoPaths.push(filePath);
    }
  }
}

function createToolTemplate(overrides: Record<string, unknown> = {}) {
  return {
    kind: "sovereign-tool-template",
    id: "example-tool",
    version: "1.0.0",
    description: "tool",
    capabilities: ["example.run"],
    requiredSecretRefs: [],
    requiredConfigKeys: ["path"],
    allowedCommands: [],
    openclawPlugins: [],
    openclawToolNames: [],
    ...overrides,
  };
}

function createValidManifest(id: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: "sovereign-bot-package",
    manifestVersion: 2,
    id,
    version: "2.0.0",
    displayName: `Bot ${id}`,
    description: `Description for ${id}`,
    defaultInstall: false,
    matrixIdentity: {
      mode: "dedicated-account",
      localpartPrefix: id,
    },
    matrixRouting: {},
    configDefaults: {
      path: "workspace/README.md",
    },
    toolTemplates: [createToolTemplate()],
    toolInstances: [
      {
        id: `${id}-core`,
        templateRef: "example-tool@1.0.0",
        config: {
          path: {
            from: `bots.config.${id}.path`,
          },
        },
        secretRefs: {},
      },
    ],
    hostResources: [
      {
        id: "workspace-readme",
        kind: "managedFile",
        spec: {
          path: `/${id}/README.md`,
          source: "workspace/README.md",
        },
      },
    ],
    agentTemplate: {
      id,
      version: "2.0.0",
      description: `Agent ${id}`,
      matrix: {
        localpartPrefix: id,
      },
      requiredToolTemplates: [
        {
          id: "example-tool",
          version: "1.0.0",
        },
      ],
      optionalToolTemplates: [],
    },
    ...overrides,
  };
}

function createBrokenManifest(id: string, overrides: Record<string, unknown>) {
  return {
    ...createValidManifest(id),
    ...overrides,
  };
}

async function writeCanonicalJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (path.endsWith("sovereign-bot.json")) {
    await mkdir(join(dirname(path), "workspace"), { recursive: true });
    await writeFile(join(dirname(path), "workspace", "README.md"), "hello\n", "utf8");
    await writeFile(join(dirname(path), "workspace", "shared.txt"), "shared\n", "utf8");
  }
}
