import { describe, expect, it, vi } from "vitest";

import {
  buildDigestMessage,
  buildRedAlertMessage,
  formatDigestResult,
  formatFeedbackResult,
  formatScanResult,
  formatSourcesResult,
  formatStatusResult,
  printOutput,
} from "./alerts.js";
import type { DeliveredSignal, SourceDefinition } from "./types.js";

const signal = (overrides: Partial<DeliveredSignal> = {}): DeliveredSignal => ({
  signalId: "sig-1",
  fingerprint: "fp-1",
  kind: "new-signal",
  route: "red",
  lane: "ops_security",
  lanes: ["ops_security"],
  sourceId: "ubuntu-security",
  sourceName: "Ubuntu Security Notices",
  sourceType: "rss",
  trustTier: "official",
  title: "Kernel vulnerability update",
  url: "https://ubuntu.com/security/notices/USN-1",
  summary: "A kernel update fixes multiple CVEs.",
  why: "official source; security-sensitive wording",
  confidence: 92,
  score: 18,
  projectId: "sovereign-ai-node",
  publishedAt: "2026-04-17T10:00:00.000Z",
  updatedAt: "2026-04-17T10:00:00.000Z",
  sentAt: "2026-04-17T10:10:00.000Z",
  ...overrides,
});

describe("project-sentinel/alerts", () => {
  it("builds red alert and digest messages", () => {
    expect(buildRedAlertMessage(signal())).toContain("Project Sentinel Alert [sig-1]");
    const digest = buildDigestMessage(
      Array.from({ length: 11 }, (_, index) =>
        signal({ signalId: `sig-${String(index)}`, route: "amber" }),
      ),
      "12h",
      "2026-04-18T00:00:00.000Z",
    );
    expect(digest).toContain("Project Sentinel Digest [");
    expect(digest).toContain("... and 1 more.");
  });

  it("formats command results", () => {
    expect(
      formatScanResult({
        configured: true,
        processedSources: 2,
        processedSignals: 3,
        newSignals: 2,
        redAlertsSent: 1,
        amberQueued: 1,
        digestsSent: 0,
        note: "Source failed: boom",
        alerts: [signal()],
      }),
    ).toContain("Project Sentinel scan: 2 source(s)");
    expect(
      formatScanResult({
        configured: false,
        processedSources: 0,
        processedSignals: 0,
        newSignals: 0,
        redAlertsSent: 0,
        amberQueued: 0,
        digestsSent: 0,
        alerts: [],
      }),
    ).toBe("Project Sentinel is not configured yet.");
    expect(
      formatScanResult({
        configured: false,
        processedSources: 0,
        processedSignals: 0,
        newSignals: 0,
        redAlertsSent: 0,
        amberQueued: 0,
        digestsSent: 0,
        note: "No active Project Sentinel project profiles are enabled.",
        alerts: [],
      }),
    ).toBe("No active Project Sentinel project profiles are enabled.");
    expect(formatDigestResult({ alerts: [] })).toBe(
      "No amber Project Sentinel signals are currently queued.",
    );
    expect(formatDigestResult({ alerts: [signal({ route: "amber" })] })).toContain(
      "Project Sentinel digest queue",
    );
    expect(formatFeedbackResult({ note: "Policy updated locally.", signalId: "sig-1" })).toBe(
      "Policy updated locally. Signal sig-1.",
    );
    expect(
      formatStatusResult({
        configured: false,
        activeProfiles: 0,
        enabledSources: 0,
        trackedSignals: 1,
        pendingAmber: 0,
        lastScanAt: "2026-04-18T00:00:00.000Z",
        lastAlertAt: "2026-04-18T01:00:00.000Z",
        lastError: "boom",
      }),
    ).toContain("Project Sentinel has no active profiles or enabled sources.");
  });

  it("formats source listings and output streams", () => {
    const sources: SourceDefinition[] = [
      {
        id: "ubuntu-security",
        name: "Ubuntu Security Notices",
        type: "rss",
        enabled: true,
        trustTier: "official",
        lanes: ["ops_security"],
      },
      {
        id: "openclaw-issues",
        name: "OpenClaw Issues",
        type: "github_issues",
        enabled: false,
        trustTier: "community_high_signal",
        lanes: ["openclaw"],
      },
    ];
    expect(formatSourcesResult({ sources })).toContain(
      "[ubuntu-security] enabled | rss | official | ops_security",
    );
    expect(formatSourcesResult({ sources })).toContain(
      "[openclaw-issues] disabled | github_issues | community_high_signal | openclaw",
    );
    expect(formatSourcesResult({ note: "Custom note", sources: [] })).toBe("Custom note\n- none");

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printOutput({ ok: true }, { json: true }, () => "ignored");
    printOutput({ ok: true }, { json: false }, () => "plain");
    expect(writeSpy).toHaveBeenNthCalledWith(1, '{\n  "ok": true\n}\n');
    expect(writeSpy).toHaveBeenNthCalledWith(2, "plain\n");
    writeSpy.mockRestore();
  });
});
