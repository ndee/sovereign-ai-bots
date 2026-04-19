export type SentinelLane = "matrix" | "openclaw" | "mail_stack" | "ops_security" | "local_first_ai";

export type TrustTier = "official" | "community_high_signal" | "community" | "low";

export type SourceType = "rss" | "github_releases" | "github_issues" | "github_discussions";

export type SentinelRoute = "gray" | "amber" | "red";

export type FeedbackAction =
  | "more-like-this"
  | "less-like-this"
  | "always-alert"
  | "digest-only"
  | "not-relevant";

export type SourcesSubcommand = "list" | "enable" | "disable";

export interface SourceDefinition {
  id: string;
  name: string;
  type: SourceType;
  enabled: boolean;
  trustTier: TrustTier;
  lanes: SentinelLane[];
  description?: string | undefined;
  pollInterval?: string | undefined;
  maxItems?: number | undefined;
  url?: string | undefined;
  owner?: string | undefined;
  repo?: string | undefined;
  state?: "open" | "closed" | "all" | undefined;
  labels?: string[] | undefined;
  githubTokenEnv?: string | undefined;
}

export interface ProjectProfile {
  id: string;
  name: string;
  enabled: boolean;
  lanePriorities: Partial<Record<SentinelLane, number>>;
  keywords: string[];
  repoNames: string[];
  organizations: string[];
  sourceAllowlist: string[];
  sourceBlocklist: string[];
  alerting?:
    | {
        redThreshold?: number | undefined;
        amberThreshold?: number | undefined;
        digestInterval?: string | undefined;
      }
    | undefined;
}

export interface SourceConfigDocument {
  version: number;
  profiles: ProjectProfile[];
  sources: SourceDefinition[];
}

export interface UserPolicy {
  version: number;
  sourceWeights: Record<string, number>;
  laneWeights: Record<SentinelLane, number>;
  sourceOverrides: Record<
    string,
    {
      minRoute?: SentinelRoute;
      maxRoute?: SentinelRoute;
    }
  >;
  mutedFingerprints: string[];
}

export interface NormalizedSignal {
  fingerprint: string;
  contentFingerprint: string;
  externalId: string;
  sourceId: string;
  sourceName: string;
  sourceType: SourceType;
  trustTier: TrustTier;
  title: string;
  url: string;
  summary: string;
  publishedAt: string;
  updatedAt: string;
  lanes: SentinelLane[];
  repoName?: string | undefined;
  organization?: string | undefined;
  tags: string[];
}

export interface SeenSignal {
  fingerprint: string;
  contentFingerprint: string;
  sourceId: string;
  title: string;
  url: string;
  publishedAt: string;
  updatedAt: string;
  lastSeenAt: string;
  lastRoute?: SentinelRoute | undefined;
  lastAlertAt?: string | undefined;
  lastDigestAt?: string | undefined;
}

export interface DeliveredSignal {
  signalId: string;
  fingerprint: string;
  kind: "new-signal" | "updated-signal";
  route: Exclude<SentinelRoute, "gray">;
  lane: SentinelLane;
  lanes: SentinelLane[];
  sourceId: string;
  sourceName: string;
  sourceType: SourceType;
  trustTier: TrustTier;
  title: string;
  url: string;
  summary: string;
  why: string;
  confidence: number;
  score: number;
  projectId: string;
  publishedAt: string;
  updatedAt: string;
  sentAt: string;
  digestSentAt?: string | undefined;
  feedbackState?: FeedbackAction | undefined;
  lastFeedbackAt?: string | undefined;
}

export interface FeedbackRecord {
  signalId: string;
  fingerprint: string;
  sourceId: string;
  lane: SentinelLane;
  action: FeedbackAction;
  at: string;
}

export interface SourceStatus {
  lastScanAt?: string | undefined;
  lastRedAt?: string | undefined;
  consecutiveFailures: number;
  lastError?: string | undefined;
}

export interface StateErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ProjectSentinelState {
  version: number;
  lastScanAt?: string | undefined;
  lastAlertAt?: string | undefined;
  lastDigestAt?: string | undefined;
  consecutiveFailures: number;
  lastError?: StateErrorInfo | undefined;
  seenSignals: Record<string, SeenSignal>;
  deliveredSignals: DeliveredSignal[];
  feedback: FeedbackRecord[];
  digestQueue: string[];
  sourceStatus: Record<string, SourceStatus>;
}

export interface FetchSourceResult {
  signals: NormalizedSignal[];
  warning?: string | undefined;
}

export interface FeedEntry {
  id?: string | undefined;
  title?: string | undefined;
  url?: string | undefined;
  publishedAt?: string | undefined;
  updatedAt?: string | undefined;
  summary?: string | undefined;
  tags: string[];
}

export interface RouteDecision {
  route: SentinelRoute;
  score: number;
  confidence: number;
  lane: SentinelLane;
  lanes: SentinelLane[];
  projectId: string;
  reasons: string[];
  why: string;
}

export interface CommandOptions {
  json: boolean;
  instance?: string | undefined;
  configPath?: string | undefined;
  subcommand?: string | undefined;
  signalId?: string | undefined;
  action?: FeedbackAction | string | undefined;
  id?: string | undefined;
  latest?: boolean | undefined;
}
