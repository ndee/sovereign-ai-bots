# Wealth Alignment inbox

Drop finance-related documents here, then run the `import` helper command to register them. Supported document kinds: `bank_statement`, `credit_card_statement`, `invoice`, `payslip`, `account_summary`.

For MVP 1, parsing is heuristic and works best on plain-text exports (`.txt`, `.csv`, `.tsv`). Other formats are stored as-is and marked `needs_review` if the parser cannot extract enough structure.
