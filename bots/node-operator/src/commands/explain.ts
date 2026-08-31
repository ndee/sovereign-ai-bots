/**
 * `explain <SAN-code>` — plain-language explanation of a Sovereign error code.
 *
 * The code is validated against the strict SAN shape BEFORE anything is
 * executed, and free text that fails validation is never echoed back into the
 * room — an unrecognisable input gets a fixed sentence, so chat input cannot
 * become CLI input or reflected output. Known codes come from the central SAN
 * registry via `sovereign-node explain <code> --json`; the definition fields
 * rendered here are re-validated and bounded.
 */

import { z } from "zod";

import { type NodeCliRunner, runNodeCli } from "../node-cli.js";

export const SAN_CODE_PATTERN = /^SAN-[A-Z]{2,12}-\d{3}$/u;

const definitionSchema = z.object({
  id: z.string().regex(SAN_CODE_PATTERN),
  title: z.string().min(1).max(200),
  explanation: z.string().min(1).max(1000),
  likelyCause: z.string().min(1).max(600),
  userAction: z.string().min(1).max(600),
  retryable: z.boolean(),
  severity: z.enum(["critical", "degraded", "warning"]),
});

const envelopeSchema = z.object({
  result: z.object({
    id: z.string().max(64),
    known: z.boolean(),
    definition: definitionSchema.optional(),
  }),
});

export type ExplainCommandResult =
  | { kind: "explained"; definition: z.infer<typeof definitionSchema> }
  | { kind: "unknown-code"; code: string }
  | { kind: "invalid-input" }
  | { kind: "unavailable" };

/**
 * Normalise operator input to a candidate code, or reject it.
 * Accepts surrounding whitespace and lowercase; nothing else.
 */
export const normalizeSanCode = (input: string | undefined): string | undefined => {
  if (typeof input !== "string") {
    return undefined;
  }
  const candidate = input.trim().toUpperCase();
  return SAN_CODE_PATTERN.test(candidate) ? candidate : undefined;
};

export const explainCode = async (
  input: string | undefined,
  run: NodeCliRunner = runNodeCli,
): Promise<ExplainCommandResult> => {
  const code = normalizeSanCode(input);
  if (code === undefined) {
    return { kind: "invalid-input" };
  }
  const result = await run(["explain", code, "--json"]);
  if (!result.ok) {
    return { kind: "unavailable" };
  }
  try {
    const parsed = envelopeSchema.parse(JSON.parse(result.stdout));
    if (!parsed.result.known || parsed.result.definition === undefined) {
      return { kind: "unknown-code", code };
    }
    return { kind: "explained", definition: parsed.result.definition };
  } catch {
    return { kind: "unavailable" };
  }
};

export const formatExplainResult = (result: ExplainCommandResult): string => {
  switch (result.kind) {
    case "explained": {
      const definition = result.definition;
      return [
        `${definition.id} — ${definition.title}`,
        "",
        definition.explanation,
        "",
        `Likely cause: ${definition.likelyCause}`,
        `What you can do: ${definition.userAction}`,
        `Safe to retry: ${definition.retryable ? "yes" : "no"}`,
        "",
        "Open Node Status for the current state of each component.",
      ].join("\n");
    }
    case "unknown-code":
      return [
        `I don't recognise the code ${result.code}.`,
        "",
        "It may come from a newer node version, or it may be mistyped.",
        "Open Node Status to see any active issues and their codes.",
      ].join("\n");
    case "invalid-input":
      return [
        "That doesn't look like a Sovereign error code.",
        "",
        "Codes look like SAN-LLM-001. You can find them on the Node Status page and in alert notices.",
      ].join("\n");
    default:
      return [
        "I could not look that code up right now.",
        "",
        "Open the Sovereign AI Node local interface and select Node Status, or try again in a minute.",
      ].join("\n");
  }
};
