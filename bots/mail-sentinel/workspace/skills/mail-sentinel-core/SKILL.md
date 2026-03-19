# mail-sentinel-core

Checklist:
1. Run the local Mail Sentinel helper `scan` command for polling work
2. Use the local Mail Sentinel helper `list-alerts` command for red-zone today/recent overviews
3. Use the local Mail Sentinel helper `digest` command for amber summaries
4. Use the local Mail Sentinel helper `feedback` command for important / not-important / less-often / remind-later / always-like-this / reduce actions
5. Use `policy important-sender --query <text>` for direct sender-importance requests without an alert reply context
6. Use the local Mail Sentinel helper `policy` command for other sender/domain preference changes
7. If a helper command fails, reply with a short error summary instead of staying silent
8. Keep the interaction scoped to signal detection, alerts, digests, policy, and feedback
