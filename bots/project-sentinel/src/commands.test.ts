import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptySourcesDocument } from "./sources.js";
import { createDefaultState, createDefaultUserPolicy } from "./state.js";
import type { ProjectSentinelState, SourceConfigDocument, UserPolicy } from "./types.js";

const runtimeHolder = vi.hoisted(() => ({ current: null as FakeRuntime | null }));

vi.mock("./config/runtime.js", () => ({
  resolveToolRuntime: vi.fn(async () => {
    if (runtimeHolder.current === null) {
      throw new Error("No fake runtime configured");
    }
    return runtimeHolder.current;
  }),
}));

const { applyFeedback, digest, scan, sources, status } = await import("./commands.js");

class FakeRuntime {
  instanceId = "project-sentinel-core";
  digestInterval = "1h";
  statePath: string;
  state: ProjectSentinelState = createDefaultState();
  policy: UserPolicy = createDefaultUserPolicy();
  sources: SourceConfigDocument = createEmptySourcesDocument();
  messages: string[] = [];

  constructor(root: string) {
    this.statePath = join(root, "state.json");
  }

  async readState(): Promise<ProjectSentinelState> {
    return structuredClone(this.state);
  }

  async writeState(next: ProjectSentinelState): Promise<void> {
    this.state = structuredClone(next);
  }

  async readPolicy(): Promise<UserPolicy> {
    return structuredClone(this.policy);
  }

  async writePolicy(next: UserPolicy): Promise<void> {
    this.policy = structuredClone(next);
  }

  async readSources(): Promise<SourceConfigDocument> {
    return structuredClone(this.sources);
  }

  async writeSources(next: SourceConfigDocument): Promise<void> {
    this.sources = structuredClone(next);
  }

  async sendMatrixRoomMessage(text: string): Promise<void> {
    this.messages.push(text);
  }
}

const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><item><title>Ubuntu kernel security release</title><link>https://ubuntu.com/security/notices/USN-1</link><description>Security update for relay and kernel CVEs.</description><guid>https://ubuntu.com/security/notices/USN-1</guid><pubDate>Fri, 17 Apr 2026 10:28:32 +0000</pubDate></item></channel></rss>`;

const sourcesDocument = (): SourceConfigDocument => ({
  version: 1,
  profiles: [
    {
      id: "sovereign-ai-node",
      name: "Sovereign AI Node",
      enabled: true,
      lanePriorities: {
        openclaw: 5,
        ops_security: 4,
      },
      keywords: ["openclaw", "security", "relay"],
      repoNames: ["openclaw/openclaw"],
      organizations: ["openclaw"],
      sourceAllowlist: ["ubuntu-security", "openclaw-issues"],
      sourceBlocklist: [],
      alerting: {
        redThreshold: 20,
        amberThreshold: 8,
        digestInterval: "1h",
      },
    },
  ],
  sources: [
    {
      id: "ubuntu-security",
      name: "Ubuntu Security Notices",
      type: "rss",
      enabled: true,
      trustTier: "official",
      lanes: ["ops_security"],
      url: "https://ubuntu.com/security/notices/rss.xml",
      maxItems: 4,
    },
    {
      id: "openclaw-issues",
      name: "OpenClaw Issues",
      type: "github_issues",
      enabled: true,
      trustTier: "community_high_signal",
      lanes: ["openclaw"],
      owner: "openclaw",
      repo: "openclaw",
      state: "open",
      maxItems: 4,
    },
  ],
});

describe("project-sentinel/commands", () => {
  let tempDir: string;
  let runtime: FakeRuntime;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "project-sentinel-commands-"));
    runtime = new FakeRuntime(tempDir);
    runtimeHolder.current = runtime;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "https://ubuntu.com/security/notices/rss.xml") {
          return new Response(rssXml, { status: 200 });
        }
        return Response.json([
          {
            id: 2,
            number: 42,
            title: "OpenClaw adapter discussion",
            html_url: "https://github.com/openclaw/openclaw/issues/42",
            body: "Potential plugin gateway change.",
            created_at: "2026-04-17T10:00:00Z",
            updated_at: "2026-04-17T11:00:00Z",
            labels: [{ name: "discussion" }],
          },
        ]);
      }),
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("reports unconfigured state when no active profiles or sources exist", async () => {
    runtime.sources = createEmptySourcesDocument();
    await expect(scan({ instance: "project-sentinel-core" })).resolves.toEqual(
      expect.objectContaining({
        configured: false,
        note: "No active Project Sentinel project profiles are enabled.",
      }),
    );

    runtime.sources = sourcesDocument();
    runtime.sources.sources = runtime.sources.sources.map((source) => ({
      ...source,
      enabled: false,
    }));
    await expect(scan({ instance: "project-sentinel-core" })).resolves.toEqual(
      expect.objectContaining({
        configured: false,
        note: "No Project Sentinel sources are enabled.",
      }),
    );
  });

  it("routes red and amber signals, dedupes repeats, and flushes digests when due", async () => {
    vi.useFakeTimers();
    runtime.sources = sourcesDocument();
    vi.setSystemTime(new Date("2026-04-19T10:00:00.000Z"));
    const first = await scan({ instance: "project-sentinel-core" });
    expect(first).toEqual(
      expect.objectContaining({
        configured: true,
        processedSources: 2,
        newSignals: 2,
        redAlertsSent: 1,
        amberQueued: 1,
        digestsSent: 0,
      }),
    );
    expect(runtime.messages).toHaveLength(1);
    expect(runtime.messages[0]).toContain("Project Sentinel Alert");
    expect(runtime.state.digestQueue).toHaveLength(1);

    vi.setSystemTime(new Date("2026-04-19T10:30:00.000Z"));
    const notDue = await scan({ instance: "project-sentinel-core" });
    expect(notDue.newSignals).toBe(0);
    expect(notDue.digestsSent).toBe(0);

    vi.setSystemTime(new Date("2026-04-19T12:05:00.000Z"));
    const second = await scan({ instance: "project-sentinel-core" });
    expect(second.newSignals).toBe(0);
    expect(second.digestsSent).toBe(1);
    expect(runtime.messages).toHaveLength(2);
    expect(runtime.messages[1]).toContain("Project Sentinel Digest");
    expect(runtime.state.digestQueue).toHaveLength(0);
  });

  it("handles warning-only sources, gray signals, and fatal scan failures", async () => {
    runtime.sources = {
      version: 1,
      profiles: sourcesDocument().profiles,
      sources: [
        {
          id: "openclaw-discussions",
          name: "OpenClaw Discussions",
          type: "github_discussions",
          enabled: true,
          trustTier: "community_high_signal",
          lanes: ["openclaw"],
          owner: "openclaw",
          repo: "openclaw",
          githubTokenEnv: "GITHUB_TOKEN",
        },
        {
          id: "low-feed",
          name: "Low Feed",
          type: "rss",
          enabled: true,
          trustTier: "low",
          lanes: ["local_first_ai"],
          url: "https://low.example/feed.xml",
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "https://low.example/feed.xml") {
          return new Response(
            "<rss><channel><item><title>General commentary</title><link>https://low.example/post</link><description>Broad ecosystem chatter.</description></item></channel></rss>",
            { status: 200 },
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      }),
    );
    const warningResult = await scan({ instance: "project-sentinel-core" });
    expect(warningResult.note).toBe(
      "Skipped openclaw-discussions: GitHub discussions require GITHUB_TOKEN.",
    );
    expect(warningResult.alerts).toHaveLength(0);

    runtime.sources = {
      ...sourcesDocument(),
      sources: [sourcesDocument().sources[1] as (typeof runtime.sources.sources)[number]],
    };
    runtime.state.lastDigestAt = "2026-04-17T00:00:00.000Z";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json([
          {
            id: 2,
            number: 42,
            title: "OpenClaw adapter discussion",
            html_url: "https://github.com/openclaw/openclaw/issues/42",
            body: "Potential plugin gateway change.",
            created_at: "2026-04-17T10:00:00Z",
            updated_at: "2026-04-17T11:00:00Z",
            labels: [{ name: "discussion" }],
          },
        ]),
      ),
    );
    runtime.sendMatrixRoomMessage = vi.fn(async () => {
      throw new Error("matrix down");
    });
    await expect(scan({ instance: "project-sentinel-core" })).rejects.toThrow("matrix down");
    expect(runtime.state.lastError?.message).toBe("matrix down");
  });

  it("continues when one source fails", async () => {
    runtime.sources = sourcesDocument();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "https://ubuntu.com/security/notices/rss.xml") {
          throw new Error("network down");
        }
        return Response.json([
          {
            id: 2,
            number: 42,
            title: "OpenClaw adapter discussion",
            html_url: "https://github.com/openclaw/openclaw/issues/42",
            body: "Potential plugin gateway change.",
            created_at: "2026-04-17T10:00:00Z",
            updated_at: "2026-04-17T11:00:00Z",
            labels: [{ name: "discussion" }],
          },
        ]);
      }),
    );
    const result = await scan({ instance: "project-sentinel-core" });
    expect(result.note).toBe("Source ubuntu-security failed: network down");
    expect(result.processedSources).toBe(2);
  });

  it("returns status, digest queue contents, and source control results", async () => {
    runtime.sources = sourcesDocument();
    runtime.state.deliveredSignals.push({
      signalId: "sig-1",
      fingerprint: "fp-1",
      kind: "new-signal",
      route: "amber",
      lane: "openclaw",
      lanes: ["openclaw"],
      sourceId: "openclaw-issues",
      sourceName: "OpenClaw Issues",
      sourceType: "github_issues",
      trustTier: "community_high_signal",
      title: "Discussion",
      url: "https://github.com/openclaw/openclaw/issues/42",
      summary: "Summary",
      why: "Why",
      confidence: 65,
      score: 10,
      projectId: "sovereign-ai-node",
      publishedAt: "2026-04-17T10:00:00.000Z",
      updatedAt: "2026-04-17T10:00:00.000Z",
      sentAt: "2026-04-17T10:10:00.000Z",
    });
    runtime.state.digestQueue.push("sig-1");
    expect(await digest({ instance: "project-sentinel-core" })).toEqual({
      alerts: [expect.objectContaining({ signalId: "sig-1" })],
    });
    expect(await status({ instance: "project-sentinel-core" })).toEqual(
      expect.objectContaining({
        configured: true,
        activeProfiles: 1,
        enabledSources: 2,
        pendingAmber: 1,
      }),
    );
    expect(await sources({ instance: "project-sentinel-core" })).toEqual({
      sources: runtime.sources.sources
        .slice()
        .sort((left, right) => left.id.localeCompare(right.id)),
    });
    expect(
      await sources({
        instance: "project-sentinel-core",
        subcommand: "disable",
        id: "openclaw-issues",
      }),
    ).toEqual(
      expect.objectContaining({ note: "Project Sentinel source openclaw-issues disabled." }),
    );
    expect(
      await sources({
        instance: "project-sentinel-core",
        subcommand: "enable",
        id: "openclaw-issues",
      }),
    ).toEqual(
      expect.objectContaining({ note: "Project Sentinel source openclaw-issues enabled." }),
    );
    expect(
      await sources({ instance: "project-sentinel-core", subcommand: "enable", id: "missing" }),
    ).toEqual(expect.objectContaining({ note: "Project Sentinel source missing was not found." }));
    await expect(scan({ configPath: "/tmp/runtime.json5" })).rejects.toThrow(
      "Expected --instance <id>",
    );
    await expect(status({ configPath: "/tmp/runtime.json5" })).rejects.toThrow(
      "Expected --instance <id>",
    );
    await expect(digest({ configPath: "/tmp/runtime.json5" })).rejects.toThrow(
      "Expected --instance <id>",
    );
    await expect(sources({ configPath: "/tmp/runtime.json5" })).rejects.toThrow(
      "Expected --instance <id>",
    );
    await expect(
      sources({ instance: "project-sentinel-core", subcommand: "bogus", id: "x" }),
    ).rejects.toThrow("Expected a sources subcommand");
    await expect(
      sources({ instance: "project-sentinel-core", subcommand: "enable" }),
    ).rejects.toThrow("Expected --id <source-id>");
  });

  it("applies feedback by latest signal or explicit signal id", async () => {
    runtime.state.deliveredSignals.push({
      signalId: "sig-1",
      fingerprint: "fp-1",
      kind: "new-signal",
      route: "amber",
      lane: "openclaw",
      lanes: ["openclaw"],
      sourceId: "openclaw-issues",
      sourceName: "OpenClaw Issues",
      sourceType: "github_issues",
      trustTier: "community_high_signal",
      title: "Discussion",
      url: "https://github.com/openclaw/openclaw/issues/42",
      summary: "Summary",
      why: "Why",
      confidence: 65,
      score: 10,
      projectId: "sovereign-ai-node",
      publishedAt: "2026-04-17T10:00:00.000Z",
      updatedAt: "2026-04-17T10:00:00.000Z",
      sentAt: "2026-04-17T10:10:00.000Z",
    });
    runtime.state.digestQueue.push("sig-1");
    const latest = await applyFeedback({
      instance: "project-sentinel-core",
      latest: true,
      action: "not-relevant",
    });
    expect(latest.note).toBe("Policy updated locally. Similar signals suppressed.");
    expect(runtime.state.digestQueue).toHaveLength(0);
    expect(runtime.policy.mutedFingerprints).toEqual(["fp-1"]);

    const explicit = await applyFeedback({
      instance: "project-sentinel-core",
      signalId: "sig-1",
      action: "always-alert",
    });
    expect(explicit.note).toBe("Policy updated locally. Source pinned to immediate alerts.");
    expect(runtime.policy.sourceOverrides["openclaw-issues"]).toEqual({ minRoute: "red" });
    await expect(
      applyFeedback({
        instance: "project-sentinel-core",
        signalId: "missing",
        action: "always-alert",
      }),
    ).rejects.toThrow("No matching Project Sentinel signal was found");
    await expect(
      applyFeedback({ instance: "project-sentinel-core", action: "always-alert" }),
    ).rejects.toThrow("No matching Project Sentinel signal was found");
    await expect(
      applyFeedback({ instance: "project-sentinel-core", signalId: "sig-1", action: "bogus" }),
    ).rejects.toThrow(
      "Expected --action <more-like-this|less-like-this|always-alert|digest-only|not-relevant>",
    );
    await expect(
      applyFeedback({ configPath: "/tmp/runtime.json5", latest: true, action: "always-alert" }),
    ).rejects.toThrow("Expected --instance <id>");
  });

  it("handles updated signals, string source failures, and sparse status output", async () => {
    vi.useFakeTimers();
    runtime.sources = {
      ...sourcesDocument(),
      sources: [sourcesDocument().sources[1] as (typeof runtime.sources.sources)[number]],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json([
          {
            id: 2,
            number: 42,
            title: "OpenClaw adapter discussion",
            html_url: "https://github.com/openclaw/openclaw/issues/42",
            body: "Potential plugin gateway change.",
            created_at: "2026-04-17T10:00:00Z",
            updated_at: "2026-04-17T11:00:00Z",
            labels: [{ name: "discussion" }],
          },
        ]),
      ),
    );
    vi.setSystemTime(new Date("2026-04-19T10:00:00.000Z"));
    await scan({ instance: "project-sentinel-core" });
    runtime.state.lastDigestAt = undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw "string-fetch-failure";
      }),
    );
    const result = await scan({ instance: "project-sentinel-core" });
    expect(result.note).toBe("Source openclaw-issues failed: string-fetch-failure");

    runtime.state.lastScanAt = undefined;
    runtime.state.lastAlertAt = undefined;
    runtime.state.lastError = undefined;
    expect(await status({ instance: "project-sentinel-core" })).toEqual(
      expect.objectContaining({ configured: true, pendingAmber: 1 }),
    );

    runtime.state.lastScanAt = "2026-04-19T10:00:00.000Z";
    runtime.state.lastAlertAt = "2026-04-19T10:05:00.000Z";
    runtime.state.lastError = { code: "ERR", message: "boom", retryable: false };
    expect(await status({ instance: "project-sentinel-core" })).toEqual(
      expect.objectContaining({
        lastScanAt: "2026-04-19T10:00:00.000Z",
        lastAlertAt: "2026-04-19T10:05:00.000Z",
        lastError: "boom",
      }),
    );
    vi.useRealTimers();
  });

  it("marks changed fingerprints as updated signals", async () => {
    vi.useFakeTimers();
    runtime.sources = {
      ...sourcesDocument(),
      sources: [sourcesDocument().sources[1] as (typeof runtime.sources.sources)[number]],
    };
    let body = "Potential plugin gateway change.";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json([
          {
            id: 2,
            number: 42,
            title: "OpenClaw adapter discussion",
            html_url: "https://github.com/openclaw/openclaw/issues/42",
            body,
            created_at: "2026-04-17T10:00:00Z",
            updated_at: "2026-04-17T11:00:00Z",
            labels: [{ name: "discussion" }],
          },
        ]),
      ),
    );
    vi.setSystemTime(new Date("2026-04-19T10:00:00.000Z"));
    await scan({ instance: "project-sentinel-core" });
    const seen = runtime.state.seenSignals["openclaw-issues:issue:42"];
    expect(seen).toBeDefined();
    if (seen !== undefined) {
      seen.lastDigestAt = "2026-04-19T10:30:00.000Z";
    }
    body = "Potential plugin gateway change with breaking details.";
    vi.setSystemTime(new Date("2026-04-19T11:00:00.000Z"));
    const updated = await scan({ instance: "project-sentinel-core" });
    expect(updated.alerts[0]?.kind).toBe("updated-signal");
    vi.useRealTimers();
  });
});
