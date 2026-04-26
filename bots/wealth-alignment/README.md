# Wealth Alignment

Experimental private/local-first financial clarity bot for Sovereign AI Node. Not a current public product focus.

Wealth Alignment ingests finance-related documents, extracts a structured view of accounts, transactions, assets, and liabilities, and answers grounded overview questions and digests over Matrix.

## What it is

- private financial operating system
- local-first
- document- and tracking-first
- Matrix-based command surface
- focused on clarity, structure, and grounded next actions

## What it is not

- not a tax advisor
- not a regulated investment advisor
- not a trading bot
- not a legal advisor
- not a bookkeeping SaaS

## MVP 1 scope

1. document intake from a local inbox directory
2. heuristic parsing / structured extraction
3. transactions, accounts, assets, and liabilities data model
4. monthly financial snapshot
5. net worth overview
6. weekly review and monthly digest
7. simple next-step guidance
8. trivial recurring-expense detection

Anything beyond that — partner workflows, projections, portfolio optimization, external bank APIs, tax calculations — is out of scope for MVP 1.

## Storage

Local JSON state at `data/wealth-alignment-state.json`. Documents land in `inbox/` and parsed text is stored alongside the document record.

## Supported inputs

- Plain text: `.txt`, `.csv`, `.tsv`, `.md`, `.log`
- PDFs: extracted locally via `pdftotext` (requires `poppler-utils`)
- Images: `.png`, `.jpg`/`.jpeg`, extracted locally via `tesseract` (requires `tesseract-ocr` plus a language pack)

If a host tool is missing or returns nothing usable, the import lands in `needs_review` with an actionable hint, and the operator can retry with `--use-vision` to send page images to an OpenRouter vision model under `zdr: true` and `data_collection: "deny"` (no retention, no training). The vision fallback is opt-in per call and disabled by default. See `workspace/README.md` for prerequisites and the privacy note.

## Helper commands

The packaged helper is invoked via the workspace bin script. See `workspace/TOOLS.md` for the full list.
