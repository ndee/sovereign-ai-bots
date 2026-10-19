import { resolveToolRuntime } from "../config/runtime.js";
import { LEDGER_RETENTION_DAYS, OUTCOME_STATES } from "../ledger/ledger.js";
import {
  type DayReconciliation,
  type ReconcileReport,
  reconcileLedger,
} from "../ledger/reconcile.js";
import type { CommandOptions } from "../types.js";
import { clampLimit } from "../util/time.js";

/**
 * Balance the outcome ledger against the independent count, per day. Counts
 * and day flags only — no identifier, subject or sender — so the output can be
 * shared for support without exposing mail.
 */
export interface ReconcileCommandResult extends ReconcileReport {
  instanceId: string;
}

export const DEFAULT_RECONCILE_DAYS = 7;

export const reconcile = async (
  options: Pick<CommandOptions, "instance" | "configPath" | "limit">,
): Promise<ReconcileCommandResult> => {
  if (options.instance === undefined) {
    throw new Error("Expected --instance <id>");
  }
  const days =
    options.limit === undefined
      ? DEFAULT_RECONCILE_DAYS
      : clampLimit(options.limit, LEDGER_RETENTION_DAYS + 1);
  const runtime = await resolveToolRuntime(options.instance, options.configPath);
  const now = new Date();
  const ledger = await runtime.readLedger(now);
  return { instanceId: runtime.instanceId, ...reconcileLedger(ledger, now, { days }) };
};

const COVERAGE_TEXT: Record<ReconcileReport["inventory"]["status"], string> = {
  available: "Coverage: full (independent mailbox inventory).",
  unsupported:
    "Coverage: partial. The mail tool has no inventory command, so only mail the scan's search returned is counted.",
  failed: "Coverage: partial. The last mailbox inventory failed.",
  unknown: "Coverage: partial. No mailbox inventory has run yet.",
};

type EquationParts = Pick<
  DayReconciliation,
  | "expected"
  | "verdict"
  | "noVerdict"
  | "notProcessed"
  | "inFlight"
  | "residual"
  | "outcomes"
  | "scanOnly"
  | "outageAffected"
>;

const renderEquation = (label: string, parts: EquationParts): string[] => {
  const residual =
    parts.residual === 0
      ? "residual 0"
      : `RESIDUAL ${String(parts.residual)} (reconciliation defect)`;
  const lines = [
    `${label}: ${String(parts.expected)} = ${String(parts.verdict)} verdict + ${String(
      parts.noVerdict,
    )} no verdict + ${String(parts.notProcessed)} not processed + ${String(
      parts.inFlight,
    )} in flight; ${residual}`,
  ];
  const states = OUTCOME_STATES.filter((state) => parts.outcomes[state] > 0).map(
    (state) => `${state} ${String(parts.outcomes[state])}`,
  );
  if (states.length > 0) {
    lines.push(`  ${states.join(" · ")}`);
  }
  const extras = [
    ...(parts.scanOnly > 0 ? [`seen by a scan but not inventoried ${String(parts.scanOnly)}`] : []),
    ...(parts.outageAffected > 0 ? [`outage-affected ${String(parts.outageAffected)}`] : []),
  ];
  if (extras.length > 0) {
    lines.push(`  ${extras.join(" · ")}`);
  }
  return lines;
};

export const formatReconcileResult = (result: ReconcileCommandResult): string => {
  const lines = [COVERAGE_TEXT[result.inventory.status]];
  if (result.days.length === 0) {
    lines.push("No mail recorded yet.");
    return lines.join("\n");
  }
  for (const day of result.days) {
    lines.push(
      ...renderEquation(`${day.day} (${day.coverage})`, day),
      ...(day.flags.length === 0 ? [] : [`  flags: ${day.flags.join(", ")}`]),
    );
  }
  lines.push(...renderEquation("Total", result.totals));
  return lines.join("\n");
};
