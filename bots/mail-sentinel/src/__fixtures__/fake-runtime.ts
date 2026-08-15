import type { LlmCandidate, LlmResult, MailSentinelPolicy, MailSentinelState, RulesDocument } from "../types.js";
import { createDefaultPolicy, createDefaultState } from "../state/schema.js";

/**
 * In-memory stand-in for MailSentinelRuntime used by command tests. Mirrors
 * the public surface the commands rely on: state/policy/rules IO, matrix
 * sends, and IMAP/tool invocations.
 */
export class FakeMailSentinelRuntime {
  instanceId = "ms-core";
  configPath = "/tmp/config.json5";
  statePath = "/tmp/ms-workspace/data/state.json";
  rulesPath = "/tmp/ms-workspace/config/rules.json";
  policyPath = "/tmp/ms-workspace/config/policy.json";
  lookbackWindow = "1h";
  defaultReminderDelay = "4h";
  digestInterval = "12h";
  imapInstanceId = "ms-imap";
  openclawUrl = "http://localhost";
  llmModel = "test-model";
  llmTimeoutMs = 1000;
  openclawToken: string | undefined = undefined;
  matrix = { adminBaseUrl: "https://matrix.example", roomId: "!room:example", accessToken: "tok" };
  imapConfigured = true;
  workspaceDir = "/tmp/ms-workspace";

  state: MailSentinelState = createDefaultState();
  policy: MailSentinelPolicy = createDefaultPolicy();
  rules: RulesDocument = {
    version: 2,
    thresholds: { candidate: 3, alert: 4, category: 4 },
    zoneThresholds: {
      redMinConfidence: 75,
      amberMinConfidence: 40,
      redMinHeuristicScore: 4,
      amberMinHeuristicScore: 3,
    },
    senderWeights: {},
    domainWeights: {},
    bulk: { enabled: true, minSignals: 2, minLinks: 8, grayConfidence: 0.7 },
    rules: [],
  };

  readState = async (): Promise<MailSentinelState> => this.state;
  writeState = async (state: MailSentinelState): Promise<void> => {
    this.state = state;
  };
  readPolicy = async (): Promise<MailSentinelPolicy> => this.policy;
  writePolicy = async (policy: MailSentinelPolicy): Promise<void> => {
    this.policy = policy;
  };
  readRules = async (): Promise<RulesDocument> => this.rules;

  // IMAP tool surface
  searchMail = async (
    _limit: number,
  ): Promise<{ messages: unknown[]; uidValidity?: string; query?: string }> => ({
    messages: [],
    query: "since:2026-08-14",
  });
  readMail = async (_selector: string | number) => ({ message: { uid: 0 } });
  runTool = async (_command: readonly string[], _args: readonly string[]): Promise<unknown> => ({});

  // Matrix surface
  sendMatrixRoomMessage = async (
    _message: string | { body: string; formattedBody: string },
  ): Promise<void> => undefined;

  // LLM surface
  classifyCandidate = async (_candidate: LlmCandidate): Promise<LlmResult> => ({
    decisionRequired: false,
    financialRelevance: false,
    riskEscalation: false,
    confidence: 0,
    urgency: "low",
    reason: "stub",
    deadlineDetected: false,
    amountDetected: false,
    suggestedZone: "gray",
  });
}

/**
 * Install a shared fake runtime. Each test is expected to reset the singleton
 * via `resetFakeRuntime` in a beforeEach.
 */
let current: FakeMailSentinelRuntime = new FakeMailSentinelRuntime();

export const resetFakeRuntime = (): FakeMailSentinelRuntime => {
  current = new FakeMailSentinelRuntime();
  return current;
};

export const getFakeRuntime = (): FakeMailSentinelRuntime => current;
