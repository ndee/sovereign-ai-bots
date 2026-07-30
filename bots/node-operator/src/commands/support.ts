/**
 * `support` and `help` — navigation text.
 *
 * `support` deliberately never generates a package, attaches a file, or
 * embeds any credential or token: support packages are created and reviewed
 * only in the authenticated local web interface, so nothing sensitive travels
 * through chat.
 *
 * A configured local Node Status URL may be included — but only after strict
 * validation: plain http(s), no userinfo, no query, no fragment, so a
 * session/bearer/activation token can never ride along. Anything that fails
 * validation degrades to the fixed navigation instructions.
 */

/** The one fixed application route. Never configurable, never dynamic. */
export const NODE_STATUS_PATH = "/setup-ui/#/node-status";

/**
 * CONSTRUCT the Node Status URL from a trusted ORIGIN only — the application
 * decides the path. The configured value may carry scheme, host, and port;
 * anything else (path, query, fragment, userinfo) disqualifies it entirely,
 * so no credential or token can ever ride along.
 */
export const buildNodeStatusUrl = (originRaw: string | undefined): string | undefined => {
  if (typeof originRaw !== "string" || originRaw.trim().length === 0 || originRaw.length > 200) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(originRaw.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return undefined;
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    return undefined;
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    return undefined;
  }
  return `${parsed.origin}${NODE_STATUS_PATH}`;
};

export const formatSupportResult = (
  env: Record<string, string | undefined> = process.env,
): string => {
  const configured = buildNodeStatusUrl(env.SOVEREIGN_NODE_STATUS_ORIGIN);
  const lines = [
    "Support tools live in the local web interface, so nothing sensitive goes through chat.",
    "",
  ];
  if (configured !== undefined) {
    lines.push(
      `1. On a device in your home network, open ${configured} in your browser.`,
      "2. Select Node Status if it isn't already open.",
    );
  } else {
    lines.push(
      "1. On a device in your home network, open the Sovereign AI Node interface in your browser — the same address you used during setup (for example http://sovereign.local:8789/).",
      "2. Select Node Status.",
    );
  }
  lines.push(
    "3. From there you can run diagnostics, create a support package on the device, review exactly what it contains, and download it.",
    "",
    "The support package is created locally and is never sent anywhere automatically.",
  );
  return lines.join("\n");
};

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
