import type { SentinelLane, SentinelRoute } from "./types.js";

export const DEFAULT_CONFIG_PATH = "/etc/sovereign-node/sovereign-node.json5";
export const DEFAULT_AGENT_ID = "project-sentinel";
export const DEFAULT_STATE_PATH = "data/project-sentinel-state.json";
export const DEFAULT_SOURCES_PATH = "config/sources.json";
export const DEFAULT_POLICY_PATH = "config/user-policy.json";
export const DEFAULT_POLL_INTERVAL = "30m";
export const DEFAULT_DIGEST_INTERVAL = "12h";
export const DEFAULT_RED_THRESHOLD = 14;
export const DEFAULT_AMBER_THRESHOLD = 8;
export const DEFAULT_MAX_ITEMS_PER_SOURCE = 10;
export const DEFAULT_STATE_LOCK_RETRY_DELAY_MS = 50;
export const DEFAULT_STATE_LOCK_RETRY_ATTEMPTS = 200;
export const DEFAULT_STATE_LOCK_STALE_MS = 5 * 60 * 1000;
export const DEFAULT_REPEATED_RED_SUPPRESSION_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_HTTP_USER_AGENT = "sovereign-ai-bots/project-sentinel";
export const MAX_SEEN_SIGNALS = 5000;
export const MAX_STORED_SIGNALS = 1000;
export const MAX_STORED_FEEDBACK = 500;
export const MAX_PENDING_AMBER = 200;
export const ZERO_TIME_ISO = "1970-01-01T00:00:00.000Z";
export const DEFAULT_GITHUB_TOKEN_ENV = "GITHUB_TOKEN";
export const FEEDBACK_HINT =
  "Reply with 'More of this', 'Less of this', 'Always alert', 'Digest only', or 'Not relevant'.";

export const ROUTE_ORDER: Record<SentinelRoute, number> = {
  gray: 0,
  amber: 1,
  red: 2,
};

export const LANE_LABELS: Record<SentinelLane, string> = {
  matrix: "Matrix",
  openclaw: "OpenClaw",
  mail_stack: "Mail Stack",
  ops_security: "Ops / Security",
  local_first_ai: "Local-First AI",
};
