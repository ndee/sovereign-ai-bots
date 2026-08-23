# Mail Sentinel workspace

Provisioned by sovereign-node install flow.
Managed by Sovereign Node installer.

- `config/default-rules.json` contains the packaged default local relevance rules and is refreshed from the bot package on install/update.
- `config/user-policy.json` is the operator-managed override layer and is only created when missing.
- runtime config is resolved per Mail Sentinel instance via `mail-sentinel.js --instance <id>`.
- instance-scoped paths such as state, rules, policy, alert room, and timers are provided from the installed tool configuration.
- `data/` is the default local state location when an instance keeps the packaged workspace layout.
- visible Matrix alerts use a compact operator format: the zone/category share one line, the subject is the headline, and sender display is normalized for readability.
- visible AMBER digests no longer number items or show alert IDs; when an operator replies to a digest item, Mail Sentinel resolves the target by subject or sender.

## Semantic review: what leaves the node

The heuristic prefilter, bulk/newsletter detection, and the operator's mute
policies all run locally and BEFORE the semantic reviewer; mail they suppress is
never sent to a model. A candidate that does reach the reviewer is reduced to
the minimum necessary payload:

- `subject`
- `from` — the bare address (never the display name); set the instance config
  `llmSenderDetail` to `domain` to send only the part after the `@` (default:
  `address`).
- `snippet` — at most 300 characters of the body after quoted replies and
  signature blocks are removed and URLs, phone numbers, and IBAN-like account
  numbers are masked (`<url:domain>`, `<phone>`, `<iban>`).
- the heuristic score, category, category scores, and rule reasons (never the
  rule ids, which embed sender addresses), plus two booleans: deadline detected,
  amount present (never the amount itself).

Not sent: thread context (other mails), policy hints (the operator's own rules),
matched rule ids, parsed amounts. The payload is written 0600 into a private
0700 temp directory for the duration of the single `lobster` call and removed
afterwards.

The review runs inside the bot's own OpenClaw session, so the model that
classifies is the agent's configured model (`agentTemplate.model` in the bot
package, `qwen/qwen3.5-27b` by default). The instance config key `llmModel` is
kept for compatibility only and is not sent anywhere. If the gateway's provider
refuses to route a review under the configured privacy/data policy ("No
endpoints found …"), the scan records it as a classification degradation, sends
no further mail to the reviewer in that scan, and never retries with different
routing or privacy parameters.
