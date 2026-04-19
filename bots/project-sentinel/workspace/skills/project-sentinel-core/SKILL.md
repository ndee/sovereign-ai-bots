# project-sentinel-core

Checklist:
1. Run the local Project Sentinel helper `scan` command for polling work
2. Use `status` for health, queue, and source posture checks
3. Use `digest` for amber summaries
4. Use `sources list|enable|disable` for source control
5. Use `feedback` for more-like-this / less-like-this / always-alert / digest-only / not-relevant actions
6. Keep the interaction scoped to signal routing, source control, digests, and feedback
7. If a helper command fails, reply with a short error summary instead of staying silent
