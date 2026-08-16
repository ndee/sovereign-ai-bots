import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  DEFAULT_AGENT_ID,
  DEFAULT_BULK_ENABLED,
  DEFAULT_BULK_GRAY_CONFIDENCE,
  DEFAULT_BULK_MIN_LINKS,
  DEFAULT_BULK_MIN_SIGNALS,
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
import { buildLookbackImapSearchQuery } from "../util/imap-search-query.js";
import { compactText, ensureTrailingSlash, stripSingleTrailingNewline } from "../util/normalize.js";
import {
  parseJsonAfterPreamble,
  parseRuntimeConfigDocument,
  resolveRelativeToBase,
} from "../util/paths.js";

const CLASSIFY_RETRY_BACKOFF_MS: readonly number[] = [250, 750];

const MATRIX_TEXT_MSGTYPE = "m.text";
const MATRIX_CUSTOM_HTML_FORMAT = "org.matrix.custom.html";

const delay = (ms: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

/**
 * Tool-executable readiness (#324).
 *
 * Pro web installs can ship without `/usr/local/bin/sovereign-tool`, and until
 * now the resulting ENOENT was collapsed into the generic "<command> failed"
 * message — indistinguishable from a mailbox failure, and only surfaced after
 * three failed timer ticks as a misleading "check the mailbox connection"
 * notice. Everything below exists to make "the tool binary itself is unusable"
 * a first-class, programmatically recognizable condition.
 */

/** Marker code set on errors that mean "the sovereign-tool executable is unusable". */
export const TOOL_UNAVAILABLE_ERROR_CODE = "MAIL_SENTINEL_TOOL_UNAVAILABLE";

/**
 * Where the executable path came from. An `override` that is broken is a
 * configuration error the operator made; a broken `default` is an installation
 * defect (the #324 incident). Callers word their guidance on this distinction.
 */
export type ToolExecutableSource = "default" | "override";

export type ToolAvailability =
  | { ok: true; executable: string; source: ToolExecutableSource }
  | { ok: false; executable: string; source: ToolExecutableSource; reason: string };

/** Resolve the sovereign-tool executable path: env override, then the default. */
export const resolveToolExecutable = (): string =>
  process.env.SOVEREIGN_TOOL_EXECUTABLE ?? DEFAULT_TOOL_EXECUTABLE;

const resolveToolExecutableSource = (): ToolExecutableSource =>
  process.env.SOVEREIGN_TOOL_EXECUTABLE === undefined ? "default" : "override";

const toolUnavailableMessage = (executable: string, source: ToolExecutableSource): string =>
  [
    `IMAP tool unavailable: ${executable} not found.`,
    "Mail scanning cannot proceed until the tool is installed or configured.",
    ...(source === "override" ? ["(configured via SOVEREIGN_TOOL_EXECUTABLE)"] : []),
  ].join(" ");

/** Build the recognizable tool-unavailable error the scan path throws and detects. */
export const createToolUnavailableError = (message: string): Error =>
  Object.assign(new Error(message), { code: TOOL_UNAVAILABLE_ERROR_CODE });

export const isToolUnavailableError = (error: unknown): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === TOOL_UNAVAILABLE_ERROR_CODE;

/**
 * Probe whether the resolved tool executable exists and is executable.
 *
 * A broken `SOVEREIGN_TOOL_EXECUTABLE` override is never silently ignored in
 * favour of the default: whatever path resolution produced is exactly what is
 * probed, and the failure reason names the override so the operator fixes the
 * configuration rather than reinstalling a tool that was never consulted.
 */
export const checkToolAvailability = async (): Promise<ToolAvailability> => {
  const executable = resolveToolExecutable();
  const source = resolveToolExecutableSource();
  try {
    await access(executable, fsConstants.X_OK);
    return { ok: true, executable, source };
  } catch {
    return { ok: false, executable, source, reason: toolUnavailableMessage(executable, source) };
  }
};

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
    const bulk = (rulesRecord.bulk ?? {}) as Record<string, unknown>;
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
      bulk: {
        enabled: typeof bulk.enabled === "boolean" ? bulk.enabled : DEFAULT_BULK_ENABLED,
        minSignals: Number(bulk.minSignals ?? DEFAULT_BULK_MIN_SIGNALS),
        minLinks: Number(bulk.minLinks ?? DEFAULT_BULK_MIN_LINKS),
        grayConfidence: Number(bulk.grayConfidence ?? DEFAULT_BULK_GRAY_CONFIDENCE),
      },
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
    const executable = resolveToolExecutable();
    const result = await execFileAsync(executable, [...command, ...args], {
      maxBuffer: 10 * 1024 * 1024,
    }).catch((error: NodeJS.ErrnoException & { stdout?: unknown; stderr?: unknown }) => {
      // A missing or non-executable tool binary is NOT a tool failure: collapse
      // it into the generic message below and "the install shipped without
      // sovereign-tool" (#324) becomes indistinguishable from "the mailbox is
      // broken". Inspect the spawn error code before the message is rewritten.
      if (error.code === "ENOENT" || error.code === "EACCES") {
        throw createToolUnavailableError(
          toolUnavailableMessage(executable, resolveToolExecutableSource()),
        );
      }
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

  /**
   * Builds the IMAP query for a scan. The lookback window is pushed into the
   * server-side search (`SINCE <date>`) so a real, long-lived mailbox is never
   * asked to enumerate every UID it has ever held (bots#142). `now` is
   * injectable for tests.
   */
  resolveImapSearchQuery(now: Date = new Date()): string {
    return buildLookbackImapSearchQuery(this.lookbackWindow, now);
  }

  async searchMail(limit: number = DEFAULT_IMAP_SEARCH_LIMIT): Promise<{
    messages?: Array<{
      uid: number;
      size?: number;
      messageId?: string;
      from?: unknown;
      subject?: unknown;
    }>;
    uidValidity?: string;
    /** The effective `--query` handed to `imap-search-mail`, for reporting. */
    query: string;
  }> {
    const query = this.resolveImapSearchQuery();
    const result = (await this.runTool(
      ["imap-search-mail"],
      [
        "--instance",
        this.imapInstanceId,
        "--query",
        query,
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
      uidValidity?: string;
    };
    return { ...result, query };
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

  async sendMatrixRoomMessage(
    message: string | { body: string; formattedBody: string },
  ): Promise<void> {
    const adminBaseUrl = this.matrix.adminBaseUrl;
    const roomId = this.matrix.roomId;
    if (adminBaseUrl === undefined || roomId === undefined) {
      throw new Error("Matrix admin base URL or room ID is not configured");
    }
    const endpoint = new URL(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(randomUUID())}`,
      ensureTrailingSlash(adminBaseUrl),
    ).toString();
    const payload: Record<string, string> =
      typeof message === "string"
        ? { msgtype: MATRIX_TEXT_MSGTYPE, body: message }
        : {
            msgtype: MATRIX_TEXT_MSGTYPE,
            body: message.body,
            format: MATRIX_CUSTOM_HTML_FORMAT,
            formatted_body: message.formattedBody,
          };
    const response = await fetch(endpoint, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.matrix.accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
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
    const sessionKey = `agent:${this.agent.id}:main`;
    const pipeline = [
      "exec",
      `--json --shell ${quoteLobsterArg(`cat ${candidateFile}`)}`,
      "| clawd.invoke",
      "--tool llm-task",
      "--action json",
      `--args-json ${quoteLobsterArg(JSON.stringify(args))}`,
      `--session-key ${quoteLobsterArg(sessionKey)}`,
      "--each --item-key input",
      "| json",
    ].join(" ");
    try {
      for (const backoffMs of CLASSIFY_RETRY_BACKOFF_MS) {
        try {
          return await this.runClassifyPipeline(pipeline);
        } catch {
          await delay(backoffMs);
        }
      }
      return await this.runClassifyPipeline(pipeline);
    } finally {
      await rm(candidateFile, { force: true });
    }
  }

  private async runClassifyPipeline(pipeline: string): Promise<LlmResult> {
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
    const parsed = parseJsonAfterPreamble(String(result.stdout));
    const first = Array.isArray(parsed)
      ? (parsed[0] as Record<string, unknown>)
      : (parsed as Record<string, unknown> | null);
    const output = first?.output as { text?: unknown; data?: unknown } | undefined;
    // `output.text` is the model's own answer, which can arrive wrapped in
    // prose or a ```json fence. Tolerate a preamble here as well so a chatty
    // model does not read as a hard classification failure.
    const rawText = typeof output?.text === "string" ? parseJsonAfterPreamble(output.text) : null;
    const details = first?.details as { json?: unknown } | undefined;
    const raw =
      details?.json ?? rawText ?? output?.data ?? (first as { data?: unknown })?.data ?? first;
    if (raw === null || typeof raw !== "object") {
      // Include a bounded excerpt of what we actually got. Without it the
      // operator-facing warning ("returned invalid JSON output") gives no way
      // to tell a dead classifier apart from stdout polluted by a login-shell
      // banner, which is what made this failure mode hard to diagnose.
      const excerpt = compactText(String(result.stdout)).slice(0, 200);
      throw new Error(
        `lobster classification returned no structured JSON payload (stdout: ${
          excerpt.length > 0 ? excerpt : "<empty>"
        })`,
      );
    }
    return normalizeLlmResult(raw as Parameters<typeof normalizeLlmResult>[0]);
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
