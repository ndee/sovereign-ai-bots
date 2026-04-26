import { readFile } from "node:fs/promises";

import { DEFAULT_AGENT_ID, DEFAULT_CONFIG_PATH, DEFAULT_STATE_PATH } from "../constants.js";
import { createDefaultState, migrateState, readJsonFile, writeJsonFile } from "../state.js";
import type { RealityAlignmentState } from "../types.js";
import { parseRuntimeConfigDocument, resolveRelativeToBase } from "../util.js";

interface RuntimeConfigDocument {
  sovereignTools?: {
    instances?: Array<{
      id: string;
      config?: Record<string, unknown>;
    }>;
  };
  openclawProfile?: {
    agents?: Array<{
      id: string;
      workspace: string;
    }>;
  };
}

export class RealityAlignmentRuntime {
  instanceId: string;
  configPath: string;
  runtimeConfig!: RuntimeConfigDocument;
  workspaceDir!: string;
  statePath!: string;

  constructor(instanceId: string, configPath?: string) {
    this.instanceId = instanceId;
    /* v8 ignore next -- default config path fallback is host-environment specific */
    this.configPath = configPath ?? process.env.SOVEREIGN_NODE_CONFIG ?? DEFAULT_CONFIG_PATH;
  }

  async load(): Promise<void> {
    const raw = await readFile(this.configPath, "utf8");
    this.runtimeConfig = parseRuntimeConfigDocument(raw) as RuntimeConfigDocument;
    /* v8 ignore next 3 -- missing tool lists fail with the same public error surface */
    const tool = (this.runtimeConfig.sovereignTools?.instances ?? []).find(
      (entry) => entry.id === this.instanceId,
    );
    if (tool === undefined) {
      throw new Error(`Tool instance '${this.instanceId}' was not found in ${this.configPath}`);
    }
    const toolConfig = tool.config ?? {};
    const agentId = (toolConfig.agentId as string | undefined) ?? DEFAULT_AGENT_ID;
    /* v8 ignore next 3 -- missing agent lists fail with the same public error surface */
    const agent = (this.runtimeConfig.openclawProfile?.agents ?? []).find(
      (entry) => entry.id === agentId,
    );
    if (agent === undefined) {
      throw new Error(`Reality Alignment agent '${agentId}' was not found in ${this.configPath}`);
    }
    this.workspaceDir = agent.workspace;
    this.statePath = resolveRelativeToBase(
      (toolConfig.statePath as string | undefined) ?? DEFAULT_STATE_PATH,
      this.workspaceDir,
    );
  }

  async readState(): Promise<RealityAlignmentState> {
    return migrateState(await readJsonFile(this.statePath, createDefaultState()));
  }

  async writeState(state: RealityAlignmentState): Promise<void> {
    await writeJsonFile(this.statePath, state);
  }
}

/* v8 ignore next 5 -- thin convenience wrapper over RealityAlignmentRuntime */
export const resolveToolRuntime = async (
  instanceId: string,
  configPath?: string,
): Promise<RealityAlignmentRuntime> => {
  const runtime = new RealityAlignmentRuntime(instanceId, configPath);
  await runtime.load();
  return runtime;
};
