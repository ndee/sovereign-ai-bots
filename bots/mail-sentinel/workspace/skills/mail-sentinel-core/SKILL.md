# mail-sentinel-core

Checklist:
1. Run the local Mail Sentinel helper `scan` command for polling work
2. Use the local Mail Sentinel helper `list-alerts` command for red-zone today/recent overviews
3. Use the local Mail Sentinel helper `digest` command for amber summaries
4. Use the local Mail Sentinel helper `feedback` command for important / not-important / less-often / remind-later / always-like-this / reduce / digest-only actions
5. Use the local Mail Sentinel helper `explain` command (`--alert-id`, `--latest`, or `--ref`) to show why an alert or digest item reached its zone — matched rules and policy modifiers, the semantic reviewer's verdict, and the final zone decision — when an operator asks to verify or debug a classification
6. Use `policy important-sender --query <text> --announce` for direct sender-importance requests without an alert reply context
7. Use the local Mail Sentinel helper `policy` command for other sender/domain preference changes
8. The direct sender helper posts its own visible confirmation/error into the alert room; do not assume silent success is acceptable
9. If a helper command fails, reply with a short error summary instead of staying silent
10. Keep the interaction scoped to signal detection, alerts, digests, policy, and feedback
