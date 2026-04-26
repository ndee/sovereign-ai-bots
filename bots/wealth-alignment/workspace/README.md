# Wealth Alignment workspace

Private, local-first financial clarity. This bot is intentionally narrow:

- you drop finance documents into `inbox/`
- the bot parses them into a structured local view
- you ask for overviews, snapshots, and digests in Matrix

The bot does not give financial, tax, legal, or investment advice. It surfaces structure, missing data, and concrete next review steps.

Local state lives in `data/wealth-alignment-state.json`. Parsed document text is stored alongside the document record. Nothing leaves this host.
