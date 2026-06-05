# mail-sentinel-core

Checklist:
1. Run the local Mail Sentinel helper `scan` command for polling work
2. Use the local Mail Sentinel helper `list-alerts` command for red-zone today/recent overviews
3. Use the local Mail Sentinel helper `digest` command for amber summaries
4. Use the local Mail Sentinel helper `feedback` command for important / not-important / less-often / remind-later / always-like-this / reduce / digest-only actions. For the policy-deriving actions (always-like-this / reduce / digest-only), confirm the scope before applying — see "Confirm scope before applying a rule" below
5. Use the local Mail Sentinel helper `explain` command (`--alert-id`, `--latest`, or `--ref`) to show why an alert or digest item reached its zone — matched rules and policy modifiers, the semantic reviewer's verdict, and the final zone decision — when an operator asks to verify or debug a classification
6. Use `policy important-sender --query <text> --announce` for direct sender-importance requests without an alert reply context
7. Use the local Mail Sentinel helper `policy` command for other sender/domain preference changes
8. The direct sender helper posts its own visible confirmation/error into the alert room; do not assume silent success is acceptable
9. If a helper command fails, reply with a short error summary instead of staying silent
10. Keep the interaction scoped to signal detection, alerts, digests, policy, and feedback

## Confirm scope before applying a rule

A policy-deriving feedback action (`always-like-this`, `reduce`, `digest-only`)
must never silently pick how broadly it applies. Before applying one, make the
scope explicit and let the operator choose:

- Offer the selectable scopes in plain language:
  `Apply to: this item / this sender / this domain / this subject pattern / this content pattern`
- The CLI takes the choice as `feedback --action <action> --scope <item|sender|domain|subject|content>`.
  When `--scope` is omitted it defaults to `item` (this one alert only — no rule
  is written), so an unscoped reply can never widen a rule by accident.
- Preview the exact rule first with `--dry-run`: `feedback --action reduce --scope domain --latest --dry-run`
  computes and returns the `derivedRule` + `ruleSummary` (e.g.
  `domain example.com -> max-zone amber`) without writing anything. Show that
  summary in the confirmation, then re-run without `--dry-run` once the operator
  agrees.
- `subject`/`content` scopes match on a token. By default `subject` derives the
  token from the alert's subject; pass `--contains <text>` to set the token
  explicitly (required for `content`, optional override for `subject`).
- The applied result echoes the resolved `scope` and the exact `ruleSummary` —
  relay that back so the operator sees precisely what their feedback affected.

This confirmation surface is shared with the feedback-vocabulary work
(issue #108): the interpreted **action** and the **scope** are confirmed in the
same turn over the one `feedback --action <action> --scope <scope> [--dry-run]`
command.
