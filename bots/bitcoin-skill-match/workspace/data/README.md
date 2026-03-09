# Community State

`data/community-state.json` is the bot's local memory for the skill-sharing network.

Top-level sections:
- `skills`
- `regions`
- `members`
- `requests`
- `trustEdges`
- `introductions`

Canonical rules:
- There is no canonical top-level `offers` array
- Offers belong inside `members[].offers[]`
- Requests belong inside the top-level `requests[]`
- Owner ids must be full Matrix user ids such as `@satoshi:example.org`
- Never store OpenClaw session keys such as `agent:bitcoin-skill-match:matrix:direct:@satoshi:example.org`

Guarded write path:
- Policy file: `data/community-state.policy.json`
- Read full state through `sovereign-tool json-state show --instance bitcoin-skill-match-state --json`
- Read collections through `sovereign-tool json-state list --instance bitcoin-skill-match-state --entity <entity> --json`
- Mutate self-owned entries through `upsert-self` and `delete-self`
- Pass whichever of `--session-key` and `--origin-from` the current `session_status` result exposed; in DMs, `--session-key` alone is sufficient
- For upserts, pass all mutation fields through one `--input-json <json-object>` argument
- Never append raw JSON as a trailing positional argument
- Never use shell pipes such as `echo ... | sovereign-tool ...`
- Never use shell substitution such as `$()` or backticks to build `sovereign-tool` commands
- Never use `jq`, `cat`, env vars, temp files, or guessed paths such as `/tmp/.openclaw_session` to recover session data
- Use only the literal values returned by the current `session_status` tool call
- Let the CLI derive the Matrix actor; do not invent it in the prompt
- Do not edit `data/community-state.json` directly

Covered entity types:
- `members`: self-owned profile records keyed as `member:<matrixUserId>`
- `offers`: self-owned child records under `members[].offers[]`
- `requests`: self-owned top-level request records keyed by `requestId`

Ownership rules:
- All humans may read and query all entries
- Only the creator may update or delete a member profile, offer, or request
- Legacy entries without `createdByMatrixUserId` stay readable but must be treated as read-only

Recommended member fields:
- `memberId`
- `createdByMatrixUserId`
- `createdByDisplayName`
- `updatedByMatrixUserId`
- `updatedByDisplayName`
- `createdAt`
- `updatedAt`
- `matrixHandle`
- `displayName`
- `region`
- `offers`
- `seeks`
- `contactLevel`
- `settlementPreferences`
- `trustLinks`
- `notes`

Recommended offer fields:
- `marker`
- `summary`
- `region`
- `contactLevel`
- `settlementPreferences`
- `notes`

Recommended request fields:
- `requestId`
- `marker`
- `requestedBy`
- `createdByMatrixUserId`
- `createdByDisplayName`
- `updatedByMatrixUserId`
- `updatedByDisplayName`
- `createdAt`
- `updatedAt`
- `skill`
- `region`
- `preferredTrustDegree`
- `status`
- `settlementPreferences`
- `notes`
