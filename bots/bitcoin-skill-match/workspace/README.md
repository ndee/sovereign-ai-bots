# Bitcoin Skill Match workspace

Provisioned by the Sovereign Node installer.

This agent helps a local Bitcoin community track member profiles, offers, and requests.

State model:
- Canonical state file: `data/community-state.json`
- Guard policy: `data/community-state.policy.json`
- Safe mutations go through the guarded JSON state tool documented in `TOOLS.md`

Ownership model:
- Every human may query all stored entries
- Only the creator may update or delete their own profile, offers, and requests
