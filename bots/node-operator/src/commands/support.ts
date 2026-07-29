/**
 * `support` and `help` — fixed navigation text.
 *
 * `support` deliberately never generates a package, attaches a file, or
 * embeds any credential or token: support packages are created and reviewed
 * only in the authenticated local web interface, so nothing sensitive travels
 * through chat. The text below is constant — there is nothing dynamic to leak.
 */

export const formatSupportResult = (): string =>
  [
    "Support tools live in the local web interface, so nothing sensitive goes through chat.",
    "",
    "1. On a device in your home network, open the Sovereign AI Node interface in your browser — the same address you used during setup (for example http://sovereign.local:8789/).",
    "2. Select Node Status.",
    "3. From there you can run diagnostics, create a support package on the device, review exactly what it contains, and download it.",
    "",
    "The support package is created locally and is never sent anywhere automatically.",
  ].join("\n");

/** Partner-facing commands only — no founder or experimental surface. */
export const formatHelpResult = (): string =>
  [
    "I can help with your Sovereign AI Node:",
    "",
    "status — a short summary of how the node is doing",
    "health — the same view with more detail per component",
    "explain <code> — what an error code like SAN-LLM-001 means and what to do",
    "support — how to run diagnostics and create a support package",
    "version — which Node Operator build is running",
    "",
    "Mention me with one of these, or just describe what you need.",
  ].join("\n");
