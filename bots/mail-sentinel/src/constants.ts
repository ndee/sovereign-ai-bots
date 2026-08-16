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
// Per-invocation ceiling for a sovereign-tool child (imap-search-mail,
// imap-read-mail). The tool has its own imapflow connect/greeting/socket
// timeouts, but they are *idle* timeouts on one socket; a child that keeps
// trickling bytes, or wedges outside imapflow entirely, would otherwise hold
// the scan open until systemd's TimeoutStartSec kills the whole unit.
// Sized so a 5 MB message still fits comfortably.
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
// Wall-clock budget for the per-message body of one scan (reads + semantic
// review). The scan unit runs under `TimeoutStartSec=300` (sovereign-bot.json);
// once the budget is spent the scan stops reading, defers the remaining
// (higher-UID) messages to the next timer tick via the watermark, and finishes
// on its own terms — instead of being SIGKILLed mid-write and losing both the
// progress and the failure bookkeeping. Worst case after the last budget check
// is one tool call (60s) plus one LLM review (30s), still under the ceiling.
export const DEFAULT_SCAN_BUDGET_MS = 180_000;
export const DEFAULT_AGENT_ID = "mail-sentinel";
export const DEFAULT_OPENCLAW_URL = "http://127.0.0.1:18789";
export const DEFAULT_LLM_MODEL = "qwen/qwen3.5-9b";
export const DEFAULT_LLM_TIMEOUT_MS = 30_000;
export const RULE_ADJUSTMENT_FLOOR = -1;
export const MAX_THREAD_CONTEXT_ENTRIES = 2;
export const MAX_PENDING_AMBER_ITEMS = 200;
// Starting length of a minted short reference (a prefix of `alertId`). Chosen
// for typeability in chat; the minter lengthens past this only when a shorter
// prefix would collide with another live alert's short ref.
export const SHORT_REF_START_LENGTH = 6;

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

// Conservative, default-on bulk/newsletter suppression. Requiring two distinct
// signals keeps transactional mail riding bulk infrastructure (e.g. a receipt
// from noreply@ with a lone list-unsubscribe header) out of the suppression
// path. Tunable via the `bulk` block in the rules document.
export const DEFAULT_BULK_ENABLED = true;
export const DEFAULT_BULK_MIN_SIGNALS = 2;
export const DEFAULT_BULK_MIN_LINKS = 8;
export const DEFAULT_BULK_GRAY_CONFIDENCE = 0.7;
