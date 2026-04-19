# Project Sentinel workspace

Provisioned by sovereign-node install flow.
Managed by Sovereign Node installer.

- `config/sources.json` is the operator-owned source and project profile file.
- `config/user-policy.json` stores local routing adjustments and source overrides.
- `data/project-sentinel-state.json` stores dedupe, delivery, digest, and feedback state.
- runtime config is resolved per Project Sentinel instance via `project-sentinel.js --instance <id>`.
