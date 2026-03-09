# Community State

`data/community-state.json` is the bot's local memory for the skill-sharing network.

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

Recommended self-owned member id:
- `member:@satoshi:example.org`

Recommended offer object inside `members[].offers[]`:
- `marker`
- `summary`
- `settlementPreferences`
- `notes`

Recommended request fields:
- `requestId`
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
- `notes`

Recommended trust edge fields:
- `fromMemberId`
- `toMemberId`
- `relation`
- `strength`
- `updatedAt`

Ownership rules:
- All human users may read and query all entries
- Only the creator of a member profile or request may update or delete it
- Use `createdByMatrixUserId` as the ownership key for enforcement
- Use the full Matrix user id such as `@satoshi:example.org`, not only `satoshi`
- For direct Matrix mutations, resolve the owner from `session_status.sessionKey` first and fall back to `session_status.origin.from`
- `session_status` is a zero-argument tool; call it with `{}` and extract the owner from the returned status
- If `session_status.sessionKey` is `agent:bitcoin-skill-match:matrix:direct:@satoshi:example.org`, store only `@satoshi:example.org`
- If neither source exposes a full Matrix user id, refuse the mutation instead of writing placeholders
- For a new offer, create or reuse only the self-owned member `member:<currentActor>`; never store the offer under another user's member, even temporarily or as a draft
- If an older chat turn discussed another user's entry, that does not grant permission to write into that user's record on a later create turn
- Use the exact canonical field names listed above; do not rename them to `owner*`
- Use `notes` as an array of strings
- Always read and write the workspace-relative file `data/community-state.json`
- After every mutation, read the file again and verify the final marker state before confirming success
- If a legacy entry has no `createdByMatrixUserId`, keep it readable but do not modify or delete it automatically
