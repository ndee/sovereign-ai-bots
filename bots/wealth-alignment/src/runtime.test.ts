import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntime, resolveRuntime } from "./runtime.js";

describe("wealth-alignment/runtime", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("creates a runtime with overrides and reads/writes state", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "wealth-runtime-"));
    const runtime = createRuntime("wealth-alignment-core", { workspaceDir: tempDir });
    expect(runtime.statePath.startsWith(tempDir)).toBe(true);
    expect(runtime.inboxPath.startsWith(tempDir)).toBe(true);
    const state = await runtime.readState();
    expect(state.documents).toEqual([]);
    state.counters.documents = 5;
    await runtime.writeState(state);
    const reread = await runtime.readState();
    expect(reread.counters.documents).toBe(5);
  });

  it("falls back to defaults when no config file exists", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "wealth-runtime-"));
    const runtime = await resolveRuntime("wealth-alignment-core", join(tempDir, "missing.json"));
    expect(runtime.instanceId).toBe("wealth-alignment-core");
  });

  it("reads instance overrides from a config file", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "wealth-runtime-"));
    const workspace = join(tempDir, "workspace");
    await mkdir(workspace, { recursive: true });
    const configPath = join(tempDir, "node-config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        sovereignTools: {
          instances: [
            {
              id: "wealth-alignment-core",
              config: {
                statePath: join(tempDir, "data", "state.json"),
                inboxPath: join(tempDir, "inbox"),
                agentId: "wealth-alignment-core",
              },
            },
          ],
        },
        openclawProfile: {
          agents: [{ id: "wealth-alignment-core", workspace }],
        },
      }),
    );
    const runtime = await resolveRuntime("wealth-alignment-core", configPath);
    expect(runtime.workspaceDir).toBe(workspace);
    expect(runtime.statePath).toContain("state.json");
    expect(runtime.inboxPath).toContain("inbox");
    expect(runtime.agentId).toBe("wealth-alignment-core");
  });

  it("falls back to JS-eval when the config file is not valid JSON", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "wealth-runtime-"));
    const configPath = join(tempDir, "node-config.js");
    await writeFile(
      configPath,
      "{ sovereignTools: { instances: [{ id: 'wealth-alignment-core', config: { agentId: 'x' } }] } }",
    );
    const runtime = await resolveRuntime("wealth-alignment-core", configPath);
    expect(runtime.agentId).toBe("x");
  });

  it("falls back to defaults when the requested instance is missing from the config", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "wealth-runtime-"));
    const configPath = join(tempDir, "node-config.json");
    await writeFile(configPath, JSON.stringify({}));
    const runtime = await resolveRuntime("wealth-alignment-core", configPath);
    expect(runtime.instanceId).toBe("wealth-alignment-core");
  });

  it("reads SOVEREIGN_NODE_CONFIG from the environment when no path is provided", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "wealth-runtime-"));
    const configPath = join(tempDir, "node-config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        sovereignTools: {
          instances: [
            {
              id: "wealth-alignment-core",
              config: { agentId: "from-env" },
            },
          ],
        },
      }),
    );
    const original = process.env.SOVEREIGN_NODE_CONFIG;
    process.env.SOVEREIGN_NODE_CONFIG = configPath;
    try {
      const runtime = await resolveRuntime("wealth-alignment-core");
      expect(runtime.agentId).toBe("from-env");
    } finally {
      if (original === undefined) {
        delete process.env.SOVEREIGN_NODE_CONFIG;
      } else {
        process.env.SOVEREIGN_NODE_CONFIG = original;
      }
    }
  });
});
