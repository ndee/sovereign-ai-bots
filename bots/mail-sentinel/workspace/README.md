# Mail Sentinel workspace

Provisioned by sovereign-node install flow.
Managed by Sovereign Node installer.

- `config/default-rules.json` is the packaged baseline ruleset and is rewritten by the installer on install/update to keep shipped heuristics aligned with the current bot version.
- operator-specific adjustments belong in `config/user-policy.json` and instance state, which remain separate from the packaged defaults.
- runtime config is resolved per Mail Sentinel instance via `mail-sentinel.js --instance <id>`.
- instance-scoped paths such as state, rules, policy, alert room, and timers are provided from the installed tool configuration.
- `data/` is the default local state location when an instance keeps the packaged workspace layout.
