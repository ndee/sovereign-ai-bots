export const DEFAULT_CONFIG_PATH = "/etc/sovereign-node/sovereign-node.json5";
export const DEFAULT_STATE_PATH = "data/mail-sentinel-state.json";
export const DEFAULT_RULES_PATH = "config/default-rules.json";
export const DEFAULT_POLICY_PATH = "config/user-policy.json";
export const DEFAULT_IMAP_INSTANCE_ID = "mail-sentinel-imap";
export const DEFAULT_LOOKBACK_WINDOW = "1h";
export const DEFAULT_REMINDER_DELAY = "4h";
export const DEFAULT_DIGEST_INTERVAL = "12h";
export const DEFAULT_IMAP_SEARCH_LIMIT = 50;
export const DEFAULT_IMAP_READ_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_STATE_LOCK_RETRY_DELAY_MS = 50;
// Retry window = RETRY_ATTEMPTS * RETRY_DELAY_MS. 600 * 50ms = 30s, chosen
// so that a CLI command (feedback, list-alerts, policy) can outwait a
// single scan cycle that holds the lock through IMAP fetch + LLM
// classification. The prior 10s window (200 attempts) timed out on
// contested scans once subscription-renewal and fixture traffic started
// producing more per-scan LLM work.
export const DEFAULT_STATE_LOCK_RETRY_ATTEMPTS = 600;
export const DEFAULT_STATE_LOCK_STALE_MS = 5 * 60 * 1000;
export const DEFAULT_TOOL_EXECUTABLE = "/usr/local/bin/sovereign-tool";
export const DEFAULT_AGENT_ID = "mail-sentinel";
export const DEFAULT_OPENCLAW_URL = "http://127.0.0.1:18789";
export const DEFAULT_LLM_MODEL = "qwen/qwen3.5-9b";
export const DEFAULT_LLM_TIMEOUT_MS = 30_000;
export const RULE_ADJUSTMENT_FLOOR = -1;
export const MAX_THREAD_CONTEXT_ENTRIES = 2;
export const MAX_PENDING_AMBER_ITEMS = 200;

export const CATEGORY_LABELS: Record<string, string> = {
  "decision-required": "Decision Required",
  "financial-relevance": "Financial Relevance",
  "risk-escalation": "Risk / Escalation",
};

export const ZONE_ORDER: Record<string, number> = {
  gray: 0,
  amber: 1,
  red: 2,
};
