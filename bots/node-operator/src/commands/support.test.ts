import { describe, expect, it } from "vitest";

import { buildNodeStatusUrl, formatHelpResult, formatSupportResult } from "./support.js";

describe("buildNodeStatusUrl", () => {
  it("CONSTRUCTS the URL from a bare trusted origin plus the fixed route", () => {
    expect(buildNodeStatusUrl("http://sovereign.local:8789")).toBe(
      "http://sovereign.local:8789/setup-ui/#/node-status",
    );
    expect(buildNodeStatusUrl("https://sovereign.local:8789/")).toBe(
      "https://sovereign.local:8789/setup-ui/#/node-status",
    );
  });

  it("rejects anything beyond scheme+host+port — the application owns the path", () => {
    for (const raw of [
      undefined,
      "",
      "not a url",
      "ftp://sovereign.local/",
      "javascript:alert(1)",
      "http://user:hunter2@sovereign.local:8789",
      "http://sovereign.local:8789/?token=syt_SECRET",
      "http://sovereign.local:8789/#session=abc",
      "http://sovereign.local:8789/some/path",
      "http://sovereign.local:8789/setup-ui/#/node-status",
      `http://sovereign.local/${"a".repeat(300)}`,
    ]) {
      expect(buildNodeStatusUrl(raw)).toBeUndefined();
    }
  });
});

describe("formatSupportResult", () => {
  it("navigates to the local web interface without generating anything in chat", () => {
    const text = formatSupportResult({});
    expect(text).toContain("Node Status");
    expect(text).toContain("local web interface");
    expect(text).toContain("never sent anywhere automatically");
  });

  it("includes a constructed Node Status URL only from a valid trusted origin", () => {
    const configured = formatSupportResult({
      SOVEREIGN_NODE_STATUS_ORIGIN: "http://sovereign.local:8789",
    });
    expect(configured).toContain("open http://sovereign.local:8789/setup-ui/#/node-status");

    const rejected = formatSupportResult({
      SOVEREIGN_NODE_STATUS_ORIGIN: "http://sovereign.local:8789/?token=syt_SECRET",
    });
    expect(rejected).not.toContain("syt_SECRET");
    expect(rejected).toContain("the same address you used during setup");
  });

  it("contains no tokens, credentials, or query strings by default", () => {
    const text = formatSupportResult({});
    expect(text).not.toMatch(/token/i);
    expect(text).not.toMatch(/password/i);
    expect(text).not.toContain("?");
    expect(text).not.toContain("Bearer");
  });

  it("uses the process environment by default without throwing", () => {
    expect(formatSupportResult()).toContain("Node Status");
  });
});

describe("formatHelpResult", () => {
  it("lists exactly the partner-facing commands", () => {
    const text = formatHelpResult();
    for (const command of ["status", "health", "explain <code>", "support", "version"]) {
      expect(text).toContain(command);
    }
  });

  it("exposes no founder or experimental commands", () => {
    const text = formatHelpResult();
    for (const forbidden of [
      "users",
      "invite",
      "remove",
      "agents",
      "onboarding",
      "doctor",
      "test-alert",
    ]) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
  });
});
