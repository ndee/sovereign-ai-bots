# wealth-alignment-core

Checklist:
1. Use `document-types` when the user asks what is supported
2. Use `import` after a file is dropped into the inbox; require the file path and a document kind
3. Use `parse` immediately after import; use `reparse` if the user has updated the source file
4. Use `documents`, `show-document` for document inspection
5. Use `accounts`, `transactions` for listings
6. Use `income`, `expenses`, `cashflow`, `net-worth`, `assets`, `liabilities` for overview queries (defaults to current month)
7. Use `summary`, `weekly-review`, `monthly-digest` for digests
8. Use `recurring` and `top-categories` for spending patterns
9. Use `next-step`, `missing-data`, `parsing-issues` when the user asks what to review next
10. Never recommend buying, selling, or investing in anything; only recommend reviewing, organizing, clarifying, verifying, or comparing data
11. If a helper command fails, reply with a short error summary instead of staying silent
