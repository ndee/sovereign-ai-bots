# Wealth Alignment workspace

Private, local-first financial clarity. This bot is intentionally narrow:

- you drop finance documents into `inbox/` (`.txt`, `.csv`, `.pdf`, `.png`, `.jpg`)
- the bot parses them into a structured local view
- you ask for overviews, snapshots, and digests in Matrix

The bot does not give financial, tax, legal, or investment advice. It surfaces structure, missing data, and concrete next review steps.

Local state lives in `data/wealth-alignment-state.json`. Parsed document text is stored alongside the document record. Nothing leaves this host by default.

## Host prerequisites

For PDF and image extraction, the bot shells out to standard local tools. Install on the Sovereign Node host:

- `poppler-utils` — provides `pdftotext` and `pdftoppm` (used for PDF text extraction and rasterizing pages for vision)
- `tesseract-ocr` plus a language pack (e.g. `tesseract-ocr-eng`) — used for OCR on PNG/JPG images

If a tool is missing, imports of that file type land in `needs_review` with a clear hint, rather than crashing.

## Optional vision fallback

When local extraction can't pull text out of a noisy scan or unusual PDF, the operator can run `import` or `reparse` with `--use-vision`. That sends rendered page images to an OpenRouter vision model under `zdr: true` and `data_collection: "deny"` (no retention, no training). Vision is opt-in per call. It is disabled by default and only available when:

- `configDefaults.visionEnabled` is `true` in the bot's tool instance config
- `OPENROUTER_API_KEY` is set on the host (resolved from `secretRefs.openrouterApiKey = env:OPENROUTER_API_KEY`)
- `configDefaults.visionModel` names a vision-capable OpenRouter model (default `qwen/qwen2-vl-72b-instruct`)

Vision is only used for text extraction. Categorization, snapshots, and next-step guidance always run on the local heuristic parser.
