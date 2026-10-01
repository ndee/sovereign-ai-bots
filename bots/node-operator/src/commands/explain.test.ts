import { describe, expect, it, vi } from "vitest";

import type { NodeCliResult } from "../node-cli.js";
import { explainCode, formatExplainResult, normalizeSanCode } from "./explain.js";

vi.mock("../node-cli.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../node-cli.js")>();
  return {
    ...original,
    runNodeCli: vi.fn(async (): Promise<NodeCliResult> => ({ ok: false, reason: "cli-not-found" })),
  };
});

const definition = {
  id: "SAN-LLM-001",
  title: "Classification degraded — semantic reviewer unavailable",
  explanation:
    "Mail is still being retrieved, but the semantic reviewer is unavailable, so alert quality may be reduced.",
  likelyCause: "The classification provider key is invalid or out of credit.",
  userAction: "Check the provider key on the Node Status page.",
  retryable: true,
  severity: "degraded",
};

const envelope = (result: unknown): string => JSON.stringify({ ok: true, result });

describe("normalizeSanCode", () => {
  it("accepts valid codes with whitespace and lowercase", () => {
    expect(normalizeSanCode(" san-llm-001 ")).toBe("SAN-LLM-001");
    expect(normalizeSanCode("SAN-MATRIX-003")).toBe("SAN-MATRIX-003");
  });

  it("rejects malformed, injected and missing input", () => {
    for (const input of [
      undefined,
      "",
      "LLM-001",
      "SAN-LLM-1",
      "SAN-LLM-0001",
      "SAN--001",
      "SAN-LLM-001; rm -rf /",
      "SAN-LLM-001 --json",
      "$(reboot)",
      "SAN-VERYLONGCOMPONENT-001",
    ]) {
      expect(normalizeSanCode(input)).toBeUndefined();
    }
  });
});

describe("explainCode", () => {
  it("validates the code before executing anything", async () => {
    const run = vi.fn();
    const result = await explainCode("nonsense", run as never);
    expect(result).toEqual({ kind: "invalid-input" });
    expect(run).not.toHaveBeenCalled();
  });

  it("passes only the normalised code to the CLI", async () => {
    const run = vi.fn(
      async (): Promise<NodeCliResult> => ({
        ok: true,
        stdout: envelope({ id: "SAN-LLM-001", known: true, definition }),
      }),
    );
    const result = await explainCode(" san-llm-001 ", run);
    expect(run).toHaveBeenCalledWith(["explain", "SAN-LLM-001", "--json"]);
    expect(result.kind).toBe("explained");
  });

  it("reports unknown codes distinctly", async () => {
    const result = await explainCode("SAN-ZZZ-999", async () => ({
      ok: true,
      stdout: envelope({ id: "SAN-ZZZ-999", known: false }),
    }));
    expect(result).toEqual({ kind: "unknown-code", code: "SAN-ZZZ-999" });
  });

  it("degrades to unavailable on exec failure or malformed output", async () => {
    expect(
      await explainCode("SAN-LLM-001", async () => ({ ok: false, reason: "exec-failed" })),
    ).toEqual({ kind: "unavailable" });
    expect(await explainCode("SAN-LLM-001", async () => ({ ok: true, stdout: "junk" }))).toEqual({
      kind: "unavailable",
    });
    // Over-bound definition fields are rejected, not relayed.
    expect(
      await explainCode("SAN-LLM-001", async () => ({
        ok: true,
        stdout: envelope({
          id: "SAN-LLM-001",
          known: true,
          definition: { ...definition, explanation: "x".repeat(5000) },
        }),
      })),
    ).toEqual({ kind: "unavailable" });
  });

  it("uses the real runner by default and degrades safely when no CLI exists", async () => {
    expect(await explainCode("SAN-LLM-001")).toEqual({ kind: "unavailable" });
  });
});

describe("formatExplainResult", () => {
  it("renders a known definition with practical guidance", () => {
    const text = formatExplainResult({ kind: "explained", definition: definition as never });
    expect(text).toContain("SAN-LLM-001 — Classification degraded — semantic reviewer unavailable");
    expect(text).toContain(
      "Likely cause: The classification provider key is invalid or out of credit.",
    );
    expect(text).toContain("What you can do: Check the provider key on the Node Status page.");
    expect(text).toContain("Safe to retry: yes");
    expect(text).toContain("Open Node Status");
  });

  it("renders retryable: no honestly", () => {
    const text = formatExplainResult({
      kind: "explained",
      definition: { ...definition, retryable: false } as never,
    });
    expect(text).toContain("Safe to retry: no");
  });

  it("names only validated codes in the unknown-code message", () => {
    const text = formatExplainResult({ kind: "unknown-code", code: "SAN-ZZZ-999" });
    expect(text).toContain("SAN-ZZZ-999");
    expect(text).toContain("Open Node Status");
  });

  it("never echoes invalid input", () => {
    const text = formatExplainResult({ kind: "invalid-input" });
    expect(text).toContain("Codes look like SAN-LLM-001");
    expect(text).not.toContain("$(");
  });

  it("renders a calm fallback when the registry is unreachable", () => {
    const text = formatExplainResult({ kind: "unavailable" });
    expect(text).toContain("could not look that code up");
  });
});
