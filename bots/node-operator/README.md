# Node Operator

The conversational operator surface for a Sovereign AI Node. Design partners
mention it in Matrix (or DM it) to see how their node is doing, understand a
SAN error code, and get guided to the local Node Status page — without a
terminal.

## Commands

| Command | What it does |
| --- | --- |
| `status` | Concise product-level summary: overall state, one line per component, headline, SAN codes |
| `health` | The same view with per-component summaries, codes, and next steps |
| `explain <code>` | Plain-language meaning of a SAN code, practical impact, whether retry is safe, one next step |
| `support` | Navigation to the local Node Status page (diagnostics, support-package creation) |
| `help` | Lists exactly these commands |
| `version` | Immutable build identity of the running bundle (used by the Pro updater's runtime verification) |

## Design

- **Read-only by construction.** The bot's tool template allowlists only its
  own workspace binary. The binary's deterministic router accepts exactly the
  commands above; the one free-text argument (`explain`'s code) is validated
  against `^SAN-[A-Z]{2,12}-\d{3}$` before use and never echoed when invalid.
  The LLM decides *which* command to run — never what arguments reach the
  node CLI.
- **One health model.** `status`/`health` render the product-safe
  presentation model from `sovereign-node diagnostics --json` (built centrally
  in sovereign-ai-node). Output is re-validated against a strict bounded
  schema before rendering, so raw doctor output, paths, credentials, and
  mail metadata cannot reach chat even if the CLI misbehaves.
- **Support stays local.** `support` navigates to the authenticated local web
  interface; the bot never creates or transmits a support package through
  Matrix.

Earlier versions referenced the broad `node-cli-ops` tool template (full
`sovereign-node` CLI access including Matrix user management). That surface is
no longer part of this bot; those workflows live in the local web interface.
