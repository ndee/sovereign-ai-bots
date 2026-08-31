/**
 * `status` and `health` — the partner-facing node health commands.
 *
 * Both render the product-safe presentation model produced by
 * `sovereign-node diagnostics --json` (built centrally in the core repo).
 * Rendering here re-validates the payload with a strict schema and echoes only
 * enum-derived words, schema-validated fixed sentences, SAN ids and
 * timestamps. Raw doctor output, stack traces, paths and credentials cannot
 * appear because they never enter the validated model.
 */

import { z } from "zod";

import { type NodeCliResult, type NodeCliRunner, runNodeCli } from "../node-cli.js";

/** Fixed argv for the diagnostics probe — the LLM cannot influence this. */
export const DIAGNOSTICS_ARGS = ["diagnostics", "--json"] as const;

const componentSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(64),
  status: z.enum(["healthy", "degraded", "failed", "unknown"]),
  lastSuccessAt: z.string().max(64).optional(),
  code: z
    .string()
    .regex(/^SAN-[A-Z]{2,12}-\d{3}$/u)
    .optional(),
  summary: z.string().min(1).max(300),
  action: z.string().min(1).max(300).optional(),
});

export const diagnosticsSchema = z.object({
  contractVersion: z.string().max(32).optional(),
  overall: z.enum(["healthy", "degraded", "action_required", "unavailable"]),
  checkedAt: z.string().max(64),
  headline: z.string().min(1).max(400),
  components: z.array(componentSchema).max(16),
});

/**
 * The diagnostics contract major this Node Operator build understands. A
 * missing, malformed, or different-major contractVersion is rejected as a
 * whole — no partial or permissive rendering of a model this build was not
 * written against.
 */
export const SUPPORTED_DIAGNOSTICS_CONTRACT_MAJOR = 2;

export const isSupportedContractVersion = (value: unknown): boolean => {
  if (typeof value !== "string") {
    return false;
  }
  const match = /^(\d+)\.\d+\.\d+$/u.exec(value.trim());
  if (match?.[1] === undefined) {
    return false;
  }
  return Number.parseInt(match[1], 10) === SUPPORTED_DIAGNOSTICS_CONTRACT_MAJOR;
};

export type Diagnostics = z.infer<typeof diagnosticsSchema>;

const envelopeSchema = z.object({ result: diagnosticsSchema });

export type StatusCommandResult =
  | { kind: "ok"; diagnostics: Diagnostics }
  | { kind: "incompatible" }
  | { kind: "unavailable" };

export const getDiagnostics = async (
  run: NodeCliRunner = runNodeCli,
): Promise<StatusCommandResult> => {
  const result: NodeCliResult = await run(DIAGNOSTICS_ARGS);
  if (!result.ok) {
    return { kind: "unavailable" };
  }
  try {
    const parsed = envelopeSchema.parse(JSON.parse(result.stdout));
    if (!isSupportedContractVersion(parsed.result.contractVersion)) {
      return { kind: "incompatible" };
    }
    return { kind: "ok", diagnostics: parsed.result };
  } catch {
    return { kind: "unavailable" };
  }
};

const OVERALL_WORDS: Record<Diagnostics["overall"], string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  action_required: "Action required",
  unavailable: "Unavailable",
};

const STATUS_WORDS: Record<Diagnostics["components"][number]["status"], string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  failed: "Failed",
  unknown: "Unknown",
};

const componentWord = (component: Diagnostics["components"][number]): string => {
  // Modules read better as Running than Healthy, and a provider that is
  // degraded or failed reads as Unavailable; keep the distinction small and
  // fixed.
  if (
    (component.id === "mail-sentinel" || component.id === "node-operator") &&
    component.status === "healthy"
  ) {
    return "Running";
  }
  if (
    component.id === "classification-provider" &&
    (component.status === "degraded" || component.status === "failed")
  ) {
    return "Unavailable";
  }
  return STATUS_WORDS[component.status];
};

export const INCOMPATIBLE_TEXT = [
  "Node diagnostics are incompatible with this Node Operator version.",
  "",
  "Apply the supported release combination, then ask again.",
].join("\n");

export const UNAVAILABLE_TEXT = [
  "I could not read the node's health right now.",
  "",
  "Open the Sovereign AI Node local interface and select Node Status, or try again in a minute.",
].join("\n");

const SEVERITY_RANK: Record<Diagnostics["components"][number]["status"], number> = {
  failed: 3,
  degraded: 2,
  unknown: 1,
  healthy: 0,
};

/**
 * `status` — the short answer: overall state, headline, and the single most
 * important non-healthy component with its code and next step. The full
 * component list is `health`'s job; keeping the two distinct means the quick
 * question gets a quick answer.
 */
export const formatStatus = (result: StatusCommandResult): string => {
  if (result.kind === "incompatible") {
    return INCOMPATIBLE_TEXT;
  }
  if (result.kind === "unavailable") {
    return UNAVAILABLE_TEXT;
  }
  const diagnostics = result.diagnostics;
  const lines = [`Node status: ${OVERALL_WORDS[diagnostics.overall]}`, ""];
  lines.push(diagnostics.headline);

  const worst = [...diagnostics.components].sort(
    (a, b) => SEVERITY_RANK[b.status] - SEVERITY_RANK[a.status],
  )[0];
  if (worst !== undefined && SEVERITY_RANK[worst.status] > 0) {
    lines.push("", `${worst.label}: ${componentWord(worst)} — ${worst.summary}`);
    if (worst.code !== undefined) {
      lines.push(`Code: ${worst.code}`);
    }
    if (worst.action !== undefined) {
      lines.push(`Next step: ${worst.action}`);
    }
  }

  lines.push("", "Ask for `health` for every component, or open Node Status for details.");
  return lines.join("\n");
};

/** Slightly deeper view: per-component summaries and next steps, still fixed text. */
export const formatHealth = (result: StatusCommandResult): string => {
  if (result.kind === "incompatible") {
    return INCOMPATIBLE_TEXT;
  }
  if (result.kind === "unavailable") {
    return UNAVAILABLE_TEXT;
  }
  const diagnostics = result.diagnostics;
  const lines = [`Node status: ${OVERALL_WORDS[diagnostics.overall]}`, ""];
  for (const component of diagnostics.components) {
    lines.push(`${component.label}: ${componentWord(component)}`);
    lines.push(`  ${component.summary}`);
    if (component.code !== undefined) {
      lines.push(`  Code: ${component.code}`);
    }
    if (component.action !== undefined) {
      lines.push(`  Next step: ${component.action}`);
    }
  }
  lines.push("", diagnostics.headline);
  return lines.join("\n");
};
