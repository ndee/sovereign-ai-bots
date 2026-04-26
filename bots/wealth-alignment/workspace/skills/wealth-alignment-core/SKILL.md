# wealth-alignment-core

Checklist:
1. Use `document-types` when the user asks what is supported
2. Use `import` after a file is dropped into the inbox; require the file path and a document kind. Inputs may be .txt, .csv, .pdf, .png, or .jpg.
3. Use `parse` immediately after import; use `reparse` if the user has updated the source file
4. Use `documents`, `show-document` for document inspection
5. Use `accounts`, `transactions` for listings
6. Use `income`, `expenses`, `cashflow`, `net-worth`, `assets`, `liabilities` for overview queries (defaults to current month)
7. Use `summary`, `weekly-review`, `monthly-digest` for digests
8. Use `recurring` and `top-categories` for spending patterns
9. Use `next-step`, `missing-data`, `parsing-issues` when the user asks what to review next
10. Never recommend buying, selling, or investing in anything; only recommend reviewing, organizing, clarifying, verifying, or comparing data
11. Only suggest `--use-vision` (on `import` or `reparse`) after a local parse landed in `needs_review`. Tell the operator that the document content will leave the host (under no-retention/no-training policy) before running it.
12. If a helper command fails, reply with a short error summary instead of staying silent
