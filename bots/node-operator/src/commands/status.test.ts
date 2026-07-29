import { describe, expect, it, vi } from "vitest";

import type { NodeCliResult } from "../node-cli.js";
import {
  DIAGNOSTICS_ARGS,
  type Diagnostics,
  formatHealth,
  formatStatus,
  getDiagnostics,
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
  it("renders the concise partner summary with a deduplicated code line", () => {
    const text = formatStatus({ kind: "ok", diagnostics: degradedDiagnostics });
    expect(text).toBe(
      [
        "Node status: Degraded",
        "",
        "Mailbox: Healthy",
        "Matrix: Healthy",
        "Mail Sentinel: Running",
        "Semantic classification: Unavailable",
        "",
        "Mail is still being retrieved, but semantic classification is currently unavailable, so alert quality may be reduced.",
        "",
        "Code: SAN-LLM-001",
        "Open Node Status for details.",
      ].join("\n"),
    );
  });

  it("renders the fixed unavailable text when diagnostics cannot be read", () => {
    expect(formatStatus({ kind: "unavailable" })).toBe(UNAVAILABLE_TEXT);
    expect(UNAVAILABLE_TEXT).not.toContain("/");
  });

  it("omits the code line when nothing carries a code and handles empty components", () => {
    const healthy: Diagnostics = {
      overall: "healthy",
      checkedAt: "2026-07-29T12:00:00.000Z",
      headline: "All components are working normally.",
      components: [],
    };
    const text = formatStatus({ kind: "ok", diagnostics: healthy });
    expect(text).toBe(
      [
        "Node status: Healthy",
        "",
        "All components are working normally.",
        "Open Node Status for details.",
      ].join("\n"),
    );
  });

  it("labels a running node-operator as Running and an unknown provider as Unknown", () => {
    const diagnostics: Diagnostics = {
      overall: "healthy",
      checkedAt: "2026-07-29T12:00:00.000Z",
      headline: "All components are working normally.",
      components: [
        { id: "node-operator", label: "Node Operator", status: "healthy", summary: "s" },
        {
          id: "classification-provider",
          label: "Semantic classification",
          status: "unknown",
          summary: "s",
        },
        { id: "sovereign-ai-node", label: "Sovereign AI Node", status: "failed", summary: "s" },
        {
          id: "classification-provider",
          label: "Classification",
          status: "failed",
          summary: "s",
        },
      ],
    };
    const text = formatStatus({ kind: "ok", diagnostics });
    expect(text).toContain("Node Operator: Running");
    expect(text).toContain("Semantic classification: Unknown");
    expect(text).toContain("Sovereign AI Node: Failed");
    expect(text).toContain("Classification: Unavailable");
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
});
