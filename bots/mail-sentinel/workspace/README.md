# Mail Sentinel workspace

Provisioned by sovereign-node install flow.
Managed by Sovereign Node installer.

- `config/default-rules.json` seeds the default local relevance rules.
- runtime config is resolved per Mail Sentinel instance via `mail-sentinel.mjs --instance <id>`.
- instance-scoped paths such as state, rules, policy, alert room, and timers are provided from the installed tool configuration.
- `data/` is the default local state location when an instance keeps the packaged workspace layout.
