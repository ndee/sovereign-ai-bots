import { readFile } from "node:fs/promises";
import { loadState, saveState } from "./state.js";
import type { WealthState } from "./types.js";
import { resolveRelativeToBase, stripSingleTrailingNewline } from "./util.js";

export interface WealthRuntime {
  instanceId: string;
  agentId: string;
  workspaceDir: string;
  statePath: string;
  inboxPath: string;
  readState: () => Promise<WealthState>;
  writeState: (state: WealthState) => Promise<void>;
}

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

const parseRuntimeConfigDocument = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    /* v8 ignore next 1 -- legacy JS-config fallback */
    return new Function(`"use strict"; return (${raw});`)();
  }
};

const DEFAULT_CONFIG_PATH = "/etc/sovereign-ai-node/node-config.json";
const DEFAULT_STATE_PATH = "data/wealth-alignment-state.json";
const DEFAULT_INBOX_PATH = "inbox";

const stringFromConfig = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export interface RuntimeOverrides {
  workspaceDir?: string;
  statePath?: string;
  inboxPath?: string;
  agentId?: string;
}

export const createRuntime = (instanceId: string, overrides: RuntimeOverrides): WealthRuntime => {
  const workspaceDir = overrides.workspaceDir ?? process.cwd();
  const statePath = resolveRelativeToBase(overrides.statePath ?? DEFAULT_STATE_PATH, workspaceDir);
  const inboxPath = resolveRelativeToBase(overrides.inboxPath ?? DEFAULT_INBOX_PATH, workspaceDir);
  return {
    instanceId,
    agentId: overrides.agentId ?? instanceId,
    workspaceDir,
    statePath,
    inboxPath,
    readState: () => loadState(statePath),
    writeState: (state) => saveState(statePath, state),
  };
};

export const resolveRuntime = async (
  instanceId: string,
  configPath?: string,
): Promise<WealthRuntime> => {
  const overrides: RuntimeOverrides = {};
  /* v8 ignore next -- DEFAULT_CONFIG_PATH fallback is exercised on real Sovereign Node hosts only */
  const path = configPath ?? process.env.SOVEREIGN_NODE_CONFIG ?? DEFAULT_CONFIG_PATH;
  try {
    const raw = stripSingleTrailingNewline(await readFile(path, "utf8"));
    const document = parseRuntimeConfigDocument(raw) as RuntimeConfigDocument;
    const instance = document.sovereignTools?.instances?.find((entry) => entry.id === instanceId);
    const config = instance?.config ?? {};
    const workspace = stringFromConfig(
      document.openclawProfile?.agents?.find((agent) => agent.id === instanceId)?.workspace,
    );
    if (workspace !== undefined) {
      overrides.workspaceDir = workspace;
    }
    const statePath = stringFromConfig(config.statePath);
    if (statePath !== undefined) {
      overrides.statePath = statePath;
    }
    const inboxPath = stringFromConfig(config.inboxPath);
    if (inboxPath !== undefined) {
      overrides.inboxPath = inboxPath;
    }
    const agentId = stringFromConfig(config.agentId);
    if (agentId !== undefined) {
      overrides.agentId = agentId;
    }
  } catch (error) {
    /* v8 ignore start -- runtime config is optional */
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    /* v8 ignore stop */
  }
  return createRuntime(instanceId, overrides);
};
