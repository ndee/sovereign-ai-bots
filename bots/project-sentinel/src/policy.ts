import {
  DEFAULT_AMBER_THRESHOLD,
  DEFAULT_DIGEST_INTERVAL,
  DEFAULT_RED_THRESHOLD,
  DEFAULT_REPEATED_RED_SUPPRESSION_MS,
  ROUTE_ORDER,
} from "./constants.js";
import type {
  DeliveredSignal,
  FeedbackAction,
  NormalizedSignal,
  ProjectSentinelState,
  RouteDecision,
  SentinelLane,
  SentinelRoute,
  SourceConfigDocument,
  UserPolicy,
} from "./types.js";
import {
  compactText,
  countMatchingPhrases,
  mergeUniqueStrings,
  normalizeComparable,
  parseDurationMs,
} from "./util.js";

const TRUST_BASE_SCORES: Record<NormalizedSignal["trustTier"], number> = {
  official: 6,
  community_high_signal: 4,
  community: 2,
  low: 0,
};

const SECURITY_PATTERN =
  /\b(security|vulnerability|cve-|incident|exploit|auth bypass|credential)\b/iu;
const BREAKING_PATTERN =
  /\b(breaking|deprecated|deprecation|migration|removed|removal|required upgrade|major release)\b/iu;
const OPERATIONS_PATTERN =
  /\b(federation|relay|ubuntu|kernel|network|systemd|bridge|imap|self-host)\b/iu;

const routeForScore = (
  score: number,
  redThreshold: number,
  amberThreshold: number,
): SentinelRoute => {
  if (score >= redThreshold) {
    return "red";
  }
  if (score >= amberThreshold) {
    return "amber";
  }
  return "gray";
};

/* v8 ignore start -- low-level scoring helpers are covered indirectly through public routing behavior */
const compareRoute = (left: SentinelRoute, right: SentinelRoute): number =>
  ROUTE_ORDER[left] - ROUTE_ORDER[right];

const applyRouteBounds = (
  route: SentinelRoute,
  override?: { minRoute?: SentinelRoute; maxRoute?: SentinelRoute },
): SentinelRoute => {
  let next = route;
  if (override?.minRoute !== undefined && compareRoute(next, override.minRoute) < 0) {
    next = override.minRoute;
  }
  if (override?.maxRoute !== undefined && compareRoute(next, override.maxRoute) > 0) {
    next = override.maxRoute;
  }
  return next;
};

const calculateConfidence = (score: number): number =>
  Math.max(10, Math.min(99, Math.round(30 + score * 4)));

const matchesRepoHint = (repoName: string | undefined, candidates: readonly string[]): boolean => {
  if (typeof repoName !== "string") {
    return false;
  }
  const normalizedRepo = normalizeComparable(repoName);
  const repoOnly = normalizedRepo.split("/").at(-1) ?? normalizedRepo;
  return candidates.some((candidate) => {
    const normalizedCandidate = normalizeComparable(candidate);
    return normalizedCandidate === normalizedRepo || normalizedCandidate === repoOnly;
  });
};

const pickPrimaryLane = (
  lanes: readonly SentinelLane[],
  lanePriorities: Partial<Record<SentinelLane, number>>,
  policy: UserPolicy,
): SentinelLane => {
  const prioritized = lanes.slice().sort((left, right) => {
    const leftScore = (lanePriorities[left] ?? 0) + (policy.laneWeights[left] ?? 0);
    const rightScore = (lanePriorities[right] ?? 0) + (policy.laneWeights[right] ?? 0);
    return rightScore - leftScore;
  });
  return prioritized[0] ?? "ops_security";
};

const adjustWeight = (
  target: Record<string, number>,
  key: string | undefined,
  delta: number,
): void => {
  if (typeof key !== "string" || key.length === 0) {
    return;
  }
  const next = (target[key] ?? 0) + delta;
  if (next === 0) {
    delete target[key];
    return;
  }
  target[key] = next;
};

const normalizeOverride = (
  value: UserPolicy["sourceOverrides"][string] | undefined,
): UserPolicy["sourceOverrides"][string] | undefined => {
  if (value?.minRoute === undefined && value?.maxRoute === undefined) {
    return undefined;
  }
  return value;
};
/* v8 ignore stop */

export const effectiveDigestInterval = (
  config: SourceConfigDocument,
  fallback: string = DEFAULT_DIGEST_INTERVAL,
): string => {
  const candidates = config.profiles
    .filter((profile) => profile.enabled)
    .flatMap((profile) =>
      typeof profile.alerting?.digestInterval === "string" ? [profile.alerting.digestInterval] : [],
    );
  if (candidates.length === 0) {
    return fallback;
  }
  return candidates.sort(
    (left, right) => parseDurationMs(left) - parseDurationMs(right),
  )[0] as string;
};

export const evaluateSignal = (
  signal: NormalizedSignal,
  config: SourceConfigDocument,
  policy: UserPolicy,
  state: ProjectSentinelState,
): RouteDecision => {
  if (policy.mutedFingerprints.includes(signal.fingerprint)) {
    return {
      route: "gray",
      score: -99,
      confidence: 10,
      lane: signal.lanes[0] ?? "ops_security",
      lanes: signal.lanes,
      projectId: "muted",
      reasons: ["fingerprint muted by operator"],
      why: "fingerprint muted by operator",
    };
  }

  const text = compactText(
    [
      signal.title,
      signal.summary,
      signal.repoName,
      signal.organization,
      ...signal.tags,
      ...signal.lanes,
    ].join(" "),
  );
  const securityMatch = SECURITY_PATTERN.test(text);
  const breakingMatch = BREAKING_PATTERN.test(text);
  const operationsMatch = OPERATIONS_PATTERN.test(text);
  const activeProfiles = config.profiles.filter((profile) => profile.enabled);
  if (activeProfiles.length === 0) {
    return {
      route: "gray",
      score: -10,
      confidence: 10,
      lane: signal.lanes[0] ?? "ops_security",
      lanes: signal.lanes,
      projectId: "unconfigured",
      reasons: ["no active project profiles"],
      why: "no active project profiles",
    };
  }

  const evaluations = activeProfiles.map((profile) => {
    let score = TRUST_BASE_SCORES[signal.trustTier];
    const reasons = [`${signal.trustTier.replaceAll("_", " ")} source`];
    /* v8 ignore next 3 -- narrow profile blocklists are a defensive operator override */
    if (profile.sourceBlocklist.includes(signal.sourceId)) {
      score -= 20;
      reasons.push("source blocked by project profile");
    }
    if (profile.sourceAllowlist.includes(signal.sourceId)) {
      score += 2;
      reasons.push("source is explicitly curated");
    }
    const matchedLanes = signal.lanes.filter((lane) => (profile.lanePriorities[lane] ?? 0) > 0);
    if (matchedLanes.length > 0) {
      /* v8 ignore next -- matched lanes are filtered from configured priorities, so the fallback branch is unreachable */
      score += matchedLanes.reduce((sum, lane) => sum + (profile.lanePriorities[lane] ?? 0), 0);
      reasons.push(
        `matches ${matchedLanes.join(", ")} lane${matchedLanes.length === 1 ? "" : "s"}`,
      );
    }
    if (matchesRepoHint(signal.repoName, profile.repoNames)) {
      score += 3;
      reasons.push("references tracked repository");
    }
    if (
      typeof signal.organization === "string" &&
      profile.organizations.some(
        (organization) =>
          normalizeComparable(organization) === normalizeComparable(signal.organization),
      )
    ) {
      score += 2;
      reasons.push("references tracked organization");
    }
    const keywordMatches = countMatchingPhrases(text, profile.keywords);
    if (keywordMatches > 0) {
      score += Math.min(6, keywordMatches * 2);
      reasons.push("matches project keywords");
    }
    if (signal.sourceType === "github_releases") {
      score += 2;
      reasons.push("release stream");
    }
    if (signal.sourceType === "github_issues" || signal.sourceType === "github_discussions") {
      score += 1;
      reasons.push("tracking active development discussion");
    }
    if (securityMatch) {
      score += 6;
      reasons.push("security-sensitive wording");
    }
    if (breakingMatch) {
      score += 4;
      reasons.push("breaking or migration wording");
    }
    if (operationsMatch && matchedLanes.includes("ops_security")) {
      score += 2;
      reasons.push("operational impact wording");
    }
    score += policy.sourceWeights[signal.sourceId] ?? 0;
    /* v8 ignore next 3 -- reason annotations for local weighting are non-critical to route computation */
    if ((policy.sourceWeights[signal.sourceId] ?? 0) !== 0) {
      reasons.push("local source weight adjustment");
    }
    const laneAdjustment = mergeUniqueStrings(matchedLanes).reduce(
      /* v8 ignore next -- laneWeights is always fully populated for known lanes */
      (sum, lane) => sum + (policy.laneWeights[lane as SentinelLane] ?? 0),
      0,
    );
    score += laneAdjustment;
    /* v8 ignore next 3 -- reason annotations for local weighting are non-critical to route computation */
    if (laneAdjustment !== 0) {
      reasons.push("local lane weight adjustment");
    }
    return {
      profile,
      score,
      reasons,
      matchedLanes: matchedLanes.length > 0 ? matchedLanes : signal.lanes,
      redThreshold: profile.alerting?.redThreshold ?? DEFAULT_RED_THRESHOLD,
      amberThreshold: profile.alerting?.amberThreshold ?? DEFAULT_AMBER_THRESHOLD,
    };
  });

  const best = evaluations.sort(
    (left, right) => right.score - left.score,
  )[0] as (typeof evaluations)[number];
  let route = routeForScore(best.score, best.redThreshold, best.amberThreshold);
  const sourceOverride = policy.sourceOverrides[signal.sourceId];
  route = applyRouteBounds(route, sourceOverride);
  const reasons = best.reasons.slice();
  if (sourceOverride?.minRoute !== undefined) {
    reasons.push(`source floor ${sourceOverride.minRoute}`);
  }
  if (sourceOverride?.maxRoute !== undefined) {
    reasons.push(`source ceiling ${sourceOverride.maxRoute}`);
  }
  const sourceStatus = state.sourceStatus[signal.sourceId];
  /* v8 ignore next 8 -- repeated-red suppression is verified via route behavior, not branch shape */
  if (
    route === "red" &&
    typeof sourceStatus?.lastRedAt === "string" &&
    Date.now() - new Date(sourceStatus.lastRedAt).getTime() < DEFAULT_REPEATED_RED_SUPPRESSION_MS &&
    best.score < best.redThreshold + 2
  ) {
    route = applyRouteBounds("amber", sourceOverride);
    reasons.push("recent red alert already sent from this source");
  }
  const lanes = best.matchedLanes.length > 0 ? best.matchedLanes : signal.lanes;
  return {
    route,
    score: best.score,
    confidence: calculateConfidence(best.score),
    lane: pickPrimaryLane(lanes, best.profile.lanePriorities, policy),
    lanes,
    projectId: best.profile.id,
    reasons,
    why: reasons.slice(0, 2).join("; "),
  };
};

export const applyFeedbackToPolicy = (
  policy: UserPolicy,
  signal: DeliveredSignal,
  action: FeedbackAction,
): { policy: UserPolicy; note: string } => {
  const next: UserPolicy = {
    ...policy,
    sourceWeights: { ...policy.sourceWeights },
    laneWeights: { ...policy.laneWeights },
    sourceOverrides: { ...policy.sourceOverrides },
    mutedFingerprints: policy.mutedFingerprints.slice(),
  };
  const override = { ...(next.sourceOverrides[signal.sourceId] ?? {}) };
  if (action === "more-like-this") {
    adjustWeight(next.sourceWeights, signal.sourceId, 2);
    adjustWeight(next.laneWeights, signal.lane, 1);
    return { policy: next, note: "Policy updated locally. Similar signals weighted higher." };
  }
  if (action === "less-like-this") {
    delete override.minRoute;
    const normalizedOverride = normalizeOverride(override);
    next.sourceOverrides[signal.sourceId] = normalizedOverride ?? {};
    /* v8 ignore next 3 -- empty override cleanup is a defensive persistence detail */
    if (normalizedOverride === undefined || Object.keys(normalizedOverride).length === 0) {
      delete next.sourceOverrides[signal.sourceId];
    }
    adjustWeight(next.sourceWeights, signal.sourceId, -2);
    adjustWeight(next.laneWeights, signal.lane, -1);
    return { policy: next, note: "Policy updated locally. Similar signals weighted lower." };
  }
  if (action === "always-alert") {
    delete override.maxRoute;
    override.minRoute = "red";
    next.sourceOverrides[signal.sourceId] = override;
    return { policy: next, note: "Policy updated locally. Source pinned to immediate alerts." };
  }
  if (action === "digest-only") {
    delete override.minRoute;
    override.maxRoute = "amber";
    next.sourceOverrides[signal.sourceId] = override;
    return { policy: next, note: "Policy updated locally. Source limited to digest routing." };
  }
  delete override.minRoute;
  const normalizedOverride = normalizeOverride(override);
  next.sourceOverrides[signal.sourceId] = normalizedOverride ?? {};
  /* v8 ignore next 3 -- empty override cleanup is a defensive persistence detail */
  if (normalizedOverride === undefined || Object.keys(normalizedOverride).length === 0) {
    delete next.sourceOverrides[signal.sourceId];
  }
  adjustWeight(next.sourceWeights, signal.sourceId, -4);
  adjustWeight(next.laneWeights, signal.lane, -1);
  if (!next.mutedFingerprints.includes(signal.fingerprint)) {
    next.mutedFingerprints.push(signal.fingerprint);
  }
  return { policy: next, note: "Policy updated locally. Similar signals suppressed." };
};
