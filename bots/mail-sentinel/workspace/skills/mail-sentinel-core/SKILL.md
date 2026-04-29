# mail-sentinel-core

Checklist:
1. Run the local Mail Sentinel helper `scan` command for polling work
2. Use the local Mail Sentinel helper `list-alerts` command for red-zone today/recent overviews
3. Use the local Mail Sentinel helper `digest` command for amber summaries
4. Use the local Mail Sentinel helper `feedback` command for important / not-important / less-often / remind-later / always-like-this / reduce / digest-only actions
5. Use `policy important-sender --query <text> --announce` for direct sender-importance requests without an alert reply context
6. Use the local Mail Sentinel helper `policy` command for other sender, domain, or receiver-address preference changes
7. The direct sender helper posts its own visible confirmation/error into the alert room; do not assume silent success is acceptable
8. If a helper command fails, reply with a short error summary instead of staying silent
9. Keep the interaction scoped to signal detection, alerts, digests, policy, and feedback
