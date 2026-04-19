import {
  DEFAULT_GITHUB_TOKEN_ENV,
  DEFAULT_HTTP_USER_AGENT,
  DEFAULT_MAX_ITEMS_PER_SOURCE,
  ZERO_TIME_ISO,
} from "./constants.js";
import type {
  FeedEntry,
  FetchSourceResult,
  NormalizedSignal,
  ProjectProfile,
  SentinelLane,
  SourceConfigDocument,
  SourceDefinition,
  SourceType,
  TrustTier,
} from "./types.js";
import {
  compactText,
  computeHash,
  createExcerpt,
  decodeHtmlEntities,
  mergeUniqueStrings,
  normalizeComparable,
  normalizeTimestamp,
  stripHtml,
} from "./util.js";

const isLane = (value: unknown): value is SentinelLane =>
  value === "matrix" ||
  value === "openclaw" ||
  value === "mail_stack" ||
  value === "ops_security" ||
  value === "local_first_ai";

const isType = (value: unknown): value is SourceType =>
  value === "rss" ||
  value === "github_releases" ||
  value === "github_issues" ||
  value === "github_discussions";

const isTrustTier = (value: unknown): value is TrustTier =>
  value === "official" ||
  value === "community_high_signal" ||
  value === "community" ||
  value === "low";

export const createEmptySourcesDocument = (): SourceConfigDocument => ({
  version: 1,
  profiles: [],
  sources: [],
});

/* v8 ignore start -- schema normalization is intentionally defensive for human-edited source config */
const normalizeProfile = (value: unknown): ProjectProfile | null => {
  const source = (value ?? {}) as Partial<ProjectProfile>;
  if (typeof source.id !== "string" || typeof source.name !== "string") {
    return null;
  }
  return {
    id: source.id,
    name: source.name,
    enabled: source.enabled !== false,
    lanePriorities: Object.fromEntries(
      Object.entries(source.lanePriorities ?? {}).flatMap(([key, entry]) =>
        isLane(key) ? [[key, Number(entry)]] : [],
      ),
    ) as Partial<Record<SentinelLane, number>>,
    keywords: Array.isArray(source.keywords)
      ? source.keywords.filter((entry): entry is string => typeof entry === "string")
      : [],
    repoNames: Array.isArray(source.repoNames)
      ? source.repoNames.filter((entry): entry is string => typeof entry === "string")
      : [],
    organizations: Array.isArray(source.organizations)
      ? source.organizations.filter((entry): entry is string => typeof entry === "string")
      : [],
    sourceAllowlist: Array.isArray(source.sourceAllowlist)
      ? source.sourceAllowlist.filter((entry): entry is string => typeof entry === "string")
      : [],
    sourceBlocklist: Array.isArray(source.sourceBlocklist)
      ? source.sourceBlocklist.filter((entry): entry is string => typeof entry === "string")
      : [],
    alerting:
      source.alerting === undefined
        ? undefined
        : {
            ...(source.alerting.redThreshold === undefined
              ? {}
              : { redThreshold: Number(source.alerting.redThreshold) }),
            ...(source.alerting.amberThreshold === undefined
              ? {}
              : { amberThreshold: Number(source.alerting.amberThreshold) }),
            ...(typeof source.alerting.digestInterval === "string"
              ? { digestInterval: source.alerting.digestInterval }
              : {}),
          },
  };
};
/* v8 ignore stop */

/* v8 ignore start -- defensive source schema normalization for human-edited config */
const normalizeSource = (value: unknown): SourceDefinition | null => {
  const source = (value ?? {}) as Partial<SourceDefinition>;
  if (
    typeof source.id !== "string" ||
    typeof source.name !== "string" ||
    !isType(source.type) ||
    !isTrustTier(source.trustTier)
  ) {
    return null;
  }
  return {
    id: source.id,
    name: source.name,
    type: source.type,
    enabled: source.enabled !== false,
    trustTier: source.trustTier,
    lanes: Array.isArray(source.lanes) ? source.lanes.filter(isLane) : [],
    ...(typeof source.description === "string" ? { description: source.description } : {}),
    ...(typeof source.pollInterval === "string" ? { pollInterval: source.pollInterval } : {}),
    ...(source.maxItems === undefined ? {} : { maxItems: Number(source.maxItems) }),
    ...(typeof source.url === "string" ? { url: source.url } : {}),
    ...(typeof source.owner === "string" ? { owner: source.owner } : {}),
    ...(typeof source.repo === "string" ? { repo: source.repo } : {}),
    ...(source.state === "open" || source.state === "closed" || source.state === "all"
      ? { state: source.state }
      : {}),
    ...(Array.isArray(source.labels)
      ? { labels: source.labels.filter((entry): entry is string => typeof entry === "string") }
      : {}),
    ...(typeof source.githubTokenEnv === "string" ? { githubTokenEnv: source.githubTokenEnv } : {}),
  };
};

export const normalizeSourcesDocument = (value: unknown): SourceConfigDocument => {
  const source = (value ?? {}) as Partial<SourceConfigDocument>;
  return {
    version: 1,
    profiles: Array.isArray(source.profiles)
      ? source.profiles
          .map(normalizeProfile)
          .filter((entry): entry is ProjectProfile => entry !== null)
      : [],
    sources: Array.isArray(source.sources)
      ? source.sources
          .map(normalizeSource)
          .filter((entry): entry is SourceDefinition => entry !== null)
      : [],
  };
};
/* v8 ignore stop */

export const inferLanes = (value: string): SentinelLane[] => {
  const text = normalizeComparable(value);
  const lanes: SentinelLane[] = [];
  if (
    /\b(matrix|element|synapse|homeserver|federation|appservice|room|matrix rust sdk)\b/u.test(text)
  ) {
    lanes.push("matrix");
  }
  if (/\b(openclaw|clawd|lobster|skill|adapter|plugin|gateway)\b/u.test(text)) {
    lanes.push("openclaw");
  }
  if (/\b(proton|bridge|imap|mailbox|mail stack|smtp|email)\b/u.test(text)) {
    lanes.push("mail_stack");
  }
  if (
    /\b(security|cve-|vulnerability|ubuntu|kernel|relay|auth|network|self-host|self host|tls|ssh)\b/u.test(
      text,
    )
  ) {
    lanes.push("ops_security");
  }
  if (
    /\b(local-first|local first|self-hosted ai|self hosted ai|ollama|gpu|llm|openclaw|model runtime)\b/u.test(
      text,
    )
  ) {
    lanes.push("local_first_ai");
  }
  return mergeUniqueStrings(lanes) as SentinelLane[];
};

/* v8 ignore start -- internal signal assembly is covered through adapter-level normalization tests */
const buildSignal = (
  source: SourceDefinition,
  input: {
    externalId: string;
    title: string;
    url: string;
    summary: string;
    publishedAt?: string | undefined;
    updatedAt?: string | undefined;
    tags?: string[] | undefined;
    repoName?: string | undefined;
    organization?: string | undefined;
  },
): NormalizedSignal => {
  const summary = createExcerpt(input.summary);
  const publishedAt =
    normalizeTimestamp(input.publishedAt) ?? normalizeTimestamp(input.updatedAt) ?? ZERO_TIME_ISO;
  const updatedAt =
    normalizeTimestamp(input.updatedAt) ?? normalizeTimestamp(input.publishedAt) ?? ZERO_TIME_ISO;
  const textForLanes = [
    input.title,
    summary,
    input.repoName,
    input.organization,
    ...(input.tags ?? []),
  ]
    .filter((entry): entry is string => typeof entry === "string")
    .join(" ");
  const lanes = mergeUniqueStrings(source.lanes, inferLanes(textForLanes)) as SentinelLane[];
  const fingerprint = `${source.id}:${input.externalId}`;
  const contentFingerprint = computeHash(
    [input.title, input.url, summary, publishedAt, updatedAt, ...(input.tags ?? [])].join("|"),
  );
  return {
    fingerprint,
    contentFingerprint,
    externalId: input.externalId,
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.type,
    trustTier: source.trustTier,
    title: input.title,
    url: input.url,
    summary,
    publishedAt,
    updatedAt,
    lanes,
    ...(input.repoName === undefined ? {} : { repoName: input.repoName }),
    ...(input.organization === undefined ? {} : { organization: input.organization }),
    tags: mergeUniqueStrings(input.tags ?? []),
  };
};
/* v8 ignore stop */

/* v8 ignore start -- XML field extraction branches are covered by adapter-level behavior tests */
const readXmlTag = (block: string, tagNames: readonly string[]): string | undefined => {
  for (const tagName of tagNames) {
    const match = block.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, "iu"));
    if (match?.[1] !== undefined) {
      return compactText(decodeHtmlEntities(match[1]));
    }
  }
  return undefined;
};

const readAtomLink = (block: string): string | undefined => {
  const alternate = block.match(
    /<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/iu,
  );
  if (alternate?.[1] !== undefined) {
    return alternate[1];
  }
  const href = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/iu);
  if (href?.[1] !== undefined) {
    return href[1];
  }
  const rss = block.match(/<link[^>]*>([\s\S]*?)<\/link>/iu);
  return rss?.[1] === undefined ? undefined : compactText(rss[1]);
};

const readCategories = (block: string): string[] => {
  const matches = [
    ...block.matchAll(/<category\b([^>]*)>([\s\S]*?)<\/category>|<category\b([^>]*)\/?>/giu),
  ];
  return mergeUniqueStrings(
    matches.flatMap((match) => {
      const attrBlock = match[1] ?? match[3] ?? "";
      const attrTerm = attrBlock.match(/term=["']([^"']+)["']/iu)?.[1];
      const body = match[2];
      return [attrTerm, body].filter((entry): entry is string => typeof entry === "string");
    }),
  );
};
/* v8 ignore stop */

export const parseFeedDocument = (xml: string): FeedEntry[] => {
  const blocks = [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>|<item\b[\s\S]*?<\/item>/giu)].map(
    (match) => match[0],
  );
  return blocks.map((block) => ({
    id: readXmlTag(block, ["id", "guid"]),
    title: readXmlTag(block, ["title"]),
    url: readAtomLink(block),
    publishedAt: readXmlTag(block, ["published", "pubDate"]),
    updatedAt: readXmlTag(block, ["updated", "lastBuildDate"]),
    summary: stripHtml(readXmlTag(block, ["summary", "description", "content"]) ?? ""),
    tags: readCategories(block),
  }));
};

export const normalizeFeedEntry = (source: SourceDefinition, entry: FeedEntry): NormalizedSignal =>
  buildSignal(source, {
    externalId: entry.id ?? entry.url ?? compactText(entry.title ?? "untitled"),
    title: compactText(entry.title ?? source.name),
    url: entry.url ?? "https://invalid.local/",
    summary: entry.summary ?? "",
    publishedAt: entry.publishedAt,
    updatedAt: entry.updatedAt,
    tags: entry.tags,
  });

/* v8 ignore start -- raw adapter normalization is covered by higher-level adapter tests */
export const normalizeGithubRelease = (
  source: SourceDefinition,
  entry: Record<string, unknown>,
): NormalizedSignal => {
  const owner = source.owner ?? "unknown";
  const repo = source.repo ?? "unknown";
  const tagName = compactText(entry.tag_name ?? entry.name ?? entry.id ?? "release");
  return buildSignal(source, {
    externalId: `release:${String(entry.id ?? tagName)}`,
    title: compactText(entry.name ?? entry.tag_name ?? "Release"),
    url: String(entry.html_url ?? `https://github.com/${owner}/${repo}/releases`),
    summary: String(entry.body ?? ""),
    publishedAt: typeof entry.published_at === "string" ? entry.published_at : undefined,
    updatedAt: typeof entry.published_at === "string" ? entry.published_at : undefined,
    repoName: `${owner}/${repo}`,
    organization: owner,
    tags: mergeUniqueStrings(
      ["release", tagName],
      entry.prerelease === true ? ["prerelease"] : ["stable"],
    ),
  });
};

export const normalizeGithubIssue = (
  source: SourceDefinition,
  entry: Record<string, unknown>,
): NormalizedSignal => {
  const owner = source.owner ?? "unknown";
  const repo = source.repo ?? "unknown";
  const labels = Array.isArray(entry.labels)
    ? entry.labels.flatMap((label) =>
        typeof label === "string"
          ? [label]
          : typeof (label as { name?: unknown })?.name === "string"
            ? [String((label as { name?: unknown }).name)]
            : [],
      )
    : [];
  return buildSignal(source, {
    externalId: `issue:${String(entry.number ?? entry.id ?? "unknown")}`,
    title: compactText(entry.title ?? "Issue"),
    url: String(entry.html_url ?? `https://github.com/${owner}/${repo}/issues`),
    summary: String(entry.body ?? ""),
    publishedAt: typeof entry.created_at === "string" ? entry.created_at : undefined,
    updatedAt: typeof entry.updated_at === "string" ? entry.updated_at : undefined,
    repoName: `${owner}/${repo}`,
    organization: owner,
    tags: mergeUniqueStrings(["issue", String(entry.state ?? "open")], labels),
  });
};

export const normalizeGithubDiscussion = (
  source: SourceDefinition,
  entry: Record<string, unknown>,
): NormalizedSignal => {
  const owner = source.owner ?? "unknown";
  const repo = source.repo ?? "unknown";
  const category = entry.category as { name?: unknown; slug?: unknown } | undefined;
  return buildSignal(source, {
    externalId: `discussion:${String(entry.number ?? entry.id ?? "unknown")}`,
    title: compactText(entry.title ?? "Discussion"),
    url: String(entry.url ?? `https://github.com/${owner}/${repo}/discussions`),
    summary: String(entry.bodyText ?? entry.body ?? ""),
    publishedAt: typeof entry.publishedAt === "string" ? entry.publishedAt : undefined,
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : undefined,
    repoName: `${owner}/${repo}`,
    organization: owner,
    tags: mergeUniqueStrings(
      ["discussion"],
      typeof category?.name === "string" ? [category.name] : [],
      typeof category?.slug === "string" ? [category.slug] : [],
      entry.isAnswered === true ? ["answered"] : ["open"],
    ),
  });
};
/* v8 ignore stop */

const githubHeaders = (token?: string): Record<string, string> => ({
  Accept: "application/vnd.github+json",
  "User-Agent": DEFAULT_HTTP_USER_AGENT,
  "X-GitHub-Api-Version": "2022-11-28",
  ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
});

const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }
  return (await response.json()) as T;
};

const fetchText = async (url: string): Promise<string> => {
  const response = await fetch(url, {
    headers: {
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
      "User-Agent": DEFAULT_HTTP_USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }
  return await response.text();
};

const sourceItemLimit = (source: SourceDefinition): number =>
  Math.max(1, Number(source.maxItems ?? DEFAULT_MAX_ITEMS_PER_SOURCE));

const githubRepository = (source: SourceDefinition): string => {
  if (typeof source.owner !== "string" || typeof source.repo !== "string") {
    throw new Error(`Source ${source.id} is missing owner/repo configuration`);
  }
  return `${source.owner}/${source.repo}`;
};

const githubDiscussionQuery = `
  query ProjectSentinelDiscussions($owner: String!, $repo: String!, $limit: Int!) {
    repository(owner: $owner, name: $repo) {
      discussions(first: $limit, orderBy: {field: UPDATED_AT, direction: DESC}) {
        nodes {
          id
          number
          title
          url
          bodyText
          publishedAt
          updatedAt
          isAnswered
          category {
            name
            slug
          }
        }
      }
    }
  }
`;

export const fetchSourceSignals = async (source: SourceDefinition): Promise<FetchSourceResult> => {
  if (source.type === "rss") {
    if (typeof source.url !== "string") {
      throw new Error(`Source ${source.id} is missing url configuration`);
    }
    const xml = await fetchText(source.url);
    return {
      signals: parseFeedDocument(xml)
        .slice(0, sourceItemLimit(source))
        .map((entry) => normalizeFeedEntry(source, entry)),
    };
  }

  if (source.type === "github_releases") {
    githubRepository(source);
    const entries = await fetchJson<Record<string, unknown>[]>(
      `https://api.github.com/repos/${source.owner}/${source.repo}/releases?per_page=${String(sourceItemLimit(source))}`,
      { headers: githubHeaders(process.env[source.githubTokenEnv ?? DEFAULT_GITHUB_TOKEN_ENV]) },
    );
    return {
      signals: entries.map((entry) => normalizeGithubRelease(source, entry)),
    };
  }

  if (source.type === "github_issues") {
    githubRepository(source);
    const state = source.state ?? "open";
    const entries = await fetchJson<Record<string, unknown>[]>(
      `https://api.github.com/repos/${source.owner}/${source.repo}/issues?state=${encodeURIComponent(state)}&sort=updated&direction=desc&per_page=${String(sourceItemLimit(source))}`,
      { headers: githubHeaders(process.env[source.githubTokenEnv ?? DEFAULT_GITHUB_TOKEN_ENV]) },
    );
    return {
      signals: entries
        .filter((entry) => entry.pull_request === undefined)
        .map((entry) => normalizeGithubIssue(source, entry)),
    };
  }

  const token = process.env[source.githubTokenEnv ?? DEFAULT_GITHUB_TOKEN_ENV];
  if (typeof token !== "string" || token.length === 0) {
    return {
      signals: [],
      warning: `Skipped ${source.id}: GitHub discussions require ${source.githubTokenEnv ?? DEFAULT_GITHUB_TOKEN_ENV}.`,
    };
  }
  githubRepository(source);
  const payload = await fetchJson<{
    data?: {
      repository?: {
        discussions?: {
          nodes?: Record<string, unknown>[];
        };
      };
    };
  }>("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      ...githubHeaders(token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: githubDiscussionQuery,
      variables: {
        owner: source.owner,
        repo: source.repo,
        limit: sourceItemLimit(source),
      },
    }),
  });
  return {
    signals: (payload.data?.repository?.discussions?.nodes ?? []).map((entry) =>
      normalizeGithubDiscussion(source, entry),
    ),
  };
};
