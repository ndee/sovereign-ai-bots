import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  DEFAULT_AGENT_ID,
  DEFAULT_CONFIG_PATH,
  DEFAULT_DIGEST_INTERVAL,
  DEFAULT_IMAP_INSTANCE_ID,
  DEFAULT_IMAP_SEARCH_LIMIT,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_LOOKBACK_WINDOW,
  DEFAULT_OPENCLAW_URL,
  DEFAULT_POLICY_PATH,
  DEFAULT_REMINDER_DELAY,
  DEFAULT_RULES_PATH,
  DEFAULT_STATE_PATH,
  DEFAULT_TOOL_EXECUTABLE,
} from "../constants.js";
import { execFileAsync, resolveSecretRefValue } from "../imap/exec.js";
import { buildLlmPrompt, normalizeLlmResult, quoteLobsterArg } from "../scoring/llm.js";
import { readJsonFile, writeJsonFile } from "../state/io.js";
import {
  createDefaultPolicy,
  createDefaultState,
  migrateState,
  normalizePolicy,
  pruneState,
} from "../state/schema.js";
import type {
  LlmCandidate,
  LlmResult,
  MailSentinelPolicy,
  MailSentinelState,
  RulesDocument,
} from "../types.js";
import { ensureTrailingSlash, stripSingleTrailingNewline } from "../util/normalize.js";
import {
  parseJsonSafely,
  parseRuntimeConfigDocument,
  resolveRelativeToBase,
} from "../util/paths.js";

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
  imap?: { status?: string };
  openclaw?: { runtimeConfigPath?: string };
}

export class MailSentinelRuntime {
  instanceId: string;
  configPath: string;
  runtimeConfig!: RuntimeConfigDocument;
  agent!: RuntimeConfigDocument extends { openclawProfile?: { agents?: Array<infer A> } }
    ? A
    : never;
  tool!: NonNullable<RuntimeConfigDocument["sovereignTools"]>["instances"] extends
    | Array<infer I>
    | undefined
    ? I
    : never;
  workspaceDir!: string;
  statePath!: string;
  rulesPath!: string;
  policyPath!: string;
  lookbackWindow!: string;
  defaultReminderDelay!: string;
  digestInterval!: string;
  imapInstanceId!: string;
  openclawUrl!: string;
  llmModel!: string;
  llmTimeoutMs!: number;
  openclawToken: string | undefined;
  matrix!: {
    adminBaseUrl: string | undefined;
    roomId: string | undefined;
    accessToken: string;
  };
  imapConfigured!: boolean;

  constructor(instanceId: string, configPath?: string) {
    this.instanceId = instanceId;
    this.configPath = configPath ?? process.env.SOVEREIGN_NODE_CONFIG ?? DEFAULT_CONFIG_PATH;
  }

  async load(): Promise<void> {
    const raw = await readFile(this.configPath, "utf8");
    this.runtimeConfig = parseRuntimeConfigDocument(raw) as RuntimeConfigDocument;
    const tool = (this.runtimeConfig.sovereignTools?.instances ?? []).find(
      (entry) => entry.id === this.instanceId,
    );
    if (tool === undefined) {
      throw new Error(`Tool instance '${this.instanceId}' was not found in ${this.configPath}`);
    }
    const toolConfig = (tool.config ?? {}) as Record<string, unknown>;
    const agentId = (toolConfig.agentId as string | undefined) ?? DEFAULT_AGENT_ID;
    const agent = (this.runtimeConfig.openclawProfile?.agents ?? []).find(
      (entry) => entry.id === agentId,
    );
    if (agent === undefined) {
      throw new Error(`Mail Sentinel agent '${agentId}' was not found in ${this.configPath}`);
    }
    this.agent = agent as this["agent"];
    this.tool = tool as this["tool"];
    this.workspaceDir = agent.workspace;
    this.statePath = resolveRelativeToBase(
      (toolConfig.statePath as string | undefined) ?? DEFAULT_STATE_PATH,
      this.workspaceDir,
    );
    this.rulesPath = resolveRelativeToBase(
      (toolConfig.rulesPath as string | undefined) ?? DEFAULT_RULES_PATH,
      this.workspaceDir,
    );
    this.policyPath = resolveRelativeToBase(
      (toolConfig.policyPath as string | undefined) ?? DEFAULT_POLICY_PATH,
      this.workspaceDir,
    );
    this.lookbackWindow =
      (toolConfig.lookbackWindow as string | undefined) ?? DEFAULT_LOOKBACK_WINDOW;
    this.defaultReminderDelay =
      (toolConfig.defaultReminderDelay as string | undefined) ?? DEFAULT_REMINDER_DELAY;
    this.digestInterval =
      (toolConfig.digestInterval as string | undefined) ?? DEFAULT_DIGEST_INTERVAL;
    this.imapInstanceId =
      (toolConfig.imapInstanceId as string | undefined) ?? DEFAULT_IMAP_INSTANCE_ID;
    this.openclawUrl = (toolConfig.openclawUrl as string | undefined) ?? DEFAULT_OPENCLAW_URL;
    this.llmModel = (toolConfig.llmModel as string | undefined) ?? DEFAULT_LLM_MODEL;
    this.llmTimeoutMs = Number.parseInt(
      String(toolConfig.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS),
      10,
    );
    this.openclawToken = await this.readOpenClawGatewayToken();
    this.matrix = {
      adminBaseUrl:
        (toolConfig.matrixAdminBaseUrl as string | undefined) ??
        this.runtimeConfig.matrix?.adminBaseUrl,
      roomId:
        (toolConfig.matrixAlertRoomId as string | undefined) ??
        this.runtimeConfig.matrix?.alertRoom?.roomId,
      accessToken: await resolveSecretRefValue(
        (agent as { matrix?: { accessTokenSecretRef?: unknown } }).matrix?.accessTokenSecretRef,
      ),
    };
    this.imapConfigured =
      typeof toolConfig.imapConfigured === "string"
        ? toolConfig.imapConfigured === "true"
        : this.runtimeConfig.imap?.status === "configured";
  }

  async readOpenClawGatewayToken(): Promise<string | undefined> {
    const runtimePath = this.runtimeConfig.openclaw?.runtimeConfigPath;
    if (typeof runtimePath !== "string" || runtimePath.length === 0) {
      return undefined;
    }
    try {
      const raw = await readFile(runtimePath, "utf8");
      const parsed = parseRuntimeConfigDocument(raw) as {
        gateway?: { auth?: { token?: unknown } };
      };
      const token = parsed?.gateway?.auth?.token;
      return typeof token === "string" && token.length > 0 ? token : undefined;
    } catch {
      return undefined;
    }
  }

  async readRules(): Promise<RulesDocument> {
    const rules = await readJsonFile<Record<string, unknown> | null>(this.rulesPath, null);
    if (rules === null || typeof rules !== "object") {
      throw new Error(`Mail Sentinel rules at ${this.rulesPath} are invalid`);
    }
    const rulesRecord = rules as Record<string, unknown>;
    const thresholds = (rulesRecord.thresholds ?? {}) as Record<string, unknown>;
    const zoneThresholds = (rulesRecord.zoneThresholds ?? {}) as Record<string, unknown>;
    return {
      version: Number(rulesRecord.version ?? 2),
      thresholds: {
        candidate: Number(thresholds.candidate ?? 3),
        alert: Number(thresholds.alert ?? 4),
        category: Number(thresholds.category ?? 4),
      },
      zoneThresholds: {
        redMinConfidence: Number(zoneThresholds.redMinConfidence ?? 75),
        amberMinConfidence: Number(zoneThresholds.amberMinConfidence ?? 40),
        redMinHeuristicScore: Number(zoneThresholds.redMinHeuristicScore ?? 4),
        amberMinHeuristicScore: Number(zoneThresholds.amberMinHeuristicScore ?? 3),
      },
      defaultReminderDelay:
        typeof rulesRecord.defaultReminderDelay === "string"
          ? rulesRecord.defaultReminderDelay
          : undefined,
      senderWeights: (rulesRecord.senderWeights as Record<string, number>) ?? {},
      domainWeights: (rulesRecord.domainWeights as Record<string, number>) ?? {},
      rules: Array.isArray(rulesRecord.rules) ? rulesRecord.rules : [],
    };
  }

  async readPolicy(): Promise<MailSentinelPolicy> {
    return normalizePolicy(
      await readJsonFile<MailSentinelPolicy>(this.policyPath, createDefaultPolicy()),
    );
  }

  async writePolicy(policy: MailSentinelPolicy): Promise<void> {
    await writeJsonFile(this.policyPath, normalizePolicy(policy));
  }

  async readState(): Promise<MailSentinelState> {
    return migrateState(
      await readJsonFile<MailSentinelState>(this.statePath, createDefaultState()),
    );
  }

  async writeState(state: MailSentinelState): Promise<void> {
    await writeJsonFile(this.statePath, pruneState(migrateState(state)));
  }

  async runTool(command: readonly string[], args: readonly string[]): Promise<unknown> {
    const executable = process.env.SOVEREIGN_TOOL_EXECUTABLE ?? DEFAULT_TOOL_EXECUTABLE;
    const result = await execFileAsync(executable, [...command, ...args], {
      maxBuffer: 10 * 1024 * 1024,
    }).catch((error: NodeJS.ErrnoException & { stdout?: unknown; stderr?: unknown }) => {
      const stdout = typeof error.stdout === "string" ? error.stdout : "";
      const stderr = typeof error.stderr === "string" ? error.stderr : "";
      throw new Error(`${command.join(" ")} failed: ${stderr || stdout || error.message}`);
    });
    const payload = JSON.parse(stripSingleTrailingNewline(String(result.stdout))) as {
      ok?: boolean;
      result?: unknown;
    };
    if (payload?.ok === true && payload.result !== undefined) {
      return payload.result;
    }
    return payload;
  }

  async searchMail(limit: number = DEFAULT_IMAP_SEARCH_LIMIT): Promise<{
    messages?: Array<{
      uid: number;
      size?: number;
      messageId?: string;
      from?: unknown;
      subject?: unknown;
    }>;
  }> {
    return (await this.runTool(
      ["imap-search-mail"],
      [
        "--instance",
        this.imapInstanceId,
        "--query",
        "ALL",
        "--limit",
        String(limit),
        "--config-path",
        this.configPath,
        "--json",
      ],
    )) as {
      messages?: Array<{
        uid: number;
        size?: number;
        messageId?: string;
        from?: unknown;
        subject?: unknown;
      }>;
    };
  }

  async readMail(selector: string | number): Promise<{
    message: {
      uid: number;
      messageId?: unknown;
      from?: unknown;
      subject?: unknown;
      text?: unknown;
      date?: unknown;
      headers?: unknown;
    };
  }> {
    return (await this.runTool(
      ["imap-read-mail"],
      [
        "--instance",
        this.imapInstanceId,
        "--message-id",
        String(selector),
        "--config-path",
        this.configPath,
        "--json",
      ],
    )) as {
      message: {
        uid: number;
        messageId?: unknown;
        from?: unknown;
        subject?: unknown;
        text?: unknown;
        date?: unknown;
        headers?: unknown;
      };
    };
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

  async classifyCandidate(candidate: LlmCandidate): Promise<LlmResult> {
    const args = {
      prompt: buildLlmPrompt(),
    };
    const candidateFile = resolve(
      this.workspaceDir,
      `.mail-sentinel-candidate-${randomUUID()}.json`,
    );
    await writeFile(candidateFile, `${JSON.stringify(candidate)}\n`, "utf8");
    const pipeline = [
      "exec",
      `--json --shell ${quoteLobsterArg(`cat ${candidateFile}`)}`,
      "| clawd.invoke",
      "--tool llm-task",
      "--action json",
      `--args-json ${quoteLobsterArg(JSON.stringify(args))}`,
      "--each --item-key input",
      "| json",
    ].join(" ");
    try {
      const result = await execFileAsync("lobster", [pipeline], {
        cwd: this.workspaceDir,
        timeout: this.llmTimeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          CLAWD_URL: this.openclawUrl,
          ...(this.openclawToken === undefined ? {} : { CLAWD_TOKEN: this.openclawToken }),
        },
      }).catch((error: NodeJS.ErrnoException & { stdout?: unknown; stderr?: unknown }) => {
        const stdout = typeof error.stdout === "string" ? error.stdout : "";
        const stderr = typeof error.stderr === "string" ? error.stderr : "";
        throw new Error(`lobster classification failed: ${stderr || stdout || error.message}`);
      });
      const parsed = parseJsonSafely(String(result.stdout));
      const first = Array.isArray(parsed)
        ? (parsed[0] as Record<string, unknown>)
        : (parsed as Record<string, unknown> | null);
      const output = first?.output as { text?: unknown; data?: unknown } | undefined;
      const rawText = typeof output?.text === "string" ? parseJsonSafely(output.text) : null;
      const details = first?.details as { json?: unknown } | undefined;
      const raw =
        details?.json ?? rawText ?? output?.data ?? (first as { data?: unknown })?.data ?? first;
      if (raw === null || typeof raw !== "object") {
        throw new Error("lobster classification returned no structured JSON payload");
      }
      return normalizeLlmResult(raw as Parameters<typeof normalizeLlmResult>[0]);
    } finally {
      await rm(candidateFile, { force: true });
    }
  }
}

export const resolveToolRuntime = async (
  instanceId: string,
  configPath?: string,
): Promise<MailSentinelRuntime> => {
  const runtime = new MailSentinelRuntime(instanceId, configPath);
  await runtime.load();
  return runtime;
};
