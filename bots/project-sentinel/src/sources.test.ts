import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchSourceSignals,
  inferLanes,
  normalizeFeedEntry,
  normalizeGithubDiscussion,
  normalizeGithubIssue,
  normalizeGithubRelease,
  normalizeSourcesDocument,
  parseFeedDocument,
} from "./sources.js";
import type { SourceDefinition } from "./types.js";

const rssSource: SourceDefinition = {
  id: "matrix-blog",
  name: "Matrix.org Blog",
  type: "rss",
  enabled: true,
  trustTier: "official",
  lanes: ["matrix"],
  url: "https://matrix.org/atom.xml",
};

const githubReleaseSource: SourceDefinition = {
  id: "openclaw-releases",
  name: "OpenClaw Releases",
  type: "github_releases",
  enabled: true,
  trustTier: "official",
  lanes: ["openclaw", "local_first_ai"],
  owner: "openclaw",
  repo: "openclaw",
};

const githubIssueSource: SourceDefinition = {
  id: "openclaw-issues",
  name: "OpenClaw Issues",
  type: "github_issues",
  enabled: true,
  trustTier: "community_high_signal",
  lanes: ["openclaw"],
  owner: "openclaw",
  repo: "openclaw",
};

const githubDiscussionSource: SourceDefinition = {
  id: "openclaw-discussions",
  name: "OpenClaw Discussions",
  type: "github_discussions",
  enabled: true,
  trustTier: "community_high_signal",
  lanes: ["openclaw"],
  owner: "openclaw",
  repo: "openclaw",
  githubTokenEnv: "GITHUB_TOKEN",
};

const atomFeed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Matrix security update</title>
    <id>https://matrix.org/blog/security-update</id>
    <published>2026-04-17T18:22:01+00:00</published>
    <updated>2026-04-17T18:22:01+00:00</updated>
    <link rel="alternate" href="https://matrix.org/blog/security-update" />
    <summary>&lt;p&gt;Federation security and Synapse fixes.&lt;/p&gt;</summary>
    <category term="security" />
  </entry>
</feed>`;

describe("project-sentinel/sources", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GITHUB_TOKEN;
  });

  it("normalizes source config documents and lane hints", () => {
    expect(normalizeSourcesDocument({})).toEqual({ version: 1, profiles: [], sources: [] });
    expect(
      normalizeSourcesDocument({
        profiles: [
          {
            id: "one",
            name: "One",
            lanePriorities: { matrix: 4, bogus: 2 },
            keywords: ["matrix"],
            repoNames: ["matrix-org/synapse"],
            organizations: ["matrix-org"],
            sourceAllowlist: ["matrix-blog"],
            sourceBlocklist: [],
            alerting: { redThreshold: 10, amberThreshold: 4, digestInterval: "2h" },
          },
          {
            id: "partial",
            name: "Partial",
          },
          {
            bad: true,
          },
        ],
        sources: [
          {
            id: "matrix-blog",
            name: "Matrix Blog",
            type: "rss",
            enabled: true,
            trustTier: "official",
            lanes: ["matrix", "bogus"],
            description: "Curated feed",
            pollInterval: "30m",
            maxItems: 4,
            url: "https://matrix.org/atom.xml",
          },
          {
            id: "low-source",
            name: "Low Source",
            type: "github_issues",
            enabled: false,
            trustTier: "low",
            lanes: ["mail_stack"],
            owner: "owner",
            repo: "repo",
            state: "all",
            labels: ["mail"],
            githubTokenEnv: "TOKEN",
          },
          {
            id: "minimal-source",
            name: "Minimal Source",
            type: "rss",
            trustTier: "official",
            lanes: [],
          },
          {
            id: "bad",
            name: "Bad",
            type: "unknown",
            trustTier: "official",
            lanes: [],
          },
        ],
      }),
    ).toEqual({
      version: 1,
      profiles: [
        expect.objectContaining({
          id: "one",
          lanePriorities: { matrix: 4 },
          alerting: { redThreshold: 10, amberThreshold: 4, digestInterval: "2h" },
        }),
        expect.objectContaining({ id: "partial", keywords: [], repoNames: [], organizations: [] }),
      ],
      sources: [
        expect.objectContaining({
          id: "matrix-blog",
          lanes: ["matrix"],
        }),
        expect.objectContaining({
          id: "low-source",
          trustTier: "low",
          lanes: ["mail_stack"],
          owner: "owner",
          repo: "repo",
          state: "all",
          labels: ["mail"],
          githubTokenEnv: "TOKEN",
        }),
        expect.objectContaining({ id: "minimal-source", enabled: true, lanes: [] }),
      ],
    });
    expect(inferLanes("Matrix federation and OpenClaw gateway on Ubuntu")).toEqual([
      "matrix",
      "openclaw",
      "ops_security",
      "local_first_ai",
    ]);
    expect(inferLanes("Proton Bridge IMAP operations")).toContain("mail_stack");
  });

  it("parses and normalizes feed entries", () => {
    const entries = parseFeedDocument(atomFeed);
    expect(entries).toEqual([
      {
        id: "https://matrix.org/blog/security-update",
        title: "Matrix security update",
        url: "https://matrix.org/blog/security-update",
        publishedAt: "2026-04-17T18:22:01+00:00",
        updatedAt: "2026-04-17T18:22:01+00:00",
        summary: "Federation security and Synapse fixes.",
        tags: ["security"],
      },
    ]);
    expect(normalizeFeedEntry(rssSource, entries[0] as (typeof entries)[number])).toEqual(
      expect.objectContaining({
        sourceId: "matrix-blog",
        title: "Matrix security update",
        lanes: ["matrix", "ops_security"],
      }),
    );

    expect(
      parseFeedDocument(
        "<rss><channel><item><title>RSS item</title><link>https://example.com/post</link><description>Hello</description></item></channel></rss>",
      )[0],
    ).toEqual(
      expect.objectContaining({
        title: "RSS item",
        url: "https://example.com/post",
      }),
    );
    expect(
      parseFeedDocument(
        "<rss><channel><item><title>No summary</title><link>https://example.com/no-summary</link></item></channel></rss>",
      )[0],
    ).toEqual(
      expect.objectContaining({
        summary: "",
      }),
    );
  });

  it("normalizes GitHub releases, issues, and discussions", () => {
    expect(
      normalizeGithubRelease(githubReleaseSource, {
        id: 1,
        name: "OpenClaw v2.0.0",
        tag_name: "v2.0.0",
        html_url: "https://github.com/openclaw/openclaw/releases/tag/v2.0.0",
        body: "Breaking adapter changes.",
        published_at: "2026-04-17T10:00:00Z",
      }),
    ).toEqual(expect.objectContaining({ externalId: "release:1", sourceType: "github_releases" }));
    expect(
      normalizeGithubIssue(githubIssueSource, {
        id: 2,
        number: 42,
        title: "Plugin adapter regression",
        html_url: "https://github.com/openclaw/openclaw/issues/42",
        body: "Regression details",
        created_at: "2026-04-17T10:00:00Z",
        updated_at: "2026-04-17T11:00:00Z",
        labels: [{ name: "bug" }, { name: "adapter" }],
      }),
    ).toEqual(
      expect.objectContaining({
        externalId: "issue:42",
        tags: ["issue", "open", "bug", "adapter"],
      }),
    );
    expect(
      normalizeGithubDiscussion(githubDiscussionSource, {
        id: "disc-1",
        number: 7,
        title: "Gateway API changes",
        url: "https://github.com/openclaw/openclaw/discussions/7",
        bodyText: "Discussion body",
        publishedAt: "2026-04-17T10:00:00Z",
        updatedAt: "2026-04-17T11:00:00Z",
        isAnswered: true,
        category: { name: "Ideas", slug: "ideas" },
      }),
    ).toEqual(
      expect.objectContaining({
        externalId: "discussion:7",
        tags: ["discussion", "Ideas", "ideas", "answered"],
      }),
    );

    expect(normalizeFeedEntry(rssSource, { tags: [] })).toEqual(
      expect.objectContaining({
        externalId: "untitled",
        title: "Matrix.org Blog",
        url: "https://invalid.local/",
      }),
    );
    expect(
      normalizeGithubRelease({ ...githubReleaseSource, owner: undefined, repo: undefined }, {}),
    ).toEqual(
      expect.objectContaining({
        sourceType: "github_releases",
        url: "https://github.com/unknown/unknown/releases",
        tags: ["release", "stable"],
      }),
    );
    expect(normalizeGithubIssue(githubIssueSource, { labels: ["bug"] })).toEqual(
      expect.objectContaining({
        externalId: "issue:unknown",
        title: "Issue",
        tags: ["issue", "open", "bug"],
      }),
    );
    expect(normalizeGithubIssue(githubIssueSource, { labels: [{}] })).toEqual(
      expect.objectContaining({ tags: ["issue", "open"] }),
    );
    expect(normalizeGithubIssue(githubIssueSource, {})).toEqual(
      expect.objectContaining({ url: "https://github.com/openclaw/openclaw/issues" }),
    );
    expect(
      normalizeGithubDiscussion(
        { ...githubDiscussionSource, owner: undefined, repo: undefined },
        { body: "fallback", isAnswered: false },
      ),
    ).toEqual(
      expect.objectContaining({
        externalId: "discussion:unknown",
        title: "Discussion",
        url: "https://github.com/unknown/unknown/discussions",
        tags: ["discussion", "open"],
      }),
    );
  });

  it("fetches and normalizes each source adapter", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://matrix.org/atom.xml") {
        return new Response(atomFeed, { status: 200 });
      }
      if (url.includes("/releases?")) {
        return Response.json([
          {
            id: 1,
            name: "OpenClaw v2.0.0",
            tag_name: "v2.0.0",
            html_url: "https://github.com/openclaw/openclaw/releases/tag/v2.0.0",
            body: "Breaking adapter changes.",
            published_at: "2026-04-17T10:00:00Z",
          },
        ]);
      }
      if (url.includes("/issues?")) {
        return Response.json([
          {
            id: 2,
            number: 42,
            title: "Plugin adapter regression",
            html_url: "https://github.com/openclaw/openclaw/issues/42",
            body: "Regression details",
            created_at: "2026-04-17T10:00:00Z",
            updated_at: "2026-04-17T11:00:00Z",
            labels: [{ name: "bug" }],
          },
          {
            id: 3,
            pull_request: {},
          },
        ]);
      }
      return Response.json({
        data: {
          repository: {
            discussions: {
              nodes: [
                {
                  id: "disc-1",
                  number: 7,
                  title: "Gateway API changes",
                  url: "https://github.com/openclaw/openclaw/discussions/7",
                  bodyText: "Discussion body",
                  publishedAt: "2026-04-17T10:00:00Z",
                  updatedAt: "2026-04-17T11:00:00Z",
                  isAnswered: true,
                  category: { name: "Ideas", slug: "ideas" },
                },
              ],
            },
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.GITHUB_TOKEN = "token";

    expect((await fetchSourceSignals(rssSource)).signals[0]?.sourceType).toBe("rss");
    expect((await fetchSourceSignals(githubReleaseSource)).signals[0]?.sourceType).toBe(
      "github_releases",
    );
    expect((await fetchSourceSignals(githubIssueSource)).signals).toHaveLength(1);
    expect((await fetchSourceSignals(githubDiscussionSource)).signals[0]?.sourceType).toBe(
      "github_discussions",
    );
  });

  it("handles missing configuration and missing GitHub discussion token", async () => {
    await expect(fetchSourceSignals({ ...rssSource, url: undefined })).rejects.toThrow(
      "missing url configuration",
    );
    await expect(fetchSourceSignals({ ...githubReleaseSource, owner: undefined })).rejects.toThrow(
      "missing owner/repo configuration",
    );
    expect(await fetchSourceSignals(githubDiscussionSource)).toEqual({
      signals: [],
      warning: "Skipped openclaw-discussions: GitHub discussions require GITHUB_TOKEN.",
    });
    process.env.GITHUB_TOKEN = "";
    expect(await fetchSourceSignals(githubDiscussionSource)).toEqual({
      signals: [],
      warning: "Skipped openclaw-discussions: GitHub discussions require GITHUB_TOKEN.",
    });
    expect(
      await fetchSourceSignals({ ...githubDiscussionSource, githubTokenEnv: undefined }),
    ).toEqual({
      signals: [],
      warning: "Skipped openclaw-discussions: GitHub discussions require GITHUB_TOKEN.",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    await expect(fetchSourceSignals(rssSource)).rejects.toThrow(
      "HTTP 500 while fetching https://matrix.org/atom.xml",
    );
    await expect(fetchSourceSignals(githubReleaseSource)).rejects.toThrow(
      "HTTP 500 while fetching https://api.github.com/repos/openclaw/openclaw/releases?per_page=10",
    );

    process.env.GITHUB_TOKEN = "token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: {
            repository: {
              discussions: {},
            },
          },
        }),
      ),
    );
    expect(await fetchSourceSignals(githubDiscussionSource)).toEqual({ signals: [] });
  });
});
