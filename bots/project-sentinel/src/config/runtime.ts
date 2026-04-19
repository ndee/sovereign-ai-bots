import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  DEFAULT_AGENT_ID,
  DEFAULT_CONFIG_PATH,
  DEFAULT_DIGEST_INTERVAL,
  DEFAULT_POLICY_PATH,
  DEFAULT_SOURCES_PATH,
  DEFAULT_STATE_PATH,
} from "../constants.js";
import { createEmptySourcesDocument, normalizeSourcesDocument } from "../sources.js";
import {
  createDefaultState,
  createDefaultUserPolicy,
  migrateState,
  normalizeUserPolicy,
  readJsonFile,
  writeJsonFile,
} from "../state.js";
import type { ProjectSentinelState, SourceConfigDocument, UserPolicy } from "../types.js";
import {
  ensureTrailingSlash,
  parseRuntimeConfigDocument,
  resolveRelativeToBase,
  stripSingleTrailingNewline,
} from "../util.js";

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
      matrix?: { accessTokenSecretRef?: unknown };
    }>;
  };
  matrix?: {
    adminBaseUrl?: string;
    alertRoom?: { roomId?: string };
  };
}

/* v8 ignore start -- secret ref parsing is exercised through runtime load behavior tests */
const resolveSecretRefValue = async (secretRef: unknown): Promise<string> => {
  if (typeof secretRef !== "string" || secretRef.length === 0) {
    throw new Error("Missing secret reference");
  }
  if (secretRef.startsWith("file:")) {
    const value = stripSingleTrailingNewline(await readFile(secretRef.slice(5), "utf8"));
    if (value.length === 0) {
      throw new Error(`Secret file for ${secretRef} is empty`);
    }
    return value;
  }
  if (secretRef.startsWith("env:")) {
    const key = secretRef.slice(4);
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    throw new Error(`Environment variable ${key} is not set`);
  }
  throw new Error(`Unsupported secretRef format: ${secretRef}`);
};
/* v8 ignore stop */

export class ProjectSentinelRuntime {
  instanceId: string;
  configPath: string;
  runtimeConfig!: RuntimeConfigDocument;
  workspaceDir!: string;
  statePath!: string;
  sourcesPath!: string;
  policyPath!: string;
  digestInterval!: string;
  matrix!: {
    adminBaseUrl: string | undefined;
    roomId: string | undefined;
    accessToken: string;
  };

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
      throw new Error(`Project Sentinel agent '${agentId}' was not found in ${this.configPath}`);
    }
    this.workspaceDir = agent.workspace;
    this.statePath = resolveRelativeToBase(
      (toolConfig.statePath as string | undefined) ?? DEFAULT_STATE_PATH,
      this.workspaceDir,
    );
    this.sourcesPath = resolveRelativeToBase(
      (toolConfig.sourcesPath as string | undefined) ?? DEFAULT_SOURCES_PATH,
      this.workspaceDir,
    );
    this.policyPath = resolveRelativeToBase(
      (toolConfig.policyPath as string | undefined) ?? DEFAULT_POLICY_PATH,
      this.workspaceDir,
    );
    this.digestInterval =
      (toolConfig.digestInterval as string | undefined) ?? DEFAULT_DIGEST_INTERVAL;
    this.matrix = {
      adminBaseUrl:
        (toolConfig.matrixAdminBaseUrl as string | undefined) ??
        this.runtimeConfig.matrix?.adminBaseUrl,
      roomId:
        (toolConfig.matrixAlertRoomId as string | undefined) ??
        this.runtimeConfig.matrix?.alertRoom?.roomId,
      accessToken: await resolveSecretRefValue(agent.matrix?.accessTokenSecretRef),
    };
  }

  async readState(): Promise<ProjectSentinelState> {
    return migrateState(await readJsonFile(this.statePath, createDefaultState()));
  }

  async writeState(state: ProjectSentinelState): Promise<void> {
    await writeJsonFile(this.statePath, state);
  }

  async readSources(): Promise<SourceConfigDocument> {
    return normalizeSourcesDocument(
      await readJsonFile<SourceConfigDocument>(this.sourcesPath, createEmptySourcesDocument()),
    );
  }

  async writeSources(document: SourceConfigDocument): Promise<void> {
    await writeJsonFile(this.sourcesPath, normalizeSourcesDocument(document));
  }

  async readPolicy(): Promise<UserPolicy> {
    return normalizeUserPolicy(
      await readJsonFile<UserPolicy>(this.policyPath, createDefaultUserPolicy()),
    );
  }

  async writePolicy(policy: UserPolicy): Promise<void> {
    await writeJsonFile(this.policyPath, policy);
  }

  async sendMatrixRoomMessage(text: string): Promise<void> {
    const adminBaseUrl = this.matrix.adminBaseUrl;
    const roomId = this.matrix.roomId;
    if (adminBaseUrl === undefined || roomId === undefined) {
      throw new Error("Matrix admin base URL or room ID is not configured");
    }
    const endpoint = new URL(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(randomUUID())}`,
      ensureTrailingSlash(adminBaseUrl),
    ).toString();
    const response = await fetch(endpoint, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.matrix.accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        msgtype: "m.text",
        body: text,
      }),
    });
    if (!response.ok) {
      throw new Error(`Failed to send Matrix room message (${response.status})`);
    }
  }
}

/* v8 ignore next 5 -- thin convenience wrapper over ProjectSentinelRuntime */
export const resolveToolRuntime = async (
  instanceId: string,
  configPath?: string,
): Promise<ProjectSentinelRuntime> => {
  const runtime = new ProjectSentinelRuntime(instanceId, configPath);
  await runtime.load();
  return runtime;
};
