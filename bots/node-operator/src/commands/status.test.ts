import { describe, expect, it, vi } from "vitest";

import type { NodeCliResult } from "../node-cli.js";
import {
  DIAGNOSTICS_ARGS,
  type Diagnostics,
  formatHealth,
  formatStatus,
  getDiagnostics,
  INCOMPATIBLE_TEXT,
  isSupportedContractVersion,
  UNAVAILABLE_TEXT,
} from "./status.js";

vi.mock("../node-cli.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../node-cli.js")>();
  return {
    ...original,
    runNodeCli: vi.fn(async (): Promise<NodeCliResult> => ({ ok: false, reason: "cli-not-found" })),
  };
});

const degradedDiagnostics: Diagnostics = {
  contractVersion: "2.0.0",
  overall: "degraded",
  checkedAt: "2026-07-29T12:00:00.000Z",
  headline:
    "Mail is still being retrieved, but semantic classification is currently unavailable, so alert quality may be reduced.",
  components: [
    {
      id: "mailbox",
      label: "Mailbox",
      status: "healthy",
      summary: "Mail is being retrieved from the mailbox.",
    },
    {
      id: "matrix",
      label: "Matrix",
      status: "healthy",
      summary: "The Matrix homeserver is reachable and the alert room is available.",
    },
    {
      id: "mail-sentinel",
      label: "Mail Sentinel",
      status: "healthy",
      summary: "Mail Sentinel is running.",
    },
    {
      id: "classification-provider",
      label: "Semantic classification",
      status: "degraded",
      code: "SAN-LLM-001",
      summary: "Semantic classification is unavailable; alerts continue at reduced confidence.",
      action: "Check the classification provider key on the Node Status page, then retry.",
      lastSuccessAt: "2026-07-29T09:00:00.000Z",
    },
  ],
};

const envelope = (diagnostics: unknown): string =>
  JSON.stringify({ ok: true, command: "diagnostics", result: diagnostics });

describe("getDiagnostics", () => {
  it("parses and validates the CLI envelope", async () => {
    const run = vi.fn(
      async (): Promise<NodeCliResult> => ({
        ok: true,
        stdout: envelope(degradedDiagnostics),
      }),
    );
    const result = await getDiagnostics(run);
    expect(run).toHaveBeenCalledWith(DIAGNOSTICS_ARGS);
    expect(result).toEqual({ kind: "ok", diagnostics: degradedDiagnostics });
  });

  it("returns unavailable when the CLI cannot be executed", async () => {
    const result = await getDiagnostics(async () => ({ ok: false, reason: "exec-failed" }));
    expect(result).toEqual({ kind: "unavailable" });
  });

  it("returns unavailable on non-JSON output", async () => {
    const result = await getDiagnostics(async () => ({ ok: true, stdout: "not json" }));
    expect(result).toEqual({ kind: "unavailable" });
  });

  it("rejects payloads that fail schema validation instead of relaying them", async () => {
    const poisoned = {
      ...degradedDiagnostics,
      components: [
        {
          id: "mailbox",
          label: "Mailbox",
          status: "healthy",
          summary: "x".repeat(1000), // over bound — could smuggle arbitrary text
        },
      ],
    };
    const result = await getDiagnostics(async () => ({ ok: true, stdout: envelope(poisoned) }));
    expect(result).toEqual({ kind: "unavailable" });
  });

  it("uses the real runner by default and degrades safely when no CLI exists", async () => {
    const result = await getDiagnostics();
    expect(result).toEqual({ kind: "unavailable" });
  });
});

describe("formatStatus", () => {
  it("renders overall, headline, and only the most important degraded component", () => {
    const text = formatStatus({ kind: "ok", diagnostics: degradedDiagnostics });
    expect(text).toBe(
      [
        "Node status: Degraded",
        "",
        "Mail is still being retrieved, but semantic classification is currently unavailable, so alert quality may be reduced.",
        "",
        "Semantic classification: Unavailable — Semantic classification is unavailable; alerts continue at reduced confidence.",
        "Code: SAN-LLM-001",
        "Next step: Check the classification provider key on the Node Status page, then retry.",
        "",
        "Ask for `health` for every component, or open Node Status for details.",
      ].join("\n"),
    );
    // The healthy components do NOT appear — that detail is health's job.
    expect(text).not.toContain("Mailbox:");
    expect(text).not.toContain("Matrix:");
  });

  it("prefers a failed component over a degraded one", () => {
    const diagnostics: Diagnostics = {
      contractVersion: "2.0.0",
      overall: "action_required",
      checkedAt: "2026-07-29T12:00:00.000Z",
      headline: "One or more components need attention.",
      components: [
        {
          id: "classification-provider",
          label: "Semantic classification",
          status: "degraded",
          code: "SAN-LLM-001",
          summary: "s1",
        },
        {
          id: "mailbox",
          label: "Mailbox",
          status: "failed",
          code: "SAN-IMAP-001",
          summary: "s2",
          action: "a2",
        },
      ],
    };
    const text = formatStatus({ kind: "ok", diagnostics });
    expect(text).toContain("Mailbox: Failed — s2");
    expect(text).toContain("Code: SAN-IMAP-001");
    expect(text).not.toContain("Semantic classification");
  });

  it("renders a healthy node without any component lines", () => {
    const healthy: Diagnostics = {
      contractVersion: "2.0.0",
      overall: "healthy",
      checkedAt: "2026-07-29T12:00:00.000Z",
      headline: "All components are working normally.",
      components: [
        { id: "matrix", label: "Matrix", status: "healthy", summary: "s" },
        { id: "mailbox", label: "Mailbox", status: "healthy", summary: "s" },
      ],
    };
    const text = formatStatus({ kind: "ok", diagnostics: healthy });
    expect(text).toBe(
      [
        "Node status: Healthy",
        "",
        "All components are working normally.",
        "",
        "Ask for `health` for every component, or open Node Status for details.",
      ].join("\n"),
    );
  });

  it("renders the fixed unavailable text when diagnostics cannot be read", () => {
    expect(formatStatus({ kind: "unavailable" })).toBe(UNAVAILABLE_TEXT);
    expect(UNAVAILABLE_TEXT).not.toContain("/");
  });
});

describe("formatHealth", () => {
  it("adds per-component summaries, codes and next steps", () => {
    const text = formatHealth({ kind: "ok", diagnostics: degradedDiagnostics });
    expect(text).toContain("Semantic classification: Unavailable");
    expect(text).toContain(
      "  Semantic classification is unavailable; alerts continue at reduced confidence.",
    );
    expect(text).toContain("  Code: SAN-LLM-001");
    expect(text).toContain(
      "  Next step: Check the classification provider key on the Node Status page, then retry.",
    );
    // Healthy components carry a summary but no next step.
    expect(text).toContain("Mailbox: Healthy");
    expect(text).toContain("  Mail is being retrieved from the mailbox.");
  });

  it("renders the fixed unavailable text when diagnostics cannot be read", () => {
    expect(formatHealth({ kind: "unavailable" })).toBe(UNAVAILABLE_TEXT);
  });

  it("labels a FAILED classification provider as Unavailable too", () => {
    const diagnostics: Diagnostics = {
      contractVersion: "2.0.0",
      overall: "action_required",
      checkedAt: "2026-07-29T12:00:00.000Z",
      headline: "One or more components need attention.",
      components: [
        {
          id: "classification-provider",
          label: "Semantic classification",
          status: "failed",
          summary: "s",
        },
      ],
    };
    expect(formatHealth({ kind: "ok", diagnostics })).toContain(
      "Semantic classification: Unavailable",
    );
  });
});

describe("diagnostics contract compatibility", () => {
  const envelopeWith = (contractVersion: unknown): string =>
    JSON.stringify({
      ok: true,
      command: "diagnostics",
      result: {
        ...(contractVersion === undefined ? {} : { contractVersion }),
        overall: "healthy",
        checkedAt: "2026-07-30T12:00:00.000Z",
        headline: "All components are working normally.",
        components: [],
      },
    });

  it("accepts the current supported contract major", async () => {
    const result = await getDiagnostics(async () => ({ ok: true, stdout: envelopeWith("2.0.0") }));
    expect(result.kind).toBe("ok");
    expect(isSupportedContractVersion("2.9.3")).toBe(true);
  });

  it("rejects a missing contract version — no permissive rendering", async () => {
    const result = await getDiagnostics(async () => ({
      ok: true,
      stdout: envelopeWith(undefined),
    }));
    expect(result).toEqual({ kind: "incompatible" });
  });

  it("rejects a future unsupported major", async () => {
    const result = await getDiagnostics(async () => ({ ok: true, stdout: envelopeWith("3.0.0") }));
    expect(result).toEqual({ kind: "incompatible" });
  });

  it("rejects malformed versions", async () => {
    for (const version of ["", "two", "2", "2.0", "v2.0.0", "2.0.0-beta"]) {
      const result = await getDiagnostics(async () => ({
        ok: true,
        stdout: envelopeWith(version),
      }));
      expect(result).toEqual({ kind: "incompatible" });
    }
    expect(isSupportedContractVersion(42)).toBe(false);
  });

  it("renders the fixed compatibility action for both commands", () => {
    expect(formatStatus({ kind: "incompatible" })).toBe(INCOMPATIBLE_TEXT);
    expect(formatHealth({ kind: "incompatible" })).toBe(INCOMPATIBLE_TEXT);
    expect(INCOMPATIBLE_TEXT).toContain("Apply the supported release combination");
  });
});
