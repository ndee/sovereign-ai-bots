# Community State

The bot's canonical skill-sharing state is private and managed through `guarded_json_state`.

Top-level sections:
- `skills`: normalized skill tags used across profiles and requests
- `regions`: normalized location labels used for matching
- `members`: one entry per community member; member offers live in `members[].offers[]`
- `requests`: open or fulfilled skill searches
- `trustEdges`: direct trust relationships between members
- `introductions`: consent and status for suggested intros

Canonical rules:
- There is no canonical top-level `offers` array
- Offers belong inside `members[].offers[]`
- Requests belong inside the top-level `requests[]`
- Owner ids must be full Matrix user ids like `@satoshi:example.org`, never OpenClaw session keys like `agent:bitcoin-skill-match:matrix:direct:@satoshi:example.org`

Guarded write path:
- Policy file: `data/community-state.policy.json`
- Read full state through `guarded_json_state` action `show`
- Read collections through `guarded_json_state` action `list`
- Mutate self-owned entries through `guarded_json_state` actions `upsert-self` and `delete-self`
- The tool resolves the current Matrix user id from the active OpenClaw session itself
- For upserts, pass all mutation fields through one tool `input` object
- The guarded state path also normalizes numeric and boolean scalar inputs into strings
- Never append raw JSON outside the tool `input`
- Never use shell commands, pipes, temp files, env vars, or guessed paths to recover session data
- Do not read or edit the backing state file directly
- Do not send owner-managed fields in mutation payloads
- Do not send nested `offers` arrays through `entity members`; use `entity offers`

Covered entity types:
- `members`: self-owned profile records keyed as `member:<matrixUserId>`
- `offers`: self-owned child records under `members[].offers[]`
- `requests`: self-owned top-level request records keyed by `requestId`

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
- `title`
- `description`
- `summary`
- `region`
- `regions`
- `radiusKm`
- `price`
- `visibility`
- `contactLevel`
- `settlementPreferences`
- `notes`

Offer marker behavior:
- Humans may provide a marker explicitly
- If no marker is provided, the guarded CLI generates one automatically

Recommended self-owned member id:
- `member:@satoshi:example.org`

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

Recommended trust edge fields:
- `fromMemberId`
- `toMemberId`
- `relation`
- `strength`
- `updatedAt`

Ownership rules:
- All human users may read and query all entries
- Only the creator of a member profile, offer, or request may update or delete it
- Use `createdByMatrixUserId` as the ownership key for enforcement
- Use the full Matrix user id such as `@satoshi:example.org`, not only `satoshi`
- Legacy entries without `createdByMatrixUserId` stay readable but must be treated as read-only
