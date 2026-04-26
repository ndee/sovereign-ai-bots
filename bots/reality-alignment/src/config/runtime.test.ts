import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RealityAlignmentRuntime, resolveToolRuntime } from "./runtime.js";

const writeRuntimeConfig = async (
  root: string,
  overrides: Record<string, unknown> = {},
): Promise<string> => {
  const configPath = join(root, "runtime.json");
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify(
      {
        sovereignTools: {
          instances: [
            {
              id: "reality-alignment-core",
              config: {
                agentId: "reality-alignment",
                statePath: "data/reality-alignment-state.json",
              },
            },
          ],
        },
        openclawProfile: {
          agents: [
            {
              id: "reality-alignment",
              workspace,
            },
          ],
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

describe("reality-alignment/config/runtime", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("loads the runtime, reads default state, and writes back", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reality-alignment-runtime-"));
    const configPath = await writeRuntimeConfig(tempDir);
    const runtime = await resolveToolRuntime("reality-alignment-core", configPath);
    expect(runtime.workspaceDir).toBe(join(tempDir, "workspace"));
    expect(runtime.statePath).toBe(
      join(tempDir, "workspace", "data", "reality-alignment-state.json"),
    );
    const state = await runtime.readState();
    expect(state.wishes).toEqual([]);
    await runtime.writeState({ ...state, version: 1 });
    const reloaded = await runtime.readState();
    expect(reloaded.version).toBe(1);
  });

  it("falls back to defaults when toolConfig omits agentId and statePath", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reality-alignment-runtime-"));
    const configPath = join(tempDir, "runtime.json");
    const workspace = join(tempDir, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        sovereignTools: {
          instances: [{ id: "reality-alignment-core" }],
        },
        openclawProfile: {
          agents: [{ id: "reality-alignment", workspace }],
        },
      }),
      "utf8",
    );
    const runtime = new RealityAlignmentRuntime("reality-alignment-core", configPath);
    await runtime.load();
    expect(runtime.statePath).toBe(join(workspace, "data", "reality-alignment-state.json"));
  });

  it("rejects missing tool instance and missing agent", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reality-alignment-runtime-"));
    const configPath = await writeRuntimeConfig(tempDir);

    await expect(resolveToolRuntime("missing-tool", configPath)).rejects.toThrow(
      "Tool instance 'missing-tool' was not found",
    );

    const orphanRoot = await mkdtemp(join(tmpdir(), "reality-alignment-orphan-"));
    const orphanConfig = join(orphanRoot, "runtime.json");
    await writeFile(
      orphanConfig,
      JSON.stringify({
        sovereignTools: {
          instances: [
            {
              id: "reality-alignment-core",
              config: { agentId: "missing-agent" },
            },
          ],
        },
        openclawProfile: { agents: [] },
      }),
      "utf8",
    );
    await expect(resolveToolRuntime("reality-alignment-core", orphanConfig)).rejects.toThrow(
      "agent 'missing-agent' was not found",
    );
    await rm(orphanRoot, { recursive: true, force: true });
  });
});
