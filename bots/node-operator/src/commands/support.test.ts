import { describe, expect, it } from "vitest";

import { formatHelpResult, formatSupportResult } from "./support.js";

describe("formatSupportResult", () => {
  it("navigates to the local web interface without generating anything in chat", () => {
    const text = formatSupportResult();
    expect(text).toContain("Node Status");
    expect(text).toContain("local web interface");
    expect(text).toContain("never sent anywhere automatically");
  });

  it("contains no tokens, credentials, or query strings", () => {
    const text = formatSupportResult();
    expect(text).not.toMatch(/token/i);
    expect(text).not.toMatch(/password/i);
    expect(text).not.toContain("?");
    expect(text).not.toContain("Bearer");
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
