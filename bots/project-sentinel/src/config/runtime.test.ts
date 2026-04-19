import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectSentinelRuntime, resolveToolRuntime } from "./runtime.js";

const writeRuntimeConfig = async (
  root: string,
  secretRef: string,
  overrides: Record<string, unknown> = {},
): Promise<string> => {
  const configPath = join(root, "runtime.json5");
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify(
      {
        sovereignTools: {
          instances: [
            {
              id: "project-sentinel-core",
              config: {
                agentId: "project-sentinel",
                statePath: "data/project-sentinel-state.json",
                sourcesPath: "config/sources.json",
                policyPath: "config/user-policy.json",
                digestInterval: "3h",
                matrixAlertRoomId: "!sentinel:example.org",
              },
            },
          ],
        },
        openclawProfile: {
          agents: [
            {
              id: "project-sentinel",
              workspace,
              matrix: {
                accessTokenSecretRef: secretRef,
              },
            },
          ],
        },
        matrix: {
          adminBaseUrl: "https://matrix.example.org",
        },
        ...overrides,
      },
      null,
      2,
    ),
    "utf8",
  );
  return configPath;
};

describe("project-sentinel/config/runtime", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.PROJECT_SENTINEL_TEST_TOKEN;
    delete process.env.SOVEREIGN_NODE_CONFIG;
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("loads runtime config from env and file secrets and persists state files", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "project-sentinel-runtime-"));
    process.env.PROJECT_SENTINEL_TEST_TOKEN = "env-token";
    const configPath = await writeRuntimeConfig(tempDir, "env:PROJECT_SENTINEL_TEST_TOKEN");
    const runtime = new ProjectSentinelRuntime("project-sentinel-core", configPath);
    await runtime.load();
    expect(runtime.workspaceDir).toBe(join(tempDir, "workspace"));
    expect(runtime.statePath).toBe(join(tempDir, "workspace/data/project-sentinel-state.json"));
    expect(runtime.sourcesPath).toBe(join(tempDir, "workspace/config/sources.json"));
    expect(runtime.policyPath).toBe(join(tempDir, "workspace/config/user-policy.json"));
    expect(runtime.digestInterval).toBe("3h");
    expect(runtime.matrix.accessToken).toBe("env-token");
    expect(await runtime.readState()).toEqual(
      expect.objectContaining({ version: 1, consecutiveFailures: 0 }),
    );
    expect(await runtime.readSources()).toEqual({ version: 1, profiles: [], sources: [] });
    expect(await runtime.readPolicy()).toEqual({
      version: 1,
      sourceWeights: {},
      laneWeights: {
        matrix: 0,
        openclaw: 0,
        mail_stack: 0,
        ops_security: 0,
        local_first_ai: 0,
      },
      sourceOverrides: {},
      mutedFingerprints: [],
    });
    await runtime.writeSources({ version: 1, profiles: [], sources: [] });
    await runtime.writePolicy({
      version: 1,
      sourceWeights: { source: 1 },
      laneWeights: {
        matrix: 0,
        openclaw: 0,
        mail_stack: 0,
        ops_security: 0,
        local_first_ai: 0,
      },
      sourceOverrides: {},
      mutedFingerprints: [],
    });
    await runtime.writeState({
      version: 1,
      consecutiveFailures: 0,
      seenSignals: {},
      deliveredSignals: [],
      feedback: [],
      digestQueue: [],
      sourceStatus: {},
    });
    expect(await readFile(runtime.sourcesPath, "utf8")).toContain('"version": 1');

    const secretPath = join(tempDir, "matrix-secret.txt");
    await writeFile(secretPath, "file-token\n", "utf8");
    const fileConfigRoot = join(tempDir, "file-config");
    const fileRuntime = new ProjectSentinelRuntime(
      "project-sentinel-core",
      await writeRuntimeConfig(fileConfigRoot, `file:${secretPath}`),
    );
    await fileRuntime.load();
    expect(fileRuntime.matrix.accessToken).toBe("file-token");

    const resolvedRuntime = await resolveToolRuntime("project-sentinel-core", configPath);
    expect(resolvedRuntime.workspaceDir).toBe(runtime.workspaceDir);
  });

  it("fails when runtime config is invalid or secrets are unavailable", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "project-sentinel-runtime-"));
    await expect(
      new ProjectSentinelRuntime(
        "missing-tool",
        await writeRuntimeConfig(tempDir, "env:PROJECT_SENTINEL_TEST_TOKEN"),
      ).load(),
    ).rejects.toThrow("was not found");
    await expect(
      new ProjectSentinelRuntime(
        "project-sentinel-core",
        await writeRuntimeConfig(tempDir, "env:PROJECT_SENTINEL_TEST_TOKEN", {
          openclawProfile: { agents: [] },
        }),
      ).load(),
    ).rejects.toThrow("agent 'project-sentinel' was not found");
    await expect(
      new ProjectSentinelRuntime(
        "project-sentinel-core",
        await writeRuntimeConfig(tempDir, "unsupported:secret"),
      ).load(),
    ).rejects.toThrow("Unsupported secretRef format");
    await expect(
      new ProjectSentinelRuntime(
        "project-sentinel-core",
        await writeRuntimeConfig(tempDir, "env:PROJECT_SENTINEL_TEST_TOKEN"),
      ).load(),
    ).rejects.toThrow("Environment variable PROJECT_SENTINEL_TEST_TOKEN is not set");
    await expect(
      new ProjectSentinelRuntime(
        "project-sentinel-core",
        await writeRuntimeConfig(tempDir, "env:PROJECT_SENTINEL_TEST_TOKEN", {
          sovereignTools: undefined,
        }),
      ).load(),
    ).rejects.toThrow("was not found");
    await expect(
      new ProjectSentinelRuntime(
        "project-sentinel-core",
        await writeRuntimeConfig(tempDir, "env:PROJECT_SENTINEL_TEST_TOKEN", {
          openclawProfile: undefined,
        }),
      ).load(),
    ).rejects.toThrow("agent 'project-sentinel' was not found");
    await expect(
      new ProjectSentinelRuntime(
        "project-sentinel-core",
        await writeRuntimeConfig(tempDir, ""),
      ).load(),
    ).rejects.toThrow("Missing secret reference");
    const emptySecretPath = join(tempDir, "empty-secret.txt");
    await writeFile(emptySecretPath, "\n", "utf8");
    await expect(
      new ProjectSentinelRuntime(
        "project-sentinel-core",
        await writeRuntimeConfig(tempDir, `file:${emptySecretPath}`),
      ).load(),
    ).rejects.toThrow("is empty");
  });

  it("sends Matrix room messages and surfaces failures", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "project-sentinel-runtime-"));
    process.env.PROJECT_SENTINEL_TEST_TOKEN = "env-token";
    const runtime = new ProjectSentinelRuntime(
      "project-sentinel-core",
      await writeRuntimeConfig(tempDir, "env:PROJECT_SENTINEL_TEST_TOKEN"),
    );
    await runtime.load();

    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await runtime.sendMatrixRoomMessage("hello");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "/_matrix/client/v3/rooms/!sentinel%3Aexample.org/send/m.room.message/",
      ),
      expect.objectContaining({ method: "PUT" }),
    );

    runtime.matrix.roomId = undefined;
    await expect(runtime.sendMatrixRoomMessage("hello")).rejects.toThrow("is not configured");
    runtime.matrix.roomId = "!sentinel:example.org";
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    await expect(runtime.sendMatrixRoomMessage("hello")).rejects.toThrow(
      "Failed to send Matrix room message (500)",
    );
  });

  it("falls back to default tool config and matrix room settings", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "project-sentinel-runtime-"));
    process.env.PROJECT_SENTINEL_TEST_TOKEN = "env-token";
    const configPath = await writeRuntimeConfig(tempDir, "env:PROJECT_SENTINEL_TEST_TOKEN", {
      sovereignTools: { instances: [{ id: "project-sentinel-core" }] },
      matrix: {
        adminBaseUrl: "https://matrix.example.org",
        alertRoom: { roomId: "!fallback:example.org" },
      },
    });
    process.env.SOVEREIGN_NODE_CONFIG = configPath;
    const runtime = new ProjectSentinelRuntime("project-sentinel-core");
    await runtime.load();
    expect(runtime.statePath.endsWith("data/project-sentinel-state.json")).toBe(true);
    expect(runtime.sourcesPath.endsWith("config/sources.json")).toBe(true);
    expect(runtime.policyPath.endsWith("config/user-policy.json")).toBe(true);
    expect(runtime.digestInterval).toBe("12h");
    expect(runtime.matrix.roomId).toBe("!fallback:example.org");
    delete process.env.SOVEREIGN_NODE_CONFIG;
  });
});
