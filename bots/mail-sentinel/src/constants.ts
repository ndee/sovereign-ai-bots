export const DEFAULT_CONFIG_PATH = "/etc/sovereign-node/sovereign-node.json5";
export const DEFAULT_STATE_PATH = "data/mail-sentinel-state.json";
export const DEFAULT_RULES_PATH = "config/default-rules.json";
export const DEFAULT_POLICY_PATH = "config/user-policy.json";
export const DEFAULT_IMAP_INSTANCE_ID = "mail-sentinel-imap";
export const DEFAULT_LOOKBACK_WINDOW = "1h";
export const DEFAULT_POLL_INTERVAL = "30m";
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
// progress and the failure bookkeeping. No review call starts after the budget
// either, so the worst case after the last budget check is the larger of one
// read (60 s, its review then postponed) and one review call up to its client
// kill (`DEFAULT_LLM_TIMEOUT_MS` + `LLM_CLIENT_KILL_MARGIN_MS` = 75 s): the
// message loop ends by 255 s, leaving 45 s of the ceiling for the writes.
export const DEFAULT_SCAN_BUDGET_MS = 180_000;
// Attempts for the one search that opens every scan. A remote IMAP provider
// (Gmail observed on example-node, bots#152) answers the same 3–12-message
// `SINCE` search anywhere between 3 s and well past the per-call ceiling, on
// a per-connection basis — and a scan had exactly one shot at it, so about
// half of all scans failed outright and marched toward "scans-failing". A
// second attempt on a fresh connection costs at most one more tool timeout;
// the budget math still holds (2 × 60 s search, then reads and reviews until
// the 180 s budget, plus one trailing read (60 s) or review call (75 s) <
// TimeoutStartSec 300 s). Reads are not retried here: a skipped read leaves the watermark
// alone and is re-read on the next tick.
export const DEFAULT_IMAP_SEARCH_ATTEMPTS = 2;
// The independent mail inventory runs first in every scan and is counted in
// the same budget, so it gets a tight deadline of its own: a slow listing must
// cost one inventory, not the scan. Worst case 25 s + 2 × 60 s search is still
// inside the 180 s budget, after which at most one read (60 s) or one review
// call (75 s) follows, under TimeoutStartSec 300 s.
export const MAIL_INVENTORY_TIMEOUT_MS = 20_000;
export const MAIL_INVENTORY_KILL_MS = 25_000;
export const DEFAULT_AGENT_ID = "mail-sentinel";
export const DEFAULT_OPENCLAW_URL = "http://127.0.0.1:18789";
// NOTE: `llmModel` is carried in the tool config for compatibility only. The
// semantic review runs through `lobster … | clawd.invoke --tool llm-task`, and
// the node pins the gateway's `llm-task` plugin to a single default and
// allowed model, so that model classifies — not this value, and not the
// agent's `agentTemplate.model`. It is never sent to the gateway.
export const DEFAULT_LLM_MODEL = "qwen/qwen3.5-9b";
// Gateway-side limit for one review call, sent with every call as llm-task's
// `timeoutMs` (`llmTimeoutMs` in the tool config). At normal load the review
// took about 15 s at the median and at least 30 s at p95, so a 30 s limit
// timed out about a third of all calls.
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;
// The client kills the lobster child this long after the gateway-side limit.
// The gateway reports its own timeout as a generic error, and lobster start-up
// plus the HTTP round trip take seconds on a small device; with this margin
// that error comes back first, and a killed call does not keep running in the
// gateway while the next one starts.
export const LLM_CLIENT_KILL_MARGIN_MS = 15_000;
// In-scan retry window for one review: at most two calls, the second only
// after a failure that came back faster than `LLM_FAST_FAILURE_MS` (connection
// refused, HTTP error, invalid reply), after `LLM_RETRY_PAUSE_MS`, and only
// while the scan budget lasts. A slow failure or a timeout is not retried in
// the same scan: at normal latency a retry would just time out again.
export const LLM_FAST_FAILURE_MS = 10_000;
export const LLM_RETRY_PAUSE_MS = 5_000;
// After this many reviews in a row without a verdict the scan stops sending
// candidates and postpones the rest. With two calls per review that caps a
// scan with a dead reviewer at four calls, while one slow call alone does not
// take the reviewer away from the rest of the scan.
export const LLM_REVIEW_BREAKER_FAILURES = 2;
/** Default for `llmSenderDetail`: the bare address, never the display name. */
export const DEFAULT_LLM_SENDER_DETAIL = "address";
export const RULE_ADJUSTMENT_FLOOR = -1;
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
