# mail-sentinel-core

Checklist:
1. Run the local Mail Sentinel helper `scan` command for polling work
2. Use the local Mail Sentinel helper `list-alerts` command for red-zone today/recent overviews
3. Use the local Mail Sentinel helper `digest` command for amber summaries
4. Treat feedback as **natural language first**. Users say what they want in their own words; you map it onto one canonical `feedback --action`. Do not require the exact phrasing — the advertised phrases are *hints, not a grammar*.
   - Canonical actions: `important` ("important"), `not-important` ("not important"), `less-often` ("less of this"), `reduce` ("reduce these"), `digest-only` ("digest only"), `always-like-this` ("always alert"), `remind-later` ("remind me later"), `mute` ("hide these").
   - Interpretation flow: free-form text → deterministic Tier-1 normalizer (`normalizeFeedbackPhrase`) → if low-confidence/unknown, classify into the **same** action set above (never invent an action) → confirm the canonical action to the user → apply.
   - `mute` ("hide these" / "I don't want to see this anymore") derives a mute policy so future similar mail is hidden, not just re-zoned (sender or domain scope only — see below).
   - For the policy-deriving actions (`always-like-this` / `reduce` / `digest-only` / `mute`), confirm **both** the interpreted action and the target scope before applying — see "Confirm scope before applying a rule" below.
   - The `feedback` command echoes the interpreted action in plain words ("Interpreted as …"), the resolved scope, and the exact item/rule it applied to; relay that confirmation — never report silent success.
   - Ambiguous targets (`--ref` matches several alerts) or ambiguous intent (an utterance implying more than one action) → ask the user to pick rather than guessing.
5. Use the local Mail Sentinel helper `explain` command (`--alert-id`, `--latest`, or `--ref`) to show why an alert or digest item reached its zone — matched rules and policy modifiers, the semantic reviewer's verdict, and the final zone decision — when an operator asks to verify or debug a classification
6. Use `policy important-sender --query <text> --announce` for direct sender-importance requests without an alert reply context
7. Use the local Mail Sentinel helper `policy` command for other sender/domain preference changes
8. The direct sender helper posts its own visible confirmation/error into the alert room; do not assume silent success is acceptable
9. If a helper command fails, reply with a short error summary instead of staying silent
10. Keep the interaction scoped to signal detection, alerts, digests, policy, and feedback

## Confirm scope before applying a rule

A policy-deriving feedback action (`always-like-this`, `reduce`, `digest-only`,
`mute`) must never silently pick how broadly it applies. Before applying one,
make the scope explicit and let the operator choose:

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
- `mute` only supports `sender` and `domain` scopes (the mute matcher inspects
  the sender/domain, not subject or body); a `subject`/`content` mute is rejected
  rather than written as a rule that could never match.
- The applied result echoes the resolved `scope` and the exact `ruleSummary` —
  relay that back so the operator sees precisely what their feedback affected.

This confirmation surface is shared with the feedback-vocabulary work
(issue #108): the interpreted **action** and the **scope** are confirmed in the
same turn over the one `feedback --action <action> --scope <scope> [--dry-run]`
command.
