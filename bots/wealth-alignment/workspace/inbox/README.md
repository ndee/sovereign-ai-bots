# Wealth Alignment inbox

Drop finance-related documents here, then run the `import` helper command to register them. Supported document kinds: `bank_statement`, `credit_card_statement`, `invoice`, `payslip`, `account_summary`.

Supported file formats:

- Plain text — `.txt`, `.csv`, `.tsv`, `.md`, `.log`
- PDFs — extracted locally with `pdftotext` (poppler-utils)
- Images — `.png`, `.jpg`/`.jpeg`, extracted locally with `tesseract` (tesseract-ocr)

If a local extractor is missing or returns nothing usable, the document is registered with `parse_status: needs_review` and the operator can retry with `--use-vision` to send page images to an OpenRouter vision model under no-retention/no-training routing. That step is opt-in per call and never automatic.
