/**
 * `verify <nonce>` — the installer's challenge-response probe.
 *
 * The maintained installer proves the Matrix control plane works by sending
 * `verify <nonce>` (a cryptographically random hex challenge) as the
 * operator and requiring a NEWER message from this bot's account that echoes
 * the exact nonce. This command is that echo: deterministic, read-only, and
 * executing it end-to-end (Matrix → agent → allowlisted binary → reply) is
 * precisely what the check certifies.
 *
 * The nonce is strictly validated before use — free text that merely looks
 * like a verification request is never echoed back.
 */

export const NONCE_PATTERN = /^[a-f0-9]{16,64}$/u;

export type VerifyCommandResult = { kind: "confirmed"; nonce: string } | { kind: "invalid-nonce" };

export const verifyChallenge = (input: string | undefined): VerifyCommandResult => {
  if (typeof input !== "string") {
    return { kind: "invalid-nonce" };
  }
  const candidate = input.trim().toLowerCase();
  if (!NONCE_PATTERN.test(candidate)) {
    return { kind: "invalid-nonce" };
  }
  return { kind: "confirmed", nonce: candidate };
};

export const formatVerifyResult = (result: VerifyCommandResult): string => {
  if (result.kind === "confirmed") {
    return [
      `Verification ${result.nonce} confirmed.`,
      "Node Operator received the challenge and executed a command for it.",
    ].join("\n");
  }
  return [
    "That doesn't look like a verification challenge.",
    "",
    "This command is used by the node's own setup checks. For a health summary, ask for `status`.",
  ].join("\n");
};
