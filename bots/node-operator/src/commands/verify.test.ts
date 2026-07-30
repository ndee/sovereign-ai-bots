import { describe, expect, it } from "vitest";

import { formatVerifyResult, NONCE_PATTERN, verifyChallenge } from "./verify.js";

describe("verifyChallenge", () => {
  it("confirms a well-formed hex nonce, normalising case and whitespace", () => {
    const nonce = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    expect(verifyChallenge(nonce)).toEqual({ kind: "confirmed", nonce });
    expect(verifyChallenge(`  ${nonce.toUpperCase()}  `)).toEqual({ kind: "confirmed", nonce });
  });

  it("rejects malformed, injected, and missing challenges", () => {
    for (const input of [
      undefined,
      "",
      "short",
      "xyz-not-hex-at-all-but-long-enough",
      "a1b2; rm -rf /",
      `${"a".repeat(65)}`,
      "$(reboot)",
      "verify a1b2c3d4e5f60718",
    ]) {
      expect(verifyChallenge(input)).toEqual({ kind: "invalid-nonce" });
    }
  });

  it("accepts the full produced range: 16 to 64 hex chars", () => {
    expect(verifyChallenge("a".repeat(16)).kind).toBe("confirmed");
    expect(verifyChallenge("0123456789abcdef".repeat(4)).kind).toBe("confirmed");
    expect(verifyChallenge("a".repeat(15)).kind).toBe("invalid-nonce");
    expect(NONCE_PATTERN.test("deadbeefdeadbeefdeadbeefdeadbeef")).toBe(true);
  });
});

describe("formatVerifyResult", () => {
  it("echoes the exact confirmed nonce", () => {
    const nonce = "deadbeefdeadbeefdeadbeefdeadbeef";
    const text = formatVerifyResult({ kind: "confirmed", nonce });
    expect(text).toContain(`Verification ${nonce} confirmed.`);
    expect(text).toContain("executed a command");
  });

  it("never echoes an invalid challenge", () => {
    const text = formatVerifyResult({ kind: "invalid-nonce" });
    expect(text).toContain("doesn't look like a verification challenge");
    expect(text).not.toContain("$(");
  });
});
